"""The host user data (deploy/host/bootstrap.sh with install.sh inside, as the cell stack renders it
per launch template) run for real, per host kind, against a fake root, with no privileges: every
absolute path the scripts touch is moved under a scratch directory, the package manager, the AWS
CLI and the downloads are stubs, and `systemctl` is the real one with `--root` (so `enable` and
`mask` behave as on a host: a `mask` of a unit install.sh wrote fails, as systemd 257 does). Checks
that the script finishes, enables exactly its kind's units, and writes the role and config nestd
reads, and that no unit of the other kind is reachable from what is enabled (Wants=/Requires=,
followed transitively). shellcheck runs on both scripts; on CI (`CI=true`) a missing shellcheck is a
failure, not a skip."""

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "deploy" / "host"
SYSTEMCTL = shutil.which("systemctl")

# Absolute prefixes the scripts write under (never /dev, /proc or /sys, which they only read).
PREFIXES = r"(?<![\w.:/$-])/(opt|etc|run|var|usr/lib/nest|root|srv)(?=[/\s\"'.]|$)"

# Units only a sandbox host may run (none reachable on a brain host).
SANDBOX_ONLY = {"nest-proxy.service", "nest-gateway.service"}
DEPENDENCY = re.compile(r"^(Wants|Requires|BindsTo|Requisite|Upholds)=(.*)$", re.M)


def reachable(units_dir: Path, start: set) -> set:
    """Every unit `start` pulls in through Wants=/Requires=/BindsTo=/Requisite=/Upholds=, transitively."""
    seen, todo = set(), list(start)
    while todo:
        unit = todo.pop()
        if unit in seen:
            continue
        seen.add(unit)
        path = units_dir / unit
        if path.is_file():
            for _, deps in DEPENDENCY.findall(path.read_text()):
                todo.extend(deps.split())
    return seen


# What each launch template's user data must enable, and nothing else (the agent runner stays on
# sandbox hosts for this release only: expand/contract, dev/deploy.md).
ENABLED = {
    "burst": {"nest-proxy.service", "nestd.service", "nest-gateway.service", "nest-runner.service"},
    "controller": {"nestd.service", "nest-runner.service"},
}


def render(role: str, fake: Path) -> str:
    """bootstrap.sh as `Cell.bootstrap` renders it (deploy/lean/Cell/Stack.lean), paths moved to `fake`."""
    install = (HOST / "install.sh").read_text().replace("@BUCKET@", "nest-test-1").replace("@REGION@", "us-east-1")
    text = (HOST / "bootstrap.sh").read_text().replace("@BUCKET@", "nest-test-1").replace("@CELL@", "test")
    text = text.replace("@INSTALL@\n", install).replace("@REGION@", "us-east-1").replace("@CONTROL_URL@", "https://cp.test")
    text = text.replace("@ROLE@", role)
    return re.sub(PREFIXES, lambda m: f"{fake}/{m.group(1)}", text)


def stub(bin_dir: Path, name: str, body: str) -> None:
    p = bin_dir / name
    p.write_text("#!/bin/bash\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR)


@unittest.skipUnless(SYSTEMCTL, "needs systemctl (for `systemctl --root`)")
class Bootstrap(unittest.TestCase):
    def run_role(self, role: str, nestd: str = "current"):
        """`nestd`: the installed release's nestd, `current` (knows `sockets.gateway_gid`) or
        `previous` (doesn't: a host launched before the release is published)."""
        fake = Path(tempfile.mkdtemp(prefix="nest-boot-"))
        self.addCleanup(shutil.rmtree, fake, ignore_errors=True)
        bin_dir = fake / "stub-bin"
        bin_dir.mkdir()
        (fake / "etc/systemd/system").mkdir(parents=True)
        (fake / "var/log").mkdir(parents=True)
        (fake / "var/lib/nest").mkdir(parents=True)
        # The release already installed (the AMI's): install.sh's checksum compare skips the copy.
        (fake / "opt/nest/release").mkdir(parents=True)
        (fake / "opt/nest/release.sha256sums").write_text("sums\n")
        (fake / "opt/nest/release/VERSION").write_text("v-test\n")
        (fake / "opt/nest/bin").mkdir(parents=True)
        # install.sh and bootstrap look for the config field's name in the binary.
        (fake / "opt/nest/bin/nestd").write_bytes(b"\x7fELF..gateway_uids.." + (b"gateway_gid.." if nestd == "current" else b""))
        claude_version = re.search(r'CLAUDE_VERSION="([^"]+)"', (HOST / "install.sh").read_text()).group(1)
        (fake / "root/.local/bin").mkdir(parents=True)
        stub(fake / "root/.local/bin", "claude", f'echo "{claude_version} (Claude Code)"\n')
        calls = fake / "systemctl.log"
        stub(bin_dir, "systemctl", f'''echo "$*" >> {calls}
args=()
for a in "$@"; do [ "$a" = --now ] || args+=("$a"); done
case "${{args[0]}}" in daemon-reload) exit 0;; esac
exec {SYSTEMCTL} --root={fake} "${{args[@]}}"
''')
        stub(bin_dir, "aws", 'for a in "$@"; do last="$a"; done; case "$*" in *--recursive*) exit 1;; esac; echo sums > "$last"\n')
        for name in ("rpm", "dnf", "useradd", "sysctl", "sha256sum"):
            stub(bin_dir, name, "exit 0\n")
        # The users exist (the AMI's); nest-gw's ids are whatever useradd picked there.
        stub(bin_dir, "id", 'case "$*" in "-u nest-gw") echo 990;; "-g nest-gw") echo 989;; esac\n')
        stub(bin_dir, "curl", 'echo "curl must not run here: $*" >&2; exit 1\n')
        script = fake / "user-data.sh"
        script.write_text(render(role, fake))
        env = {"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(fake / "root")}
        proc = subprocess.run(["bash", str(script)], capture_output=True, text=True, env=env, timeout=60)
        return fake, proc, calls.read_text() if calls.exists() else ""

    def check(self, role: str, nestd: str = "current"):
        fake, proc, calls = self.run_role(role, nestd)
        self.assertEqual(proc.returncode, 0, f"{role}: {proc.stdout[-2000:]}{proc.stderr[-2000:]}\nsystemctl: {calls}")
        wants = fake / "etc/systemd/system/multi-user.target.wants"
        enabled = {p.name for p in wants.iterdir()} if wants.exists() else set()
        self.assertEqual(enabled, ENABLED[role], f"{role}: enabled units")
        pulled = reachable(fake / "etc/systemd/system", enabled)
        if role == "controller":
            self.assertFalse(pulled & SANDBOX_ONLY, f"a brain host would start {pulled & SANDBOX_ONLY}")
        self.assertNotIn("mask", calls, "a unit install.sh wrote can't be masked")
        cfg = json.loads((fake / "etc/nest/nestd.json").read_text())
        self.assertEqual(cfg["role"], role)
        return cfg, fake

    def test_sandbox_host(self):
        cfg, fake = self.check("burst")
        self.assertIn("driver", cfg)
        self.assertEqual(cfg["storage"]["type"], "s3")
        # The gateway runs as nest-gw, with no capabilities; nestd lets only its uid on
        # gateway.sock and gives its group the sockets, by the ids read back on the host.
        self.assertEqual(cfg["sockets"], {"gateway_gid": 989, "gateway_uids": [990]})
        unit = self.gateway_unit(fake)
        for line in ("User=nest-gw", "Group=nest-gw", "CapabilityBoundingSet=", "NoNewPrivileges=yes", "ProtectSystem=strict",
                     "RestrictAddressFamilies=AF_UNIX AF_INET", "IPAddressDeny=any"):
            self.assertIn(line, unit, unit)
        self.assertNotIn("CAP_DAC_OVERRIDE", "\n".join(unit))
        self.assertIn("ExecStartPre=/bin/sh -c 'for i in $(seq 60); do", "\n".join(unit))

    def test_sandbox_host_on_the_previous_release(self):
        """A nestd that can't give the gateway its sockets: the gateway keeps root's file access
        (and nothing else of root's), and nestd.json names no gateway uid that would lock it out."""
        cfg, fake = self.check("burst", nestd="previous")
        self.assertEqual(cfg["sockets"], {})
        unit = self.gateway_unit(fake)
        self.assertIn("CapabilityBoundingSet=CAP_DAC_OVERRIDE", unit)
        self.assertFalse([line for line in unit if line.startswith(("User=", "Group="))], unit)
        self.assertIn("NoNewPrivileges=yes", unit)

    @staticmethod
    def gateway_unit(fake: Path) -> list:
        return (fake / "etc/systemd/system/nest-gateway.service").read_text().splitlines()

    def test_brain_host(self):
        cfg, fake = self.check("controller")
        # Nothing a sandbox needs (nestd refuses these on a brain host: Config::validate).
        for key in ("driver", "network", "storage", "cloudflared_bin", "gateway_url"):
            self.assertNotIn(key, cfg)
        # nestd never pulls nest-proxy in: a brain host has none.
        unit = (fake / "etc/systemd/system/nestd.service").read_text()
        wants = re.search(r"^Wants=(.*)$", unit, re.M)
        self.assertNotIn("nest-proxy", wants.group(1) if wants else "")

    def test_a_mask_of_an_installed_unit_fails(self):
        """The failure the masks caused (fixed): the fake root reproduces it, so the test would see it."""
        fake, proc, _ = self.run_role("controller")
        self.assertEqual(proc.returncode, 0)
        r = subprocess.run([SYSTEMCTL, f"--root={fake}", "mask", "nest-proxy.service"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)


@unittest.skipUnless(shutil.which("shellcheck") or os.environ.get("CI") == "true", "shellcheck is not installed (required on CI)")
class Shellcheck(unittest.TestCase):
    def test_host_scripts(self):
        self.assertIsNotNone(shutil.which("shellcheck"), "CI must run shellcheck: a skip is not a pass")
        r = subprocess.run(["shellcheck", "-S", "warning", str(HOST / "bootstrap.sh"), str(HOST / "install.sh")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()

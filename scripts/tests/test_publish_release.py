"""scripts/publish-release.sh run for real, offline: `aws` is an S3 stand-in over a local directory
that logs every upload in order, `cargo` and `rustup` drop stub binaries where the build would,
and `curl` serves a small fake Firecracker archive in upstream's layout. The fake archive can't
have the pinned digest, so the cases that get past the digest check run a copy of the script
whose pin line names the fake's digest; nothing in the script itself can change what it checks
against. shellcheck runs on the script; on CI (`CI=true`) a missing shellcheck is a failure."""

import hashlib
import io
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "publish-release.sh"
BUCKET = "nest-test-1"
TARGET = "x86_64-unknown-linux-musl"
BINS = ["nestd", "nest-guest", "nest-proxy", "nest-gateway", "nest-runner", "nest"]
PIN_SHA = re.compile(r'^FIRECRACKER_SHA256="([0-9a-f]{64})"$', re.M)
PIN_VERSION = re.compile(r'^FIRECRACKER_VERSION="(v[0-9]+\.[0-9]+\.[0-9]+)"$', re.M)

FAKE_AWS = r"""#!/bin/bash
# aws s3 cp [flags] <src> <dst>, over $FAKE_S3/<bucket>/<key>; logs each upload's key.
set -eu
[ "$1 $2" = "s3 cp" ] || { echo "fake aws: unexpected: $*" >&2; exit 2; }
src=${*: -2:1} dst=${*: -1}
local_of() { echo "$FAKE_S3/${1#s3://}"; }
case "$src" in
  s3://*) [ -f "$(local_of "$src")" ] || { echo "fake aws: no such key $src" >&2; exit 1; }
          cp "$(local_of "$src")" "$dst" ;;
  *)      case "$dst" in
            s3://*) mkdir -p "$(dirname "$(local_of "$dst")")"
                    cp "$src" "$(local_of "$dst")"
                    echo "${dst#s3://*/releases/current/}" >> "$FAKE_S3_LOG" ;;
            *) exit 2 ;;
          esac ;;
esac
"""

FAKE_CARGO = r"""#!/bin/bash
# cargo build: the stub binaries where the real build puts them; cargo test: passes.
set -eu
[ "$1" = build ] || exit 0
out=target/""" + TARGET + r"""/release
mkdir -p "$out"
for b in """ + " ".join(BINS) + r"""; do printf '#!/bin/sh\necho %s\n' "$b" > "$out/$b"; done
printf '#!/bin/sh\n[ "$1" = --features ] && echo gateway-user\n' > "$out/nestd"
chmod +x "$out"/*
"""

FAKE_CURL = r"""#!/bin/bash
# curl ... -o <file> <url>: logs the URL, then serves $FAKE_ARCHIVE (or fails like a 404).
set -eu
out= url=
while [ $# -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac
done
echo "$url" >> "$FAKE_CURL_LOG"
[ -z "${FAKE_CURL_FAIL:-}" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$FAKE_ARCHIVE" "$out"
"""


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pinned_version() -> str:
    return PIN_VERSION.search(SCRIPT.read_text()).group(1)


def fake_archive(version: str, firecracker: bytes, jailer: bytes) -> bytes:
    """A .tgz in upstream's layout: release-<V>-x86_64/{firecracker,jailer}-<V>-x86_64 and company."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        top = f"release-{version}-x86_64"
        for name, data in [(f"firecracker-{version}-x86_64", firecracker), (f"jailer-{version}-x86_64", jailer),
                           (f"firecracker-{version}-x86_64.debug", b"debug symbols"), ("SHA256SUMS", b"")]:
            info = tarfile.TarInfo(f"{top}/{name}")
            info.size, info.mode = len(data), 0o755
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def stub_bins() -> dict:
    """What FAKE_CARGO writes, by file name (the current release's when nothing changed)."""
    bins = {b: f"#!/bin/sh\necho {b}\n".encode() for b in BINS}
    bins["nestd"] = b'#!/bin/sh\n[ "$1" = --features ] && echo gateway-user\n'
    return bins


class PublishRelease(unittest.TestCase):
    FIRECRACKER = b"\x7fELF firecracker 1.17.0"
    JAILER = b"\x7fELF jailer 1.17.0"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="publish-release-"))
        self.addCleanup(shutil.rmtree, self.tmp)
        self.work, self.bin, self.s3 = self.tmp / "work", self.tmp / "bin", self.tmp / "s3"
        for d in (self.work / "scripts", self.work / "protocol/claude-code", self.bin):
            d.mkdir(parents=True)
        shutil.copy(ROOT / "protocol/claude-code/managed-settings.json", self.work / "protocol/claude-code/")
        for name, body in [("aws", FAKE_AWS), ("cargo", FAKE_CARGO), ("rustup", "#!/bin/sh\nexit 0\n"), ("curl", FAKE_CURL)]:
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.uploads_log, self.curl_log = self.tmp / "uploads", self.tmp / "curl"
        self.archive = self.tmp / "fc.tgz"
        self.archive.write_bytes(fake_archive(pinned_version(), self.FIRECRACKER, self.JAILER))

    def current_release(self, firecracker: bytes, jailer: bytes, listed: dict | None = None, nestd: bytes = b""):
        """The bucket's current release: today's stub binaries (or another `nestd`), the given
        Firecracker, and carried files; SHA256SUMS lists any file in `listed` with those bytes
        instead of what's stored."""
        cur = self.s3 / BUCKET / "releases/current"
        cur.mkdir(parents=True)
        files = {**stub_bins(), "managed-settings.json": (self.work / "protocol/claude-code/managed-settings.json").read_bytes(),
                 "VERSION": b"0ld1234\n", "firecracker": firecracker, "jailer": jailer,
                 "vmlinux": b"kernel", "nest-base.ext4.zst": b"base image"}
        if nestd:
            files["nestd"] = nestd
        for name, data in files.items():
            (cur / name).write_bytes(data)
        listed = {**files, **(listed or {})}
        (cur / "SHA256SUMS").write_text("".join(f"{sha(d)}  {n}\n" for n, d in listed.items()))
        return cur

    def run_script(self, pin_fake: bool = True, curl_fail: bool = False):
        text = SCRIPT.read_text()
        self.assertEqual(len(PIN_SHA.findall(text)), 1, "the script must hold exactly one Firecracker pin")
        if pin_fake:
            text = PIN_SHA.sub(f'FIRECRACKER_SHA256="{sha(self.archive.read_bytes())}"', text)
        (self.work / "scripts/publish-release.sh").write_text(text)
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", "FAKE_S3": str(self.s3),
               "FAKE_S3_LOG": str(self.uploads_log), "FAKE_CURL_LOG": str(self.curl_log),
               "FAKE_ARCHIVE": str(self.archive), "AWS_REGION": "us-east-1"}
        env.pop("FAKE_CURL_FAIL", None)
        if curl_fail:
            env["FAKE_CURL_FAIL"] = "1"
        return subprocess.run(["bash", "scripts/publish-release.sh", BUCKET, "new5678"], cwd=self.work, env=env,
                              capture_output=True, text=True, timeout=60)

    def uploads(self) -> list:
        return self.uploads_log.read_text().split() if self.uploads_log.exists() else []

    def test_downloads_the_pinned_archive_from_upstreams_release(self):
        self.current_release(self.FIRECRACKER, self.JAILER)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        v = pinned_version()
        self.assertEqual(self.curl_log.read_text().split(),
                         [f"https://github.com/firecracker-microvm/firecracker/releases/download/{v}/firecracker-{v}-x86_64.tgz"])

    def test_a_digest_mismatch_fails_and_uploads_nothing(self):
        # The script as committed: the fake archive isn't upstream's, so its digest isn't the pin.
        self.current_release(b"old firecracker", b"old jailer")
        r = self.run_script(pin_fake=False)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.uploads(), [])
        self.assertNotIn("changed=", r.stdout)

    def test_a_failed_download_fails_and_uploads_nothing(self):
        self.current_release(b"old firecracker", b"old jailer")
        r = self.run_script(curl_fail=True)
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.uploads(), [])
        self.assertNotIn("changed=", r.stdout)

    def test_the_current_firecracker_publishes_nothing(self):
        self.current_release(self.FIRECRACKER, self.JAILER)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "changed=false\n")
        self.assertEqual(self.uploads(), [])
        self.assertIn(f"already ships {pinned_version()}", r.stderr)

    def test_a_different_firecracker_publishes_it_with_sha256sums_last(self):
        cur = self.current_release(b"old firecracker", b"old jailer")
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "changed=true\n")
        uploads = self.uploads()
        self.assertIn("firecracker", uploads)
        self.assertIn("jailer", uploads)
        self.assertEqual(uploads[-1], "SHA256SUMS", uploads)
        self.assertEqual(uploads.count("SHA256SUMS"), 1, uploads)
        self.assertNotIn("vmlinux", uploads)
        self.assertIn(f"changes to {pinned_version()}", r.stderr)
        # What a host gets: the archive's binaries, and a SHA256SUMS that vouches for every file in it.
        self.assertEqual((cur / "firecracker").read_bytes(), self.FIRECRACKER)
        self.assertEqual((cur / "jailer").read_bytes(), self.JAILER)
        check = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=cur, capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        listed = sorted(line.split()[1] for line in (cur / "SHA256SUMS").read_text().splitlines())
        self.assertEqual(listed, sorted(BINS + ["managed-settings.json", "VERSION", "firecracker", "jailer", "vmlinux", "nest-base.ext4.zst"]))

    def test_new_host_binaries_alone_publish_without_firecracker(self):
        cur = self.current_release(self.FIRECRACKER, self.JAILER, nestd=b"#!/bin/sh\necho an older nestd\n")
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, "changed=true\n")
        uploads = self.uploads()
        self.assertIn("nestd", uploads)
        self.assertNotIn("firecracker", uploads)
        self.assertNotIn("jailer", uploads)
        self.assertEqual(uploads[-1], "SHA256SUMS", uploads)
        self.assertEqual(uploads.count("SHA256SUMS"), 1, uploads)
        check = subprocess.run(["sha256sum", "-c", "--quiet", "SHA256SUMS"], cwd=cur, capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)

    def test_a_carried_file_the_current_release_doesnt_vouch_for_fails(self):
        for carried in ["vmlinux", "nest-base.ext4.zst"]:
            with self.subTest(carried):
                shutil.rmtree(self.s3, ignore_errors=True)
                self.uploads_log.unlink(missing_ok=True)
                self.current_release(self.FIRECRACKER, self.JAILER, listed={carried: b"another file"})
                r = self.run_script()
                self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(self.uploads(), [])
                self.assertIn(f"{carried} doesn't match", r.stderr)


@unittest.skipUnless(shutil.which("shellcheck") or os.environ.get("CI") == "true", "shellcheck is not installed (required on CI)")
class Shellcheck(unittest.TestCase):
    def test_publish_release(self):
        self.assertIsNotNone(shutil.which("shellcheck"), "CI must run shellcheck: a skip is not a pass")
        r = subprocess.run(["shellcheck", "-S", "warning", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()

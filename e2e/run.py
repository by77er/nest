#!/usr/bin/env python3
"""nest local end-to-end harness. See e2e/README.md.

Runs the real control plane (wrangler dev --local) and the real host components inside an
unprivileged user namespace, as two hosts: a sandbox host (nest-proxy, nest-gateway, nestd with the
`process` driver running nest-guest) and a brain host (a second nestd in brain mode, nest-runner),
then drives a scenario through the admin API and checks the results.

NEST_E2E_CLAUDE=fake (default): brains are crates/nest-cli/tests/fake_claude.py running a scripted scenario; the real
`claude` binary is never invoked. NEST_E2E_CLAUDE=real: brains are the real `claude` with the token
from NEST_CLAUDE_OAUTH_TOKEN, given a short natural-language turn that uses the hands tools.
"""
import glob, json, os, pwd, re, shutil, signal, subprocess, sys, time, urllib.error, urllib.request, uuid

E2E = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(E2E)
WORK = os.environ.get("NEST_E2E_WORK", os.path.join(E2E, ".work"))
BIN = os.path.join(ROOT, "target", "e2e", "release")
# The fake Claude Code the runner's own end-to-end tests use.
FAKE_CLAUDE = os.path.join(ROOT, "crates", "nest-cli", "tests", "fake_claude.py")
PORT = int(os.environ.get("NEST_E2E_PORT", "18787"))
BASE = f"http://127.0.0.1:{PORT}"
GW_PORT = int(os.environ.get("NEST_E2E_GATEWAY_PORT", "18790"))
GW_URL = f"ws://127.0.0.1:{GW_PORT}"
# The gateway runs as its own user, as on a host (nest-gw): this uid inside the namespace, mapped to
# one of the invoking user's subordinate uids. It runs a copy of the binary under WORK, since the
# repo may sit in a home directory other users can't enter.
GW_UID = 1001
GW_BIN = os.path.join(WORK, "bin", "nest-gateway")
# The hands tools the scripted scenario and the real prompt use. Every one of these is a gateway
# connection; the guest's full list is longer, and drift here only undercounts (a weaker check).
HANDS_TOOLS = {"Bash", "Read", "Write", "Edit", "Glob", "Grep", "TaskOutput", "TaskStop"}
ADMIN = "e2e-admin-token"
FENCE_BUDGET_S = float(os.environ.get("NEST_E2E_FENCE_BUDGET_S", "30"))
MODE = os.environ.get("NEST_E2E_CLAUDE", "fake")
REAL = MODE == "real"
# Popped so no subprocess inherits it (nest-guest is the sandbox): the token reaches Claude Code only
# through the control plane's `claude_oauth_token` secret and the runner's explicit env.
# A token has no whitespace; `claude setup-token` wraps it, so a copied line break is dropped.
TOKEN = "".join(os.environ.pop("NEST_CLAUDE_OAUTH_TOKEN", "").split()) if REAL else ""
# What the control plane holds as the Claude token: the real one, or a stand-in the fake brains get
# the same way. Either must never reach the sandbox host's processes.
CLAUDE_TOKEN = TOKEN if REAL else "fake-e2e-oauth-token-not-real"
REAL_MODEL = os.environ.get("NEST_CLAUDE_MODEL", "haiku")
REAL_TURN_TIMEOUT_S = float(os.environ.get("NEST_E2E_REAL_TURN_TIMEOUT_S", "300"))
REAL_ENV = {}  # extra env for inner.sh in real mode (set by prepare_real)

PROCS = {}
RESULTS = []  # (name, ok, detail)


# ---------------------------------------------------------------------------------- helpers
def log(msg):
    print(f"[e2e {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    log(f"{'PASS' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")
    return ok


def skip(name, why):
    RESULTS.append((name, None, why))
    log(f"SKIP {name} — {why}")


def api(method, path, body=None, raw=False, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"authorization": f"Bearer {ADMIN}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode()
            return r.status, (text if raw else (json.loads(text) if text else None))
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, text


def wait_for(fn, timeout, interval=0.25, what=""):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001 - polling
            last = e
        time.sleep(interval)
    raise TimeoutError(f"timed out waiting for {what}: last={last!r}")


def read(path):
    try:
        with open(path, errors="replace") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def inner_pid():
    return PROCS["inner"].pid


def in_userns(cmd, netns=None, timeout=20):
    """Run a command inside the harness user+mount namespace (optionally a sandbox netns)."""
    args = ["nsenter", "-t", str(inner_pid()), "--user", "--mount", "--preserve-credentials"]
    if netns:  # the persisted netns bind mount only exists inside the harness mount namespace
        args += ["nsenter", f"--net={netns}"]
    return subprocess.run(args + cmd, capture_output=True, text=True, timeout=timeout)


def pid_of(name):
    try:
        return int(read(os.path.join(WORK, f"{name}.pid")).strip())
    except ValueError:
        return None


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, TypeError):
        return False
    except PermissionError:
        return True


def proc_state(pid):
    m = re.search(r"^State:\s+(\S)", read(f"/proc/{pid}/status"), re.M)
    return m.group(1) if m else None


def children_named(pattern):
    out = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out if int(p) != os.getpid()]


# ---------------------------------------------------------------------------------- setup
def build():
    log("building release binaries (CARGO_TARGET_DIR=target/e2e)")
    env = dict(os.environ, CARGO_TARGET_DIR=os.path.join(ROOT, "target", "e2e"))
    subprocess.run(["cargo", "build", "--release", "-q", "-p", "nestd", "-p", "nest-proxy", "-p", "nest-guest",
                    "-p", "nest-gateway", "-p", "nest-runner", "-p", "nest-cli"], cwd=ROOT, env=env, check=True)
    if not os.path.exists(os.path.join(ROOT, "control-plane", "node_modules")):
        subprocess.run(["npm", "install", "--silent"], cwd=os.path.join(ROOT, "control-plane"), check=True)


def subid_range(path):
    """This user's first subordinate id range in /etc/subuid or /etc/subgid: (start, count)."""
    me = {str(os.getuid()), pwd.getpwuid(os.getuid()).pw_name}
    try:
        with open(path) as f:
            for line in f:
                parts = line.strip().split(":")
                if len(parts) == 3 and parts[0] in me:
                    return int(parts[1]), int(parts[2])
    except OSError:
        pass
    return None


def ns_range(path):
    """The ids from 1 up that this process's own user namespace maps, as (1, count), when the
    harness already runs as root inside one (a PID-namespace wrapper started with
    `unshare --user --map-root-user --map-users=1:<subuid>:<count> --pid ...`); else None. There
    /etc/subuid's ids don't exist and newuidmap can't be used, but root in the namespace may map
    the ids it has."""
    if os.geteuid() != 0:
        return None
    try:
        rows = [tuple(int(x) for x in line.split()) for line in open(path)]
    except OSError:
        return None
    for inner, _outer, count in rows:
        if inner <= 1 < inner + count and (inner, count) != (0, 4294967295):
            return 1, inner + count - 1
    return None


def id_maps():
    """`unshare` mappings for the gateway's own uid and gid (1..count onto the subordinate ranges,
    or onto the same ids of the user namespace the harness is already root in), beside root (the
    invoking user). Exits with a reason when they can't be made."""
    nested = [ns_range("/proc/self/uid_map"), ns_range("/proc/self/gid_map")]
    if all(r and r[1] >= GW_UID for r in nested):
        (su, sc), (sg, gc) = nested
        return ["--map-users", f"1:{su}:{sc}", "--map-groups", f"1:{sg}:{gc}"], su + GW_UID - 1
    ranges = [subid_range("/etc/subuid"), subid_range("/etc/subgid")]
    if not all(r and r[1] >= GW_UID for r in ranges) or not shutil.which("newuidmap") or not shutil.which("newgidmap"):
        log(f"the gateway runs as its own uid ({GW_UID} in the namespace): this needs newuidmap/newgidmap (package uidmap) "
            f"and a subordinate uid and gid range of at least {GW_UID} for {pwd.getpwuid(os.getuid()).pw_name} in /etc/subuid and /etc/subgid")
        sys.exit(1)
    (su, sc), (sg, gc) = ranges
    return ["--map-users", f"1:{su}:{sc}", "--map-groups", f"1:{sg}:{gc}"], su + GW_UID - 1


def prepare_work():
    id_maps()  # fail before anything starts
    shutil.rmtree(WORK, ignore_errors=True)
    # run/ and state/: the sandbox host's nestd; brun/ and bstate/: the brain host's.
    for d in ["logs", "run", "state", "brun", "bstate", "netns", "runner/cwd", "files", "guest-state", "wrangler-state", "bin"]:
        os.makedirs(os.path.join(WORK, d), exist_ok=True)
    # The gateway's user reaches its socket and the guests' through WORK/run and runs WORK/bin, so
    # WORK, those two and every directory above WORK must let other users through (search only).
    # Everything else is the harness's alone: the logs, and the local control plane's state, which
    # holds the Claude token in real mode.
    os.chmod(WORK, 0o711)
    for d in os.listdir(WORK):
        os.chmod(os.path.join(WORK, d), 0o711 if d in ("run", "bin") else 0o700)
    blocked = [d for d in ancestors(WORK) if not os.stat(d).st_mode & 0o001]
    if blocked:
        log(f"the gateway runs as its own uid and can't enter {blocked[0]}: set NEST_E2E_WORK to a directory "
            "other users can reach, e.g. NEST_E2E_WORK=/var/tmp/nest-e2e-<tag>")
        sys.exit(1)
    shutil.copy(os.path.join(BIN, "nest-gateway"), GW_BIN)
    os.chmod(GW_BIN, 0o755)
    with open(os.open(os.path.join(WORK, "dev.vars"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        # ALLOW_LOOPBACK_MCP / _BROKERED: the mcp capability and the http profile name local servers on 127.0.0.1.
        f.write(f"ADMIN_TOKEN={ADMIN}\nHOST_TOKEN_SECRET=e2e-host-token-secret-0123456789abcdef\nALLOW_DEV_CA=1\nALLOW_LOOPBACK_MCP=1\n"
                "ALLOW_LOOPBACK_BROKERED=1\n")


def ancestors(path):
    """`path` and every directory above it."""
    path = os.path.abspath(path)
    out = [path]
    while os.path.dirname(path) != path:
        path = os.path.dirname(path)
        out.append(path)
    return out


def start_control_plane():
    log(f"starting wrangler dev --local on :{PORT}")
    logf = open(os.path.join(WORK, "logs", "wrangler.log"), "w")
    env = dict(os.environ, WRANGLER_SEND_METRICS="false", CI="1")
    PROCS["wrangler"] = subprocess.Popen(
        ["npx", "wrangler", "dev", "--local", "--port", str(PORT), "--ip", "127.0.0.1",
         "--persist-to", os.path.join(WORK, "wrangler-state"), "--env-file", os.path.join(WORK, "dev.vars"),
         "--var", f"PUBLIC_BASE_URL:{BASE}",
         "--show-interactive-dev-session=false", "--log-level", "info"],
        cwd=os.path.join(ROOT, "control-plane"), stdout=logf, stderr=subprocess.STDOUT, env=env,
        start_new_session=True)
    wait_for(lambda: api("GET", "/v1/health")[0] == 200, 90, 0.5, "control plane health")


def stop_control_plane():
    p = PROCS.get("wrangler")
    if p and p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)


def configure_host():
    # Two hosts, two one-time tokens: the sandbox host's and the brain host's.
    for role, name in (("sandbox", "enroll.token"), ("brain", "enroll-brain.token")):
        st, tok = api("POST", "/v1/admin/enrollment-tokens", {"role": role, "cell": "local"})
        assert st == 200, (st, tok)
        with open(os.open(os.path.join(WORK, name), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            f.write(tok["token"])
    st, ca = api("GET", "/v1/admin/root-ca", raw=True)
    assert st == 200 and "BEGIN CERTIFICATE" in ca, (st, ca)
    with open(os.path.join(WORK, "root-ca.pem"), "w") as f:
        f.write(ca)
    st, r = api("PUT", "/v1/admin/secrets/claude_oauth_token", {"value": CLAUDE_TOKEN})
    assert st == 200, (st, r)
    guest = [os.path.join(BIN, "nest-guest"), "--state-dir", os.path.join(WORK, "guest-state"),
             "--cgroup-root", "none", "--cli-socket", "none", "--run-as", "none", "--port-poll-ms", "500"]
    cfg = {
        # The previous release's role names, as the cell's bootstrap writes them this release
        # (expand/contract; dev/deploy.md): nestd reads both.
        "role": "burst", "cell": "local", "control_url": BASE,
        "enrollment": {"type": "token_file", "path": os.path.join(WORK, "enroll.token")},
        "run_dir": os.path.join(WORK, "run"), "state_dir": os.path.join(WORK, "state"),
        "driver": {"type": "process", "guest_command": guest},
        # The process driver runs the guest with nestd's privileges: development and e2e only, so
        # nestd refuses it unless asked (a cell host runs Firecracker under the jailer).
        "unconfined_driver": True,
        "network": {"type": "netns", "persist_dir": os.path.join(WORK, "netns")},
        "gateway_url": GW_URL,
        # As on a host: only the gateway's uid on gateway.sock, and its group owns that socket and
        # each guest's vsock socket.
        "sockets": {"gateway_gid": GW_UID, "gateway_uids": [GW_UID]},
        "flush_interval_ms": 500,
        # No reflink on the harness's filesystem: checkpoints cut with a copy under a flock (M2), or,
        # with E2E_DISK_CUT=sim_shadow, M3′'s shadow cut over its stand-in. Not byte-checked here
        # (E2E_DISK_CUT_VERIFY=1 does, in the pause: 17 s a cut on these disks, too long for the
        # cut-under-writes check); the restored prefix checks the cut end to end instead.
        "disk_cut": os.environ.get("E2E_DISK_CUT", "locked_copy"),
        "disk_cut_verify": os.environ.get("E2E_DISK_CUT_VERIFY") == "1",
        "versions": {"nest_proxy": "e2e", "agent_runner": "e2e", "claude_code": REAL_ENV.get("version", "real") if REAL else "fake"},
    }
    with open(os.path.join(WORK, "nestd.json"), "w") as f:
        json.dump(cfg, f, indent=2)
    # The brain host: supervisor duties only (no driver, netns, proxy, gateway or tunnel).
    brain = {
        "role": "controller", "cell": "local", "control_url": BASE,
        "enrollment": {"type": "token_file", "path": os.path.join(WORK, "enroll-brain.token")},
        "run_dir": os.path.join(WORK, "brun"), "state_dir": os.path.join(WORK, "bstate"),
        "flush_interval_ms": 500,
        "versions": cfg["versions"],
    }
    with open(os.path.join(WORK, "nestd-brain.json"), "w") as f:
        json.dump(brain, f, indent=2)


def start_inner():
    log("starting the sandbox host (nest-proxy, nestd, nest-gateway) and the brain host (nestd, nest-runner) inside `unshare --user --map-root-user --mount`")
    maps, _ = id_maps()
    env = dict(os.environ, WORK=WORK, BIN=BIN, E2E=E2E, NEST_E2E_GATEWAY_PORT=str(GW_PORT), NEST_E2E_GATEWAY_UID=str(GW_UID),
               NEST_E2E_GATEWAY_BIN=GW_BIN, NEST_E2E_FAKE_CLAUDE=FAKE_CLAUDE)
    if REAL:
        env.update({k: v for k, v in REAL_ENV.items() if k.startswith("NEST_E2E_")})
    logf = open(os.path.join(WORK, "logs", "inner.log"), "w")
    PROCS["inner"] = subprocess.Popen(
        ["unshare", "--user", "--map-root-user", *maps, "--mount", "--propagation", "private", "bash", os.path.join(E2E, "inner.sh")],
        env=env, stdout=logf, stderr=subprocess.STDOUT, start_new_session=True)
    wait_for(lambda: os.path.exists(os.path.join(WORK, "inner.ready")), 30, 0.2, "inner ready")


def stop_inner():
    p = PROCS.get("inner")
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(10)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    # Guests/brains may have been re-parented; sweep anything under WORK.
    for pat in [os.path.join(BIN, "nest-guest"), GW_BIN, FAKE_CLAUDE,
                os.path.join(BIN, "nest") + " mcp"]:
        for pid in children_named(pat):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    if REAL:  # never pgrep for `claude`: that would match the Claude Code running this harness
        for pid in real_brains():
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


# ---------------------------------------------------------------------------------- real-Claude mode
def real_brains():
    """Real Claude Code brains of this run: their argv names a config dir under WORK."""
    marker = f"--mcp-config\0{os.path.join(WORK, 'bstate', 'agents')}/"
    out = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                with open(f"/proc/{d}/cmdline", "rb") as f:
                    if marker in f.read().decode(errors="replace"):
                        out.append(int(d))
            except OSError:
                pass
    return out


def cv_harness():
    """e2e/claude-verify/harness.py: bubblewrap lookup, nest's managed settings, token redaction."""
    d = os.path.join(E2E, "claude-verify")
    if d not in sys.path:
        sys.path.insert(0, d)
    import harness
    return harness


def prepare_real():
    """Managed settings for the inner mount namespace (hooks → the built `nest`; bubblewrap for the
    subprocess env scrub), an empty cwd outside the repo (no CLAUDE.md above it), and the binary."""
    harness = cv_harness()
    claude = os.path.abspath(os.environ.get("NEST_CLAUDE_BIN") or shutil.which("claude") or "")
    v = subprocess.run([claude, "--version"], capture_output=True, text=True, timeout=30,
                       env={"PATH": harness.CHILD_PATH, "HOME": WORK, "CLAUDE_CONFIG_DIR": os.path.join(WORK, "claude-version")})
    bwrap, source = harness.find_bwrap(os.path.join(WORK, "tools", "bubblewrap"))
    settings = harness.managed_settings(lambda c: c.replace("/usr/lib/nest/nest", f"{BIN}/nest"), bwrap=bwrap)
    d = os.path.join(WORK, "claude-code")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "managed-settings.json"), "w") as f:
        json.dump(settings, f, indent=2)
    cwd = os.path.join("/tmp", f"nest-e2e-cwd-{uuid.uuid4().hex[:12]}")
    os.makedirs(cwd)
    REAL_ENV.update(NEST_E2E_CLAUDE_BIN=claude, NEST_E2E_MANAGED_SETTINGS_DIR=d, NEST_E2E_RUNNER_CWD=cwd,
                    version=(v.stdout.split() or ["unknown"])[0])
    log(f"real Claude Code {REAL_ENV['version']} ({claude}), model {REAL_MODEL}; bubblewrap: {bwrap or source}")


def finish_real():
    """Same-length redaction of the token everywhere under WORK (logs, wrangler state), and cleanup."""
    r = cv_harness().Redactor(TOKEN)
    changed = r.scrub_tree(WORK)
    log(f"redacted the OAuth token from {len(changed)} file(s) under {WORK}"
        + (f" (skipped {len(r.skipped)} file(s) over 64 MB: {', '.join(os.path.basename(p) for p in r.skipped)})" if r.skipped else ""))
    if REAL_ENV.get("NEST_E2E_RUNNER_CWD"):
        shutil.rmtree(REAL_ENV["NEST_E2E_RUNNER_CWD"], ignore_errors=True)


REAL_LAUNCH = {  # the seeded worker template's launch (control-plane lib/spec.ts), plus a cheap model
    "model": REAL_MODEL, "builtin_tools": ["TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "WebSearch", "WebFetch"],
    "system_prompt": {"mode": "append", "text": "You work in a remote sandbox through the mcp__nest__* tools; they behave like Claude Code's built-ins."},
}
REAL_CONTENT = "hello from nest e2e\nedited line\n"
FIB_N = 90
FIB_EXPECTED = "2880067194370816120"  # F(90), the oracle; the program in the sandbox computes it iteratively
FIB_PY = "a, b = 0, 1\n" f"for _ in range({FIB_N}):\n" "    a, b = b, a + b\n" "print(a)\n"


def real_prompt(f, fib):
    return ("This is an automated end-to-end test of the hands tools. Use only mcp__nest__ tools and do these steps in order:\n"
            "1. Run `pwd` with mcp__nest__Bash.\n"
            f"2. Create the file {f} with mcp__nest__Write. Its content must be two lines, \"hello from nest e2e\" and \"second line\", each followed by a newline.\n"
            f"3. Read {f} with mcp__nest__Read.\n"
            f"4. With mcp__nest__Edit, replace \"second line\" with \"edited line\" in {f}.\n"
            f"5. Read {f} again with mcp__nest__Read.\n"
            f"6. With mcp__nest__Write, create {fib} containing a Python 3 program that computes the {FIB_N}th Fibonacci number (F(1) = F(2) = 1) and prints only that number.\n"
            f"7. Run it with mcp__nest__Bash as `python3 {fib}`.\n"
            "Then reply with exactly: scenario done")


def nest_tool_uses(text):
    return [n for n in transcript_tool_uses(text) if n.startswith("mcp__nest__")]


def transcript_tool_uses(text):
    """Each tool call once, by its `tool_use` id: Claude Code 2.1.309's transcript also carries
    `api-request-blob` lines that replay earlier assistant content, so counting blocks on every line
    counted each call again (12 for 8 gateway connections)."""
    names, seen = [], set()
    for line in text.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        content = (o.get("message") or {}).get("content") if isinstance(o, dict) else None
        for b in content if isinstance(content, list) else []:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                key = b.get("id") or (len(seen), b.get("name"))
                if key in seen:
                    continue
                seen.add(key)
                names.append(b.get("name", ""))
    return names


def run_real_turn(agid):
    f = os.path.join(WORK, "files", "hello.txt")
    fib = os.path.join(WORK, "files", "fib.py")
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": real_prompt(f, fib)})
    check("turn enqueued", st == 201, json.dumps(t))
    t0 = time.time()

    def finished():
        st, turns = api("GET", f"/v1/agents/{agid}/turns")
        return turns if st == 200 and turns and all(x.get("status") in ("done", "interrupted") for x in turns) else None
    try:
        wait_for(finished, REAL_TURN_TIMEOUT_S, 2.0, "the real Claude Code turn to finish")
        check("real claude: turn finished", True, f"{time.time() - t0:.0f}s")
    except TimeoutError as e:
        check("real claude: turn finished", False, f"{e}"[:300] + f"; runner log: {os.path.join(WORK, 'logs', 'runner.log')}")
    p = in_userns(["cat", f])
    check("real claude: file in the sandbox has the expected content", p.stdout.rstrip("\n") == REAL_CONTENT.rstrip("\n"),
          repr(p.stdout or p.stderr)[:200])
    p = in_userns(["python3", fib])
    check("real claude: the Python program it wrote runs and prints F(90)", p.stdout.strip() == FIB_EXPECTED, repr(p.stdout or p.stderr)[:200])

    def transcript_has_tools():
        st, tr = api("GET", f"/v1/agents/{agid}/transcript", raw=True)
        return tr if st == 200 and nest_tool_uses(tr) else None
    try:
        tr = wait_for(transcript_has_tools, 45, 1.0, "mcp__nest__ tool uses in the transcript")  # an idle agent flushes every 30 s
    except TimeoutError:
        tr = ""
    names = transcript_tool_uses(tr)
    nest_tools = sorted({n for n in names if n.startswith("mcp__nest__")})
    check("real claude: transcript has mcp__nest__ tool uses", nest_tools, f"{len(names)} tool uses: {', '.join(nest_tools) or 'none'}")
    host = sorted({n for n in names if not n.startswith("mcp__")} & {"Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit"})
    check("real claude: no host-side built-in tool uses", not host, ", ".join(host) or "none")
    check_token_not_in("real claude: the OAuth token is not in the sandbox's environment", children_named(os.path.join(BIN, "nest-guest")))
    return sum(1 for n in names if n.startswith("mcp__nest__") and n[len("mcp__nest__"):] in HANDS_TOOLS)


def check_gateway_unprivileged():
    """The gateway runs as its own uid, not the harness's (root in the namespace), with no
    capabilities: what it reaches, it reaches through the sockets nestd gave its group."""
    _, outer = id_maps()
    gateways = children_named(GW_BIN)
    status = read(f"/proc/{gateways[0]}/status") if gateways else ""
    uids = re.search(r"^Uid:\s+(.*)$", status, re.M)
    caps = re.search(r"^CapEff:\s+(\S+)$", status, re.M)
    ok = bool(uids and caps) and set(uids.group(1).split()) == {str(outer)} and int(caps.group(1), 16) == 0
    check("gateway runs as its own uid with no capabilities", ok,
          f"pids={gateways} uids={uids.group(1) if uids else None} want {outer} (harness {os.getuid()}) capeff={caps.group(1) if caps else None}")


def check_token_not_in(name, pids):
    """Passes only when there are processes, every one's environment and command line was read,
    and none holds the Claude token. They are read inside the harness namespace as its root: the
    gateway runs as another uid, whose /proc files the harness can't read from outside. A read
    that fails fails the check; it is never taken as clean."""
    unread, leaked = [], []
    for pid in pids:
        r = in_userns(["cat", f"/proc/{pid}/environ", f"/proc/{pid}/cmdline"])
        if r.returncode != 0 or not r.stdout:
            unread.append((pid, r.stderr.strip()[:120]))
        elif CLAUDE_TOKEN in r.stdout:
            leaked.append(pid)
    check(name, bool(pids) and not unread and not leaked, f"pids={pids} unread={unread} leaked={leaked}")


# ---------------------------------------------------------------------------------- scenario
INJECT_PLACEHOLDER = "nest-ph-httpbin-e2e01"
INJECT_SECRET = "s3cret-e2e-token-7Qz9-longer"  # longer than the placeholder, so the masked length proves substitution
E2E_POLICY = {
    "allow": [{"host": "httpbin.org", "ports": [443]}],
    "inject": [{"name": "httpbin", "hosts": ["httpbin.org"], "placeholder": INJECT_PLACEHOLDER,
                "locations": [{"type": "authorization_bearer"}]}],
}

def scenario(sbx_dir):
    ca = os.path.join(WORK, "root-ca.pem")
    f = os.path.join(WORK, "files", "hello.txt")
    steps = [
        ("pwd", "Bash", {"command": "pwd"}),
        ("set_state", "Bash", {"command": f"export E2E_VAR=persisted && cd {WORK}/files"}),
        ("persist", "Bash", {"command": "echo \"var=$E2E_VAR cwd=$(pwd)\""}),
        ("env", "Bash", {"command": "echo \"agent=$NEST_AGENT_ID proxy=$HTTPS_PROXY\""}),
        ("allowed", "Bash", {"command": f"curl -s -m 20 --cacert {ca} https://registry.npmjs.org/ -o /dev/null -w '%{{http_code}}'"}),
        ("denied", "Bash", {"command": f"curl -s -m 20 --cacert {ca} https://example.com/ -w '\\nhttp=%{{http_code}}'; echo \" rc=$?\""}),
        ("inject", "Bash", {"command": f"curl -s -m 20 --cacert {ca} -H 'Authorization: Bearer {INJECT_PLACEHOLDER}' https://httpbin.org/headers -w '\\nhttp=%{{http_code}}'"}),
        ("direct", "Bash", {"command": "curl --noproxy '*' -sk -m 5 https://1.1.1.1/ -o /dev/null -w '%{http_code}'; echo \" rc=$?\""}),
        ("write", "Write", {"file_path": f, "content": "hello from nest e2e\nsecond line\n"}),
        ("read", "Read", {"file_path": f}),
        ("edit", "Edit", {"file_path": f, "old_string": "second line", "new_string": "edited line"}),
        ("reread", "Read", {"file_path": f}),
        ("pyscript", "Write", {"file_path": os.path.join(WORK, "files", "fib.py"), "content": FIB_PY}),
        ("pyrun", "Bash", {"command": f"python3 {os.path.join(WORK, 'files', 'fib.py')}"}),
        ("platform", "egress_policy", {}),
    ]
    path = os.path.join(WORK, "scenario.json")
    with open(path, "w") as fh:
        json.dump({"results": os.path.join(WORK, "results.jsonl"),
                   "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    return path, len(steps), sum(1 for _, tool, _ in steps if tool in HANDS_TOOLS)


def results_by_label(path=None):
    out = {}
    for line in read(path or os.path.join(WORK, "results.jsonl")).splitlines():
        if line.strip():
            r = json.loads(line)
            out[r["label"]] = r
    return out


def r2_blobs():
    """Every object body in the local R2 bucket (miniflare persists blobs as files)."""
    texts = []
    for root, _, files in os.walk(os.path.join(WORK, "wrangler-state")):
        for name in files:
            p = os.path.join(root, name)
            if "/r2/" in p and not name.endswith((".sqlite", ".sqlite-wal", ".sqlite-shm")):
                texts.append(read(p))
    return texts


def run_scenario():
    st, _ = api("PUT", "/v1/admin/secrets/inject:httpbin", {"value": INJECT_SECRET})
    check("injection secret stored", st in (200, 201, 204), str(st))
    sbx = wait_for(lambda: (lambda r: r[1] if r[0] == 201 else None)(api("POST", "/v1/sandboxes", {"cell": "local", "policy": E2E_POLICY})),
                   60, 1.0, "sandbox placed on a connected host")
    sbxid = sbx.get("sandbox") or sbx.get("id")
    check("sandbox placed", sbx.get("host"), f"{sbxid} on {sbx.get('host')}")
    netns = os.path.join(WORK, "netns", f"ns-{sbxid}")
    wait_for(lambda: os.path.exists(netns), 20, 0.2, "sandbox netns")

    # The brain host must be connected before the agent starts (otherwise its start waits for one).
    wait_for(lambda: any(h["role"] == "brain" and h["connected"] for h in (api("GET", "/v1/admin/fleet?cell=local")[1] or {}).get("hosts", [])),
             30, 0.5, "the brain host connected")
    # The worker may widen its own egress (`egress`, run_brokered): added before it's spawned (specs are copied then).
    st, cat = api("GET", "/v1/admin/catalog")
    worker_tpl = dict((cat or {}).get("templates", {}).get("worker") or {})
    if worker_tpl and "egress" not in worker_tpl.get("capabilities", []):
        worker_tpl["capabilities"] = [*worker_tpl["capabilities"], "egress"]
        st, r = api("PUT", "/v1/admin/templates/worker", worker_tpl)
        check("worker template gains the egress capability", st == 200, json.dumps(r)[:200])
    body = {"template": "worker", "sandbox": sbxid, "cell": "local"}
    if REAL:
        body["launch"] = REAL_LAUNCH
    st, ag = api("POST", "/v1/agents", body)
    check("agent created + started", st == 201, json.dumps(ag)[:300])
    agid = ag.get("agent") or ag.get("id")
    # The brain runs on the brain host, never the sandbox's: two hosts, joined only by the gateway.
    st, fleet = api("GET", "/v1/admin/fleet?cell=local")
    roles = {h["host"]: h["role"] for h in (fleet or {}).get("hosts", [])} if st == 200 else {}
    brain_host = ag.get("host") or (ag.get("started") or {}).get("host")
    check("brain on a brain host, sandbox on a sandbox host",
          roles.get(brain_host) == "brain" and roles.get(sbx.get("host")) == "sandbox" and brain_host != sbx.get("host"),
          f"brain {brain_host} ({roles.get(brain_host)}), sandbox {sbx.get('host')} ({roles.get(sbx.get('host'))})")

    if REAL:
        nhands = run_real_turn(agid)
        skip("scripted hands, egress, platform tool and audit checks", "fake mode only: they need scripted tool calls; real mode checks hands through a natural-language turn")
    else:
        spath, nsteps, nhands = scenario(os.path.join(WORK, "files"))
        st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {spath}"})
        check("turn enqueued", st == 201, json.dumps(t))

        try:
            wait_for(lambda: len(results_by_label()) >= nsteps or None, 120, 0.5, "scenario tool results")
        except TimeoutError as e:
            check("all tool results returned to fake claude", False, f"{len(results_by_label())}/{nsteps}: {e}")
        res = results_by_label()
        text = lambda k: (res.get(k) or {}).get("text") or ""
        check("Bash pwd", res.get("pwd") and not res["pwd"]["is_error"], text("pwd").strip()[:200])
        check("Bash cwd persists across calls", f"cwd={WORK}/files" in text("persist"), text("persist").strip()[:200])
        check("Bash exported vars do NOT persist (matches Claude Code; host-guest spec)", "var=persisted" not in text("persist"), text("persist").strip()[:200])
        check("exec env (NEST_AGENT_ID, HTTPS_PROXY)", agid in text("env") and "172.16.0.1:" in text("env"), text("env").strip()[:200])
        check("allowed host via proxy → 200", text("allowed").strip().endswith("200"), text("allowed").strip()[:200])
        check("denied host → 403 inside the tunnel", "http=403" in text("denied"), text("denied").strip().replace("\n", " | ")[:200])
        check("denied host → readable JSON reason", "egress_denied" in text("denied"), text("denied").strip().replace("\n", " | ")[:300])
        inj = text("inject")
        check("credential injection: upstream saw the real secret (scrubbed on the way back)",
              "http=200" in inj and INJECT_PLACEHOLDER not in inj and INJECT_SECRET not in inj and ("*" * len(INJECT_SECRET)) in inj,
              inj.strip().replace("\n", " | ")[:300])
        check("direct egress blocked (no route)", " rc=0" not in text("direct"), text("direct").strip()[:200])
        check("Write", res.get("write") and not res["write"]["is_error"], text("write").strip()[:200])
        check("Read", "hello from nest e2e" in text("read"), text("read").strip()[:200])
        check("Edit", res.get("edit") and not res["edit"]["is_error"], text("edit").strip()[:200])
        check("Read after Edit", "edited line" in text("reread"), text("reread").strip()[:200])
        check("Write a Python program", res.get("pyscript") and not res["pyscript"]["is_error"], text("pyscript").strip()[:200])
        check("Bash runs it: python3 prints F(90)", text("pyrun").strip() == FIB_EXPECTED, text("pyrun").strip()[:200])
        check("platform tool egress_policy (the effective policy)", res.get("platform") and not res["platform"]["is_error"], text("platform").strip()[:300])

    # Direct connect from inside the sandbox netns (outside the guest's own tools).
    p = in_userns(["bash", "-c", "ip route; timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo CONNECTED || echo BLOCKED"], netns=netns)
    check("netns: no route out (direct TCP to 1.1.1.1:443 blocked)", "BLOCKED" in p.stdout and "CONNECTED" not in p.stdout,
          (p.stdout + p.stderr).strip().replace("\n", " | ")[:300])
    p = in_userns(["bash", "-c", "timeout 5 bash -c 'exec 3<>/dev/tcp/172.16.0.1/443' && echo OPEN || echo CLOSED"], netns=netns)
    check("netns: proxy listener reachable on 172.16.0.1:443", "OPEN" in p.stdout, (p.stdout + p.stderr).strip()[:200])

    # The seam: every hands call went through the gateway, and the gateway refuses what it must.
    bound = len(re.findall(r"\bbound\b.*sandbox=", gateway_log()))
    check("hands calls went through the gateway", bound >= nhands, f"{bound} bound connections for {nhands} hands calls")
    st, target = api("POST", f"/v1/sandboxes/{sbxid}/resolve", {"client": agid})
    ok = check("operator resolve returns a target",
               isinstance(target, dict) and st == 200 and target.get("url") == GW_URL and str(target.get("binding") or "").startswith("nbd_")
               and isinstance((target.get("guest") or {}).get("protocol_version"), int),
               json.dumps({k: v for k, v in target.items() if k != "binding"})[:200] if isinstance(target, dict) else str(target)[:200])
    if ok:
        r = gateway_probe(target["url"], target["binding"], target["guest"]["protocol_version"])
        check("gateway admits a valid binding (bound)", (r.get("message") or {}).get("type") == "bound", json.dumps(r)[:200])
        tampered = tamper_signature(target["binding"])
        r = gateway_probe(target["url"], tampered, target["guest"]["protocol_version"])
        m = r.get("message") or {}
        check("gateway refuses a tampered binding (unauthorized, nothing executed)",
              m.get("type") == "error" and m.get("error", {}).get("code") == "unauthorized" and m.get("executed") is False, json.dumps(r)[:200])
        ids_target = target
    else:
        ids_target = None

    # Session transcript in R2 (via the admin API), agent turns/events.
    def transcript_ok():
        st, tr = api("GET", f"/v1/agents/{agid}/transcript", raw=True)
        if REAL:  # tool uses are checked by run_real_turn; here only that durable bytes reached R2
            return tr if st == 200 and tr.strip() else None
        return tr if st == 200 and "tool_use" in tr and "scenario done" in tr else None
    try:
        tr = wait_for(transcript_ok, 45, 1.0, "transcript segments in R2")  # an idle agent flushes every 30 s
        check("session transcript stored (R2 via read API)", True, f"{len(tr)} bytes")
    except TimeoutError as e:
        check("session transcript stored (R2 via read API)", False, str(e)[:300])
    st, turns = api("GET", f"/v1/agents/{agid}/turns")
    check("turn completed", st == 200 and '"status": "done"' in json.dumps(turns), json.dumps(turns)[:300])
    st, info = api("GET", f"/v1/agents/{agid}")
    check("agent info", st == 200, json.dumps(info)[:300])
    st, asks = api("GET", f"/v1/agents/{agid}/asks")
    check("the agent's open asks are listable (approvals)", st == 200 and isinstance(asks, list), json.dumps(asks)[:300])
    if REAL:
        return {"sandbox": sbxid, "agent": agid, "netns": netns, "target": ids_target}

    # Egress audit records (FleetDO writes them to R2 under audit/…).
    def audit():
        blobs = "\n".join(r2_blobs())
        return blobs if "registry.npmjs.org" in blobs and "example.com" in blobs else None
    try:
        blobs = wait_for(audit, 20, 1.0, "egress audit in R2")
        allowed = re.search(r'\{[^{}]*"registry\.npmjs\.org"[^{}]*\}', blobs)
        denied = re.search(r'\{[^{}]*"example\.com"[^{}]*\}', blobs)
        check("egress audit: allowed + denied records", allowed and denied,
              f"allowed={allowed.group(0)[:160] if allowed else None} denied={denied.group(0)[:160] if denied else None}")
    except TimeoutError as e:
        check("egress audit: allowed + denied records", False, str(e)[:200])

    return {"sandbox": sbxid, "agent": agid, "netns": netns, "target": ids_target}


def gateway_log():
    """The gateway's log without tracing's ANSI colour codes, which sit between a field's name and its value."""
    return re.sub(r"\x1b\[[0-9;]*m", "", read(os.path.join(WORK, "logs", "gateway.log")))


def gateway_probe(url, binding, version, busy_budget_s=30):
    """Open /hands on the gateway as a brain would and return the first reply (see gateway_probe.mjs). A retryable
    `busy` is retried after its `retry_after_ms`, as every client does, within `busy_budget_s`: a turn-end checkpoint
    may hold the VM paused when the probe runs, and the gateway then answers `busy` at once."""
    deadline = time.time() + busy_budget_s
    while True:
        p = subprocess.run(["node", os.path.join(E2E, "gateway_probe.mjs"), url, binding, str(version)], capture_output=True, text=True, timeout=30)
        try:
            r = json.loads(p.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError):
            return {"error": (p.stdout + p.stderr).strip()[:200]}
        m = r.get("message") or {}
        busy = m.get("type") == "error" and (m.get("error") or {}).get("code") == "busy"
        if not busy or time.time() >= deadline:
            return r
        time.sleep(min((m.get("retry_after_ms") or 500) / 1000, 2))


def tamper_signature(binding):
    """Flip one character of the signature segment: the claims stay intact, the signature no longer verifies."""
    if "." not in binding:
        return binding + ".AA"
    head, sig = binding.rsplit(".", 1)
    c = "A" if sig[0] != "A" else "B"
    return f"{head}.{c}{sig[1:]}"


# ---------------------------------------------------------------------------------- remote MCP
# The MCP test server (mcp-test/, its own Worker), run locally like the control plane. A capability
# names it; an agent's fake brain calls its tools through `nest mcp` -> the runner -> AgentDO's MCP
# proxy -> the server, whose call log (`GET /calls`) shows what the proxy sent.
MCP_DIR = os.environ.get("NEST_E2E_MCP_DIR", os.path.join(ROOT, "mcp-test"))
MCP_PORT = int(os.environ.get("NEST_E2E_MCP_PORT", "18788"))
MCP_URL = f"http://127.0.0.1:{MCP_PORT}"
MCP_TOKEN = "e2e-mcp-test-token"
MCP_CAP = "notes"
# Long enough to restart the control plane while the call is out (well under the server's 30 s cap).
MCP_SLOW_MS = 20000


def mcp_api(method, path):
    req = urllib.request.Request(MCP_URL + path, method=method, data=b"" if method == "POST" else None,
                                 headers={"authorization": f"Bearer {MCP_TOKEN}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        text = r.read().decode()
        return json.loads(text) if text else None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get_no_redirect(url, headers=None):
    """GET without following a redirect: (status, Location, body)."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers=headers or {}), timeout=15) as r:
            return r.status, r.headers.get("location"), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("location"), e.read().decode()


def mcp_calls():
    return (mcp_api("GET", "/calls?since=0") or {}).get("calls", [])


def start_mcp_server():
    log(f"starting the MCP test server ({MCP_DIR}) with wrangler dev --local on :{MCP_PORT}")
    if not os.path.exists(os.path.join(MCP_DIR, "node_modules")):
        subprocess.run(["npm", "install", "--silent"], cwd=MCP_DIR, check=True)
    vars_path = os.path.join(WORK, "mcp.vars")
    with open(os.open(vars_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        # OAuth mode on (mcp-test/README.md): the static bearer still opens every route, and run_mcp_oauth
        # authorizes against the server's own authorization server.
        f.write(f"MCP_TEST_TOKEN={MCP_TOKEN}\nMCP_TEST_OAUTH=1\n")
    logf = open(os.path.join(WORK, "logs", "mcp-test.log"), "w")
    PROCS["mcp"] = subprocess.Popen(
        ["npx", "wrangler", "dev", "--local", "--port", str(MCP_PORT), "--ip", "127.0.0.1",
         "--persist-to", os.path.join(WORK, "mcp-state"), "--env-file", vars_path,
         "--show-interactive-dev-session=false", "--log-level", "info"],
        cwd=MCP_DIR, stdout=logf, stderr=subprocess.STDOUT, env=dict(os.environ, WRANGLER_SEND_METRICS="false", CI="1"),
        start_new_session=True)
    wait_for(lambda: (mcp_api("POST", "/reset"), True)[1], 90, 0.5, "the MCP test server")


def stop_mcp_server():
    p = PROCS.get("mcp")
    if p and p.poll() is None:
        os.killpg(p.pid, signal.SIGTERM)
        try:
            p.wait(10)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)


def release_agent(agid, what):
    """Stop a scenario's agent when it's done: a CI runner's brain host holds only 4 brains (2 vCPUs)."""
    st, r = api("POST", f"/v1/agents/{agid}/stop")
    check(f"{what}: agent stopped, freeing its brain slot", st == 200, json.dumps(r)[:200])


def mcp_turn(agid, name, steps, wait_s=90, cap=MCP_CAP):
    """One fake-brain turn of scripted calls to `<cap>_<tool>` (a dict step is passed as is, e.g. an
    `await_tool`); returns the results by label."""
    path = os.path.join(WORK, f"mcp-{name}.json")
    out = os.path.join(WORK, f"mcp-{name}.jsonl")
    with open(path, "w") as fh:
        json.dump({"results": out, "steps": [st if isinstance(st, dict) else {"label": st[0], "tool": f"{cap}_{st[1]}", "args": st[2]}
                                             for st in steps]}, fh, indent=2)
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {path}"})
    check(f"mcp: {name} turn enqueued", st == 201, json.dumps(t)[:200])
    return path, out


def run_mcp(ids):
    if not os.path.isdir(MCP_DIR):
        skip("remote MCP capability", f"no MCP test server at {MCP_DIR} (set NEST_E2E_MCP_DIR to an mcp-test/ checkout)")
        return
    if REAL:
        skip("remote MCP capability", "fake mode only: the calls are scripted")
        return
    start_mcp_server()
    mcp_api("POST", "/reset")
    st, _ = api("PUT", f"/v1/admin/secrets/cap:{MCP_CAP}", {"value": MCP_TOKEN})
    check("mcp: credential stored in BrokerDO", st in (200, 204), str(st))
    # `slow` is read-only (so idempotent by its annotation); the operator overrides it here, so a lost
    # answer to it must never be sent again. The server is untrusted, so its annotations don't make a
    # tool read-only: the operator marks the reads, and note_put and counter_add stay sinks.
    cap = {"mcp": {"url": f"{MCP_URL}/mcp", "auth": f"cap:{MCP_CAP}", "tools": ["echo", "note_put", "note_get", "counter_add", "slow"],
                   "idempotent": {"slow": False}, "read_only": ["echo", "note_get", "slow"]},
           "prompt": "The notes server: echo, notes and counters."}
    st, r = api("PUT", f"/v1/admin/capabilities/{MCP_CAP}", cap)
    check("mcp: capability configured (a loopback URL, local dev only)", st == 200, json.dumps(r)[:200])
    tpl = {"capabilities": ["nest", MCP_CAP], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
           "hands": "forbidden", "credential": "claude_oauth_token", "escalate_to": "user"}
    st, r = api("PUT", "/v1/admin/templates/mcp-worker", tpl)
    check("mcp: template configured", st == 200, json.dumps(r)[:200])
    st, ag = api("POST", "/v1/agents", {"template": "mcp-worker", "cell": "local"})
    check("mcp: agent created", st == 201, json.dumps(ag)[:200])
    agid = ag.get("agent")

    def run_steps(name, steps):
        _, out = mcp_turn(agid, name, steps)
        try:
            wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, 120, 0.5, f"mcp {name} results")
        except TimeoutError as e:
            check(f"mcp: all {name} results returned", False, str(e)[:200])
        res = results_by_label(out)
        return (lambda k: (res.get(k) or {}).get("text") or ""), (lambda k: (res.get(k) or {}).get("is_error"))

    # The listing (untrusted server: descriptions in the model's context) taints the session first, so
    # every sink call is held for the operator: none reaches the server.
    sinks = [("put", "note_put", {"key": "k1", "value": "v1"}), ("add2", "counter_add", {"name": "c", "n": 2}),
             ("add3", "counter_add", {"name": "c", "n": 3})]
    text, err = run_steps("calls", [("echo", "echo", {"text": "hello over mcp"}), ("missing", "note_get", {"key": "nope"}), *sinks])
    check("mcp: echo through mcp__nest__notes_echo", text("echo") == "hello over mcp" and not err("echo"), text("echo")[:200])
    check("mcp: a tool's isError reaches the model as a tool error", err("missing") and "tool_error" in text("missing"), text("missing")[:200])
    asks = {k: (re.search(r"\(pending: (ask_[a-z0-9]+)\)", text(k)) or [None, None])[1] for k, _, _ in sinks}
    check("mcp: a tainted session's sink calls are held for approval", all(asks.values()) and not any(err(k) for k in asks),
          json.dumps({k: text(k)[:120] for k in asks}))
    check("mcp: a held sink call never reaches the server", [c.get("tool") for c in mcp_calls()] == ["echo", "note_get"],
          json.dumps([c.get("tool") for c in mcp_calls()]))
    for k, a in (("put", "approve"), ("add2", "yes"), ("add3", "deny")):
        st, r = api("POST", f"/v1/agents/{agid}/asks/{asks[k]}/answer", {"answer": a})
        check(f"mcp: operator answers {k}'s approval ({a})", st == 200 and r.get("delivered") == "async", json.dumps(r)[:200])

    # Approved calls go through once each, as asked again; the denied one stays held.
    text, err = run_steps("approved", [sinks[0], ("get", "note_get", {"key": "k1"}), *sinks[1:]])
    check("mcp: approved note_put then note_get", not err("put") and "pending" not in text("put") and text("get") == "v1", f"{text('put')!r} {text('get')!r}")
    check("mcp: approved counter_add runs; the denied one doesn't", text("add2") == "2" and "pending" in text("add3"), f"{text('add2')!r} {text('add3')!r}")
    calls = mcp_calls()
    keys = [(c.get("_meta") or {}).get("nest/call") for c in calls]
    metas_ok = all((c.get("_meta") or {}).get("nest/agent") == agid and isinstance((c.get("_meta") or {}).get("nest/epoch"), int)
                   and str((c.get("_meta") or {}).get("nest/call", "")).startswith(f"{agid}/") for c in calls)
    check("mcp: the server saw each sent call once, with nest's _meta",
          [c.get("tool") for c in calls] == ["echo", "note_get", "note_put", "note_get", "counter_add"] and metas_ok and len(set(keys)) == len(keys),
          json.dumps([{k: c.get(k) for k in ("tool", "_meta")} for c in calls])[:400])
    check("mcp: untrusted server: every call says the session is tainted",
          calls and all((c.get("_meta") or {}).get("nest/taint") is True for c in calls), json.dumps([(c.get("_meta") or {}).get("nest/taint") for c in calls]))

    # Redelivery: the control plane restarts while a non-idempotent call is out at the server. The
    # runner resends the unacked call to a new AgentDO incarnation, which finds it forwarded and
    # unanswered: outcome_unknown, never a second request.
    before = len(calls)
    _, out = mcp_turn(agid, "redelivery", [("slow", "slow", {"ms": MCP_SLOW_MS})])
    try:
        wait_for(lambda: any(c.get("tool") == "slow" for c in mcp_calls()[before:]) or None, 60, 0.25, "the slow call at the server")
    except TimeoutError as e:
        check("mcp: slow call reached the server", False, str(e)[:200])
        return
    t0 = time.time()
    stop_control_plane()
    start_control_plane()
    log(f"control plane restarted in {time.time() - t0:.1f}s with the slow call out")
    try:
        wait_for(lambda: results_by_label(out).get("slow"), 90, 0.5, "the redelivered call's result")
    except TimeoutError as e:
        check("mcp: redelivered call answered", False, str(e)[:200])
    r = results_by_label(out).get("slow") or {}
    check("mcp: the redelivered call is outcome_unknown", r.get("is_error") and "outcome_unknown" in (r.get("text") or ""), (r.get("text") or "")[:200])
    time.sleep(2)  # a resend would have left before the answer came back
    slow = [c for c in mcp_calls() if c.get("tool") == "slow"]
    check("mcp: the redelivered call reached the server once", len(slow) == 1,
          json.dumps([(c.get("_meta") or {}).get("nest/call") for c in slow]))
    release_agent(agid, "mcp")
    run_mcp_list_changed(ids)


def run_mcp_list_changed(ids):
    """A server's changed tool list reaches a live brain: the server owes its sessions list_changed
    (sent on a call's SSE stream), AgentDO reports it to the connector, which lists again and tells
    the brain's AgentDO; `tools_changed` reaches the runner, `nest mcp` sends list_changed, and the
    fake brain lists again. Same server and credential as `notes` (one connector), no allowlist."""
    cap = "live"
    st, r = api("PUT", f"/v1/admin/capabilities/{cap}", {"mcp": {"url": f"{MCP_URL}/mcp", "auth": f"cap:{MCP_CAP}", "trusted": True}})
    check("mcp list_changed: capability without an allowlist", st == 200, json.dumps(r)[:200])
    tpl = {"capabilities": ["nest", cap], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
           "hands": "forbidden", "credential": "claude_oauth_token", "escalate_to": "user"}
    st, r = api("PUT", "/v1/admin/templates/mcp-live", tpl)
    st, ag = api("POST", "/v1/agents", {"template": "mcp-live", "cell": "local"})
    check("mcp list_changed: agent created", st == 201, json.dumps(ag)[:200])
    agid = ag.get("agent")

    def turn(name, steps):
        _, out = mcp_turn(agid, name, steps, cap=cap)
        try:
            wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, 120, 0.5, f"mcp {name} results")
        except TimeoutError as e:
            check(f"mcp list_changed: all {name} results returned", False, str(e)[:200])
        return results_by_label(out)

    res = turn("live-before", [("echo", "echo", {"text": "before"}), {"label": "absent", "await_tool": f"{cap}_extra_live", "absent": True, "timeout_s": 1}])
    check("mcp list_changed: the brain starts without the tool", (res.get("absent") or {}).get("text") == "unlisted", json.dumps(res)[:300])
    mcp_api("POST", "/tools?name=extra_live")
    res = turn("live-added", [("poke", "echo", {"text": "carries the notice"}),
                              {"label": "listed", "await_tool": f"{cap}_extra_live", "timeout_s": 30},
                              ("new", "extra_live", {"text": "hi"})])
    check("mcp list_changed: the added tool reaches the brain's tool list without a restart", (res.get("listed") or {}).get("text") == "listed",
          json.dumps(res)[:300])
    check("mcp list_changed: and the brain can call it", (res.get("new") or {}).get("text") == "extra_live: hi", json.dumps(res.get("new"))[:200])
    mcp_api("DELETE", "/tools?name=extra_live")
    res = turn("live-removed", [("poke", "echo", {"text": "again"}),
                                {"label": "gone", "await_tool": f"{cap}_extra_live", "absent": True, "timeout_s": 30}])
    check("mcp list_changed: a removed tool leaves the brain's tool list", (res.get("gone") or {}).get("text") == "unlisted", json.dumps(res)[:300])
    release_agent(agid, "mcp list_changed")


MCP_OAUTH_CAP = "onotes"


def run_mcp_oauth(ids):
    """An oauth capability on the MCP test server's own authorization server (its OAuth mode), run headlessly:
    the operator's start, the harness as the browser (it follows the authorize URL, presenting the server's
    static token as the user's login), nest's callback, then calls that refresh on a 401, a revoked refresh
    token that needs the operator, and a second authorization that recovers."""
    if not os.path.isdir(MCP_DIR) or REAL or "mcp" not in PROCS:
        skip("remote MCP capability over OAuth", "needs the MCP test server, fake mode (as run_mcp)")
        return
    mcp_api("POST", "/reset")
    cap = {"mcp": {"url": f"{MCP_URL}/mcp", "auth": {"oauth": f"cap:{MCP_OAUTH_CAP}"}, "tools": ["echo", "counter_add"],
                   "read_only": ["echo"], "when_tainted": "allow"}, "prompt": "The notes server, over OAuth."}
    st, r = api("PUT", f"/v1/admin/capabilities/{MCP_OAUTH_CAP}", cap)
    check("mcp oauth: capability configured with auth {oauth}", st == 200, json.dumps(r)[:200])

    def authorize(what):
        st, start = api("POST", f"/v1/admin/capabilities/{MCP_OAUTH_CAP}/oauth")
        if not check(f"mcp oauth: {what}: the operator's start answers an authorize URL", st == 200 and "authorize_url" in start, json.dumps(start)[:300]):
            return None
        status, location, body = get_no_redirect(start["authorize_url"], {"authorization": f"Bearer {MCP_TOKEN}"})
        if not check(f"mcp oauth: {what}: the authorization server redirects to nest's callback", status == 302 and (location or "").startswith(f"{BASE}/v1/oauth/callback?"),
                     f"{status} {location} {body[:200]}"):
            return None
        status, _, page = get_no_redirect(location)
        check(f"mcp oauth: {what}: the callback exchanges the code (no admin token)", status == 200 and "is authorized" in page, f"{status} {page[:200]}")
        return start, location

    got = authorize("first")
    if not got:
        return
    start, location = got
    check("mcp oauth: discovery found the server's metadata and chose nest's client ID metadata document",
          start.get("client") == "metadata" and start.get("resource") == f"{MCP_URL}/mcp" and start.get("issuer") == f"{MCP_URL}/oauth",
          json.dumps({k: start.get(k) for k in ("client", "resource", "issuer", "scopes")}))
    log_ = mcp_api("GET", "/oauth/log") or {}
    check("mcp oauth: the server fetched the metadata document and accepted the PKCE exchange",
          log_.get("metadata_fetches", 0) >= 1 and [e.get("outcome") for e in log_.get("token_requests", [])] == ["ok"], json.dumps(log_)[:300])
    status, _, page = get_no_redirect(location)
    check("mcp oauth: the callback's state works once", status == 400 and "state" in page, f"{status} {page[:200]}")
    st, view = api("GET", f"/v1/admin/capabilities/{MCP_OAUTH_CAP}/oauth")
    check("mcp oauth: the operator's view says authorized and names no token",
          st == 200 and view.get("status") == "authorized" and view.get("refreshable") is True and not any("token" in k for k in view if k != "refreshable"),
          json.dumps(view)[:300])

    tpl = {"capabilities": ["nest", MCP_OAUTH_CAP], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
           "hands": "forbidden", "credential": "claude_oauth_token", "escalate_to": "user"}
    api("PUT", "/v1/admin/templates/mcp-oauth-worker", tpl)
    st, ag = api("POST", "/v1/agents", {"template": "mcp-oauth-worker", "cell": "local"})
    check("mcp oauth: agent created", st == 201, json.dumps(ag)[:200])
    agid = ag.get("agent")

    def run_steps(name, steps):
        _, out = mcp_turn(agid, name, steps, cap=MCP_OAUTH_CAP)
        try:
            wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, 120, 0.5, f"mcp oauth {name} results")
        except TimeoutError as e:
            check(f"mcp oauth: all {name} results returned", False, str(e)[:200])
        res = results_by_label(out)
        return (lambda k: (res.get(k) or {}).get("text") or ""), (lambda k: (res.get(k) or {}).get("is_error"))

    text, err = run_steps("oauth-calls", [("echo", "echo", {"text": "hello over oauth"})])
    check("mcp oauth: a call carries the access token", text("echo") == "hello over oauth" and not err("echo"), text("echo")[:200])

    # The server expires every access token: the next call is refused (401), refreshed once and sent again.
    mcp_api("POST", "/oauth/expire")
    text, err = run_steps("oauth-refresh", [("add", "counter_add", {"name": "o", "n": 5})])
    log_ = mcp_api("GET", "/oauth/log") or {}
    refreshes = [e for e in log_.get("token_requests", []) if e.get("grant_type") == "refresh_token"]
    check("mcp oauth: an expired token is refreshed once and the call goes through",
          text("add") == "5" and not err("add") and [e.get("outcome") for e in refreshes] == ["ok"], f"{text('add')!r} {json.dumps(refreshes)}")
    check("mcp oauth: the refused call ran once at the server", [c.get("tool") for c in mcp_calls()] == ["echo", "counter_add"],
          json.dumps([c.get("tool") for c in mcp_calls()]))

    # Every token revoked: the refresh fails, and the agent gets a platform error naming the operator's step.
    mcp_api("POST", "/oauth/expire")
    mcp_api("POST", "/oauth/revoke")
    text, err = run_steps("oauth-revoked", [("r1", "echo", {"text": "x"}), ("r2", "echo", {"text": "y"})])
    check("mcp oauth: a revoked refresh token is a platform error naming re-authorization",
          err("r1") and "unauthorized" in text("r1") and f"/v1/admin/capabilities/{MCP_OAUTH_CAP}/oauth" in text("r1"), text("r1")[:300])
    log_ = mcp_api("GET", "/oauth/log") or {}
    refreshes = [e for e in log_.get("token_requests", []) if e.get("grant_type") == "refresh_token"]
    check("mcp oauth: no refresh loop: the second call didn't ask the authorization server again",
          err("r2") and [e.get("outcome") for e in refreshes] == ["ok", "invalid_grant"], json.dumps(refreshes))
    st, view = api("GET", f"/v1/admin/capabilities/{MCP_OAUTH_CAP}/oauth")
    check("mcp oauth: the operator's view says reauthorize", view.get("status") == "reauthorize", json.dumps(view)[:300])

    if authorize("again"):
        text, err = run_steps("oauth-again", [("echo", "echo", {"text": "back"})])
        check("mcp oauth: after the operator authorizes again, calls work", text("echo") == "back" and not err("echo"), text("echo")[:200])
    blobs = "\n".join(r2_blobs())
    check("mcp oauth: the broker audited the flow in R2", all(e in blobs for e in ("oauth_start", "oauth_authorized", "oauth_refreshed", "oauth_refresh_failed")),
          "missing audit events")
    release_agent(agid, "mcp oauth")


# ---------------------------------------------------------------------------------- sinks: brokered actions, egress
# A local HTTP server stands in for an http profile's API: an agent's fake brain calls `http_request` through
# `nest mcp` -> the runner -> AgentDO's brokered pipeline, which attaches the profile's credential; a tainted
# session's call waits for the operator. The worker (hands, so tainted) widens its own sandbox's egress the
# same way, and nest-proxy applies it live.
BROKERED_SECRET = "-".join(["e2e", "profile", uuid.uuid4().hex[:12]])  # built at run time: no literal for the secret scan


class _ProfileStub:
    def __init__(self):
        import http.server, threading
        stub = self
        self.requests = []

        class H(http.server.BaseHTTPRequestHandler):
            def _answer(self):
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n).decode() if n else ""
                stub.requests.append({"method": self.command, "path": self.path, "auth": self.headers.get("authorization"), "body": body})
                out = json.dumps({"got": self.command, "auth": self.headers.get("authorization"), "n": len(stub.requests)}).encode()
                self.send_response(201 if self.command == "POST" else 200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            do_GET = do_POST = _answer

            def log_message(self, *a):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


def sink_turn(agid, name, steps, wait_s=120):
    path = os.path.join(WORK, f"sink-{name}.json")
    out = os.path.join(WORK, f"sink-{name}.jsonl")
    with open(path, "w") as fh:
        json.dump({"results": out, "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {path}"})
    check(f"sinks: {name} turn enqueued", st == 201, json.dumps(t)[:200])
    try:
        wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, wait_s, 0.5, f"sinks {name} results")
    except TimeoutError as e:
        check(f"sinks: all {name} results returned", False, str(e)[:200])
    res = results_by_label(out)
    return (lambda k: (res.get(k) or {}).get("text") or ""), (lambda k: (res.get(k) or {}).get("is_error"))


def pending_ask(text):
    m = re.search(r"\(pending: (ask_[a-z0-9]+)\)", text)
    return m.group(1) if m else None


def run_rule_approvals(ids):
    """A built-in no tool rule allows (`Agent`: the seed worker's rules allow `mcp__nest__*` and the built-ins it
    launches, and no `subagents` capability allows `Agent`) is held by the
    PreToolUse hook for the operator, through nest hook -> runner -> AgentDO (`approval_check`). Approved, that
    exact call runs once; the same call again is held again."""
    if REAL:
        skip("rule approvals", "fake mode only: the calls are scripted")
        return
    agid = ids["agent"]
    fetch = {"description": "read the docs", "prompt": "what does serde's flatten do?"}
    reordered = {"prompt": "what does serde's flatten do?", "description": "read the docs"}

    def rule_turn(name, steps):
        path = os.path.join(WORK, f"rule-{name}.json")
        out = os.path.join(WORK, f"rule-{name}.jsonl")
        with open(path, "w") as fh:
            json.dump({"results": out, "steps": [{"label": l, "builtin": "Agent", "args": a} for l, a in steps]}, fh, indent=2)
        st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {path}"})
        check(f"rule approvals: {name} turn enqueued", st == 201, json.dumps(t)[:200])
        try:
            wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, 120, 0.5, f"rule approvals {name} results")
        except TimeoutError as e:
            check(f"rule approvals: all {name} results returned", False, str(e)[:200])
        return results_by_label(out)

    def ask_of(r):
        m = re.search(r"\((ask_[a-z0-9]+)\)", (r or {}).get("text") or "")
        return m.group(1) if m else None

    res = rule_turn("held", [("held", fetch), ("again", reordered)])
    ask = ask_of(res.get("held"))
    check("rule approvals: a call no rule allows is denied pending the operator's approval",
          (res.get("held") or {}).get("decision") == "deny" and ask is not None, json.dumps(res.get("held"))[:200])
    check("rule approvals: the same call again (keys reordered) holds the same ask", ask_of(res.get("again")) == ask, json.dumps(res.get("again"))[:200])
    st, asks = api("GET", f"/v1/agents/{agid}/asks")
    mine = [a for a in asks or [] if a.get("ask") == ask]
    check("rule approvals: the ask is listed as an approval of Agent",
          st == 200 and len(mine) == 1 and mine[0].get("approval") == {"name": "Agent", "tool": "Agent"}, json.dumps(asks)[:300])
    if not ask:
        return
    st, r = api("POST", f"/v1/agents/{agid}/asks/{ask}/answer", {"answer": "approve"})
    check("rule approvals: operator approves", st == 200 and r.get("delivered") == "async", json.dumps(r)[:200])
    res = rule_turn("approved", [("approved", fetch), ("spent", fetch)])
    spent = ask_of(res.get("spent"))
    check("rule approvals: the approved call runs once; the same call next is held again",
          (res.get("approved") or {}).get("decision") == "allow" and (res.get("spent") or {}).get("decision") == "deny"
          and spent is not None and spent != ask, json.dumps(res)[:300])
    if spent:
        api("POST", f"/v1/agents/{agid}/asks/{spent}/answer", {"answer": "deny"})


def run_brokered(ids):
    if REAL:
        skip("brokered actions and egress widening", "fake mode only: the calls are scripted")
        return
    stub = _ProfileStub()
    try:
        st, _ = api("PUT", "/v1/admin/secrets/http:e2e", {"value": BROKERED_SECRET})
        check("brokered: profile credential stored in BrokerDO", st in (200, 204), str(st))
        cap = {"brokered": [{"action": "http.request", "profile": "stub", "base_url": f"http://127.0.0.1:{stub.port}/api",
                             "methods": ["GET", "POST"], "paths": ["/items"], "auth": {"secret": "http:e2e"}}],
               "prompt": "The stub API."}
        st, r = api("PUT", "/v1/admin/capabilities/stubapi", cap)
        check("brokered: http profile configured (a loopback URL, local dev only)", st == 200, json.dumps(r)[:200])
        tpl = {"capabilities": ["nest", "stubapi"], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
               "hands": "forbidden", "credential": "claude_oauth_token", "escalate_to": "user"}
        st, r = api("PUT", "/v1/admin/templates/brokered-worker", tpl)
        check("brokered: template configured", st == 200, json.dumps(r)[:200])
        st, ag = api("POST", "/v1/agents", {"template": "brokered-worker", "cell": "local"})
        check("brokered: agent created", st == 201, json.dumps(ag)[:200])
        agid = ag.get("agent")
        post = {"profile": "stub", "method": "POST", "path": "/items", "body": json.dumps({"note": "from e2e"})}
        # Untainted at first: sent. Its answer (an untrusted API's text) taints the session, so the same POST
        # next is held for the operator and never reaches the stub.
        text, err = sink_turn(agid, "brokered", [("first", "http_request", post), ("second", "http_request", post)])
        reqs = list(stub.requests)
        check("brokered: an untainted call goes out with the profile's credential attached",
              not err("first") and len(reqs) >= 1 and reqs[0]["auth"] == f"Bearer {BROKERED_SECRET}" and reqs[0]["path"] == "/api/items",
              json.dumps([{k: v for k, v in q.items() if k != "auth"} for q in reqs])[:200])
        check("brokered: the credential never reaches the model (masked where the API reflects it)",
              BROKERED_SECRET not in text("first") and "*" * len(BROKERED_SECRET) in text("first"), text("first")[:200])
        ask = pending_ask(text("second"))
        check("brokered: the tainted session's sink call is held for approval", ask and len(stub.requests) == 1, text("second")[:200])
        if ask:
            st, r = api("POST", f"/v1/agents/{agid}/asks/{ask}/answer", {"answer": "approve"})
            check("brokered: operator approves", st == 200 and r.get("delivered") == "async", json.dumps(r)[:200])
            text, err = sink_turn(agid, "brokered-approved", [("again", "http_request", post), ("spent", "http_request", post)])
            check("brokered: the approved call goes out once; the next identical one is held again",
                  not err("again") and pending_ask(text("spent")) and len(stub.requests) == 2, f"{text('again')[:100]!r} {text('spent')[:100]!r}")
        st, j = api("GET", f"/v1/agents/{agid}/brokered")
        check("brokered: the journal shows the two sent calls", st == 200 and [e.get("status") for e in j or []] == ["done", "done"],
              json.dumps(j)[:300])
    finally:
        stub.server.shutdown()

    # Egress widening: the worker (hands: tainted) asks for example.com, which its policy denies.
    agid = ids["agent"]
    ca = os.path.join(WORK, "root-ca.pem")
    # The policy reaches nest-proxy a moment after the tool answers (SandboxDO -> FleetDO -> nestd): each curl
    # tries for up to 10 s until the answer is the one expected (`want`: 403 or not).
    def curl(want_denied):
        until = '[ "$c" = 403 ]' if want_denied else '[ "$c" != 403 ] && [ "$c" != 000 ]'
        return {"command": f"for i in $(seq 10); do c=$(curl -s -m 8 --cacert {ca} https://example.com/ -o /dev/null -w '%{{http_code}}'); "
                           f"{until} && break; sleep 0.5; done; echo http=$c"}
    widen = {"allow": [{"host": "example.com", "ports": [443]}], "ttl_s": 600}
    text, err = sink_turn(agid, "egress", [("widen", "egress_policy", widen)])
    ask = pending_ask(text("widen"))
    check("egress: widening from a tainted session is held for approval", ask is not None, text("widen")[:200])
    if not ask:
        return
    st, r = api("POST", f"/v1/agents/{agid}/asks/{ask}/answer", {"answer": "approve"})
    check("egress: operator approves", st == 200 and r.get("delivered") == "async", json.dumps(r)[:200])
    text, err = sink_turn(agid, "egress-approved", [("widen", "egress_policy", widen), ("curl", "Bash", curl(False)),
                                                     ("revoke", "egress_policy", {"revoke": ["example.com"]}), ("curl2", "Bash", curl(True))])
    check("egress: the approved widening applies", not err("widen") and "Allowed example.com" in text("widen"), text("widen")[:200])
    check("egress: nest-proxy lets the sandbox reach the host now", re.search(r"http=[1-5]\d\d", text("curl")) and "http=403" not in text("curl"), text("curl")[:200])
    check("egress: narrowing isn't gated, and the proxy denies the host again", not err("revoke") and "http=403" in text("curl2"),
          f"{text('revoke')[:100]!r} {text('curl2')[:100]!r}")


# ---------------------------------------------------------------------------------- push allowlists
# A sandbox may push only to repos on its allowlist (docs/sandbox/networking/egress/policy/#repo-allowlists):
# SandboxDO's GitHub rule constructor turns the allowlist into generic request guards, and nest-proxy refuses
# a push anywhere else before anything reaches GitHub, whatever credential it carries. No real push: the
# refused ones never leave the proxy, and the allowed one is only git's discovery request, which GitHub
# answers itself (401 without a credential: the harness has no GitHub App, so no token is minted).
E2E_ATTACKER_REPO = "nest-e2e-not-allowed/x"

def run_repos(ids):
    if REAL:
        skip("push allowlists", "fake mode only: the calls are scripted")
        return
    agid, sbx = ids["agent"], ids["sandbox"]
    ca = os.path.join(WORK, "root-ca.pem")
    st, p = api("PUT", f"/v1/sandboxes/{sbx}/policy", {**E2E_POLICY, "repos": ["by77er/nest"]})
    push = next((g for g in (p or {}).get("guards", []) if g.get("name") == "github-push"), {}) if st == 200 else {}
    check("repos: the push allowlist becomes a github-push guard excepting by77er/nest",
          {"path": "/by77er/nest/**"} in push.get("allow", []), json.dumps(push)[:300])
    # The policy reaches nest-proxy a moment after the API answers: each request tries for up to 10 s.
    def until_guarded(url, method="GET"):
        return {"command": f"for i in $(seq 10); do out=$(curl -s -m 15 --cacert {ca} -X {method} '{url}' -w '\nhttp=%{{http_code}}'); "
                           f"echo \"$out\" | grep -q request_denied && break; sleep 0.5; done; echo \"$out\""}
    allowed = (f"curl -s -m 15 --cacert {ca} 'https://github.com/by77er/nest.git/info/refs?service=git-receive-pack' -o {WORK}/allowed.body "
               f"-w 'http=%{{http_code}}'; echo; grep -c request_denied {WORK}/allowed.body || true")
    git = (f"d=$(mktemp -d) && cd $d && git init -q && git -c user.email=e2e@nest.test -c user.name=e2e commit -q --allow-empty -m x && "
           f"GIT_SSL_CAINFO={ca} GIT_TERMINAL_PROMPT=0 git push https://github.com/{E2E_ATTACKER_REPO}.git HEAD:main 2>&1; echo rc=$?")
    text, err = sink_turn(agid, "repos", [
        ("receive", "Bash", until_guarded(f"https://github.com/{E2E_ATTACKER_REPO}.git/git-receive-pack", "POST")),
        ("discovery", "Bash", until_guarded(f"https://github.com/{E2E_ATTACKER_REPO}.git/info/refs?service=git-receive-pack")),
        ("allowed", "Bash", {"command": allowed}),
        ("git", "Bash", {"command": git}),
    ])
    for label in ("receive", "discovery"):
        check(f"repos: nest-proxy refuses a {label} request for a repo not on the allowlist (403, github-push)",
              "http=403" in text(label) and '"guard":"github-push"' in text(label).replace(" ", ""), text(label).replace("\n", " | ")[:300])
    code = re.search(r"http=(\d+)", text("allowed"))
    check("repos: the allowed repo's push discovery passes the guard and reaches GitHub",
          code and code.group(1) not in ("000", "403") and text("allowed").strip().endswith("0"), text("allowed").replace("\n", " | ")[:200])
    check("repos: a real `git push` to a repo not on the allowlist fails at the proxy",
          "403" in text("git") and "rc=0" not in text("git"), text("git").replace("\n", " | ")[:300])
    try:
        wait_for(lambda: any("guard: github-push" in b for b in r2_blobs()) or None, 20, 1.0, "guard refusal in the egress audit")
        check("repos: the refusal is in the egress audit (reason guard: github-push)", True)
    except TimeoutError as e:
        check("repos: the refusal is in the egress audit (reason guard: github-push)", False, str(e)[:200])


# ---------------------------------------------------------------------------------- checkpoints
# docs/sandbox/state/disk/ (M1): a checkpoint pauses the VM only while it reads the disk, and a disk
# nothing wrote since the last commit isn't read again (its mtime still holds nestd's sentinel).

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def commit_reads(sbx, since=0):
    """nestd's `commit: disk read` (a read in place) and `commit: cut read` (a cut read in the background, M2)
    lines for `sbx` after byte `since` of its log: (end offset, fields)."""
    text = ANSI.sub("", read(os.path.join(WORK, "logs", "nestd.log")))
    out = []
    for m in re.finditer(r"commit: (?:disk|cut) read(.*)", text):
        if m.start() < since:
            continue
        fields = dict(re.findall(r"(\w+)=(\S+)", m.group(1)))
        if fields.get("sandbox") == sbx:
            out.append((m.end(), fields))
    return out


def log_size():
    return len(ANSI.sub("", read(os.path.join(WORK, "logs", "nestd.log"))))


def run_checkpoints(ids):
    if REAL:
        skip("checkpoints", "fake mode only: the calls are scripted")
        return
    agid, sbx = ids["agent"], ids["sandbox"]
    disks = glob.glob(os.path.join(WORK, "state", "sandboxes", sbx, "*", "disk.img"))
    if not check("checkpoints: the sandbox's disk image is found", len(disks) == 1, str(disks)):
        return
    # The process driver's guest never writes the image: write 32 MiB into it as a guest would.
    with open(disks[0], "r+b") as f:
        f.seek(1 << 30)
        f.write(os.urandom(32 << 20))
    since = log_size()
    text, err = sink_turn(agid, "ckpt-written", [("a", "Bash", {"command": "echo a"})])
    check("checkpoints: a turn after a disk write runs", text("a").strip() == "a" and not err("a"), text("a")[:200])
    try:
        end, f = wait_for(lambda: next(((e, f) for e, f in commit_reads(sbx, since) if int(f.get("bytes_read", 0)) >= 32 << 20), None),
                          60, 0.5, "a turn-end commit that reads the write")
        check("checkpoints: the commit after a write reads it", f.get("reused") == "false", json.dumps(f)[:300])
    except TimeoutError as e:
        check("checkpoints: the commit after a write reads it", False, str(e)[:200])
        return
    # A turn that writes nothing: its turn-end commit reuses the manifest, reading nothing, and
    # the VM is paused for about no time. A turn right behind it has working hands.
    text, err = sink_turn(agid, "ckpt-unchanged", [("b", "Bash", {"command": "echo b"})])
    check("checkpoints: a turn that writes nothing runs", text("b").strip() == "b" and not err("b"), text("b")[:200])
    try:
        _, f = wait_for(lambda: next(((e, f) for e, f in commit_reads(sbx, end) if f.get("reused") == "true"), None),
                        60, 0.5, "a turn-end commit of the unchanged disk")
        check("checkpoints: an unchanged disk is committed without reading it",
              f.get("bytes_read") == "0" and int(f.get("scan_ms", 99999)) < 1000, json.dumps(f)[:300])
    except TimeoutError as e:
        check("checkpoints: an unchanged disk is committed without reading it", False, str(e)[:200])
    text, err = sink_turn(agid, "ckpt-after", [(f"c{i}", "Bash", {"command": f"echo c{i}"}) for i in range(3)])
    check("checkpoints: hands work right after a turn-end checkpoint",
          all(text(f"c{i}").strip() == f"c{i}" and not err(f"c{i}") for i in range(3)), " | ".join(text(f"c{i}")[:40] for i in range(3)))
    # The harness cuts with a copy (no reflink here), whose pause grows with the data; the unchanged
    # disk's cut copies nothing.
    unchanged = [int(m.group(1)) for m in re.finditer(r"checkpoint: disk cut.*?paused_ms=(\d+) reused=true", ANSI.sub("", read(os.path.join(WORK, "logs", "nestd.log")))[end:])]
    check("checkpoints: the unchanged disk's checkpoint paused its VM under a second", unchanged and max(unchanged) < 1000, str(unchanged))


# docs/sandbox/state/disk/ (M2): a cut taken while the guest keeps writing is a crash-consistent
# image of the instant it was cut. The harness has no reflink, so nestd cuts with a copy under an
# exclusive flock (`disk_cut: locked_copy`) and the writer holds a shared one per write, as a clone
# serializes with each write.

REC = 4096
REC_BASE = 3 << 30


def record(i):
    head = f"nest-e2e-rec:{i:08d}\n".encode()
    return head + b"\xa5" * (REC - len(head))


def records_in(manifest_hex, n):
    """Records 0..n of the region at REC_BASE, read from the generation's chunks in the local store (a restore)."""
    store = os.path.join(WORK, "state", "store", "local")
    m = json.load(open(os.path.join(store, "manifests", manifest_hex)))
    cs = m["chunk_size"]
    out = []
    cache = {}
    for i in range(n):
        off = REC_BASE + i * REC
        idx = off // cs
        if idx not in cache:
            name = m["chunks"][idx]
            cache[idx] = open(os.path.join(store, "chunks", name.split(":", 1)[1]), "rb").read() if name else b""
        data = cache[idx][off - idx * cs: off - idx * cs + REC]
        out.append(data.ljust(REC, b"\0"))
    return out


def run_cut_under_writes(ids):
    if REAL:
        skip("a cut under sustained writes", "fake mode only: the turns are scripted")
        return
    import fcntl
    import threading
    agid, sbx = ids["agent"], ids["sandbox"]
    disks = glob.glob(os.path.join(WORK, "state", "sandboxes", sbx, "*", "disk.img"))
    if not check("cut under writes: the sandbox's disk image is found", len(disks) == 1, str(disks)):
        return
    # About 40 s of writes at most (a turn end's checkpoint may wait out SandboxDO's 10 s interval).
    limit, written, stop = 16384, [0], threading.Event()

    def writer():
        with open(disks[0], "r+b") as f:
            for i in range(limit):
                if stop.is_set():
                    break
                fcntl.flock(f, fcntl.LOCK_SH)
                try:
                    os.pwrite(f.fileno(), record(i), REC_BASE + i * REC)
                finally:
                    fcntl.flock(f, fcntl.LOCK_UN)
                written[0] = i + 1
                time.sleep(0.0025)
    t = threading.Thread(target=writer, daemon=True)
    t.start()
    wait_for(lambda: written[0] >= 100 or None, 10, 0.01, "the writer under way")
    started_ms = int(time.time() * 1000)
    text, err = sink_turn(agid, "cut-writes", [("w", "Bash", {"command": "echo w"})])

    def cut_after_start():
        # The turn end's cut: one taken after the writer was under way (an earlier turn's may still
        # be committing), recorded on its generation as `cut_ms`.
        st, gens = api("GET", f"/v1/sandboxes/{sbx}/generations")
        ends = [g["record"] for g in (gens if st == 200 and isinstance(gens, list) else []) if g["record"]["reason"] == "turn_end" and (g["record"].get("cut_ms") or 0) > started_ms]
        return min(ends, key=lambda r: r["cut_ms"]) if ends else None
    try:
        gen = wait_for(cut_after_start, 60, 0.25, "a generation cut while the writer ran, with cut_ms")
    except TimeoutError as e:
        stop.set()
        check("cut under writes: a turn-end cut taken during the writes commits, with cut_ms", False, str(e)[:200])
        return
    stop.set()
    t.join(10)
    check("cut under writes: a turn-end cut taken during the writes commits, with cut_ms", True, json.dumps({k: gen.get(k) for k in ("id", "cut_ms", "created_ms")}))
    check("cut under writes: the cut precedes its commit", gen["cut_ms"] <= gen["created_ms"], json.dumps(gen)[:300])
    recs = records_in(gen["disk_manifest"].split(":", 1)[1], written[0])
    k = 0
    while k < len(recs) and recs[k] == record(k):
        k += 1
    rest_zero = all(r == b"\0" * REC for r in recs[k:])
    check("cut under writes: the restored disk holds a prefix of the writes and nothing after it (one instant)",
          rest_zero and 100 <= k <= written[0], f"{k} of {written[0]} records, then {'zeros' if rest_zero else 'a later record after a gap'}")
    check("cut under writes: the guest went on writing after the cut", k < written[0], f"{k} at the cut, {written[0]} in all")


# ---------------------------------------------------------------------------------- agent lifetimes
# docs/agents/#lifetimes: a parent agent spawns children that own new sandboxes; one exits itself, the
# parent stops the other; each sandbox is destroyed through SandboxDO's destroy, so FleetDO's GC
# registry drops it; then the operator ends the parent for good.

def lifecycle_turn(agid, name, steps, wait_s=120):
    """One fake-brain turn of `agent_*` calls; returns text(label)."""
    path = os.path.join(WORK, f"life-{name}.json")
    out = os.path.join(WORK, f"life-{name}.jsonl")
    with open(path, "w") as fh:
        json.dump({"results": out, "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {path}"})
    check(f"lifetimes: {name} turn enqueued", st == 201, json.dumps(t)[:200])
    try:
        wait_for(lambda: len(results_by_label(out)) >= len(steps) or None, wait_s, 0.5, f"lifetimes {name} results")
    except TimeoutError as e:
        check(f"lifetimes: all {name} results returned", False, str(e)[:200])
    res = results_by_label(out)
    return lambda k: (res.get(k) or {}).get("text") or ""


def child_scenario(name, steps):
    """A scenario file a spawned child runs as its task (`E2E <path>`); returns (task, results path)."""
    path = os.path.join(WORK, f"life-{name}.json")
    out = os.path.join(WORK, f"life-{name}.jsonl")
    with open(path, "w") as fh:
        json.dump({"results": out, "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    return f"E2E {path}", out


def live_sandboxes():
    st, gc = api("GET", "/v1/admin/gc?cell=local")
    return gc.get("sandboxes") if st == 200 else None


def run_lifecycle(ids):
    if REAL:
        skip("agent lifetimes", "fake mode only: the calls are scripted")
        return
    for path, body in (("capabilities/e2e-spawn", {"tools": ["agent_spawn", "agent_stop"], "spawn": ["e2e-child"]}),
                       ("templates/e2e-child", {"capabilities": ["nest"], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
                                                "hands": "optional", "credential": "claude_oauth_token", "escalate_to": "user"}),
                       ("templates/e2e-parent", {"capabilities": ["nest", "e2e-spawn"], "launch": {"builtin_tools": [], "system_prompt": {"mode": "append", "text": ""}},
                                                 "hands": "forbidden", "credential": "claude_oauth_token", "escalate_to": "user"})):
        st, r = api("PUT", f"/v1/admin/{path}", body)
        check(f"lifetimes: {path} configured", st == 200, json.dumps(r)[:200])
    st, parent = api("POST", "/v1/agents", {"template": "e2e-parent", "cell": "local"})
    check("lifetimes: parent agent created", st == 201, json.dumps(parent)[:200])
    pid = parent.get("agent")
    def spawned(t):
        return (re.search(r"Spawned (agt_[a-z0-9]+)", t) or [None, None])[1], (re.search(r"sandbox (sbx_[a-z0-9]+)", t) or [None, None])[1]
    before = live_sandboxes()

    # 1. A child with a new sandbox runs a hands call, then exits itself, destroying its sandbox.
    task, out1 = child_scenario("child1", [("bash", "Bash", {"command": "echo child-at-work"}), ("exit", "exit", {"destroy_sandbox": True, "reason": "e2e done"})])
    text = lifecycle_turn(pid, "spawn1", [("spawn", "agent_spawn", {"template": "e2e-child", "task": task, "sandbox": "new"})])
    c1, s1 = spawned(text("spawn"))
    check("lifetimes: agent_spawn made a child owning a new sandbox", c1 and s1, text("spawn")[:300])
    if not (c1 and s1):
        return
    st, info = api("GET", f"/v1/agents/{c1}")
    check("lifetimes: the child is the parent's", st == 200 and info.get("owner") == pid and (info.get("hands") or {}).get("sandbox") == s1, json.dumps(info)[:300])
    check("lifetimes: its sandbox is registered (a GC root)", live_sandboxes() == (before or 0) + 1, f"{before} -> {live_sandboxes()}")
    try:
        wait_for(lambda: len(results_by_label(out1)) >= 2 or None, 120, 0.5, "the child's task")
    except TimeoutError as e:
        check("lifetimes: the child ran its task", False, str(e)[:200])
    res = results_by_label(out1)
    check("lifetimes: the child's hands call ran in its sandbox", "child-at-work" in ((res.get("bash") or {}).get("text") or ""), json.dumps(res.get("bash"))[:200])
    check("lifetimes: exit answered", not (res.get("exit") or {}).get("is_error", True), json.dumps(res.get("exit"))[:200])
    try:
        wait_for(lambda: (api("GET", f"/v1/sandboxes/{s1}")[1] or {}).get("state") == "destroyed" or None, 90, 0.5, "the child's sandbox destroyed")
        check("lifetimes: after exit, the child's sandbox is destroyed", True)
    except TimeoutError as e:
        check("lifetimes: after exit, the child's sandbox is destroyed", False, str(e)[:200])
    st, info = api("GET", f"/v1/agents/{c1}")
    check("lifetimes: the child ended (exited, by itself), no brain left", (info.get("ended") or {}).get("reason") == "exited"
          and info["ended"].get("by") == c1 and info.get("brain") is None, json.dumps(info.get("ended"))[:300])
    check("lifetimes: the GC registry dropped its sandbox", live_sandboxes() == before, f"{before} -> {live_sandboxes()}")
    st, r = api("POST", f"/v1/agents/{c1}/turns", {"text": "more"})
    check("lifetimes: an ended agent takes no turn", st == 404, json.dumps(r)[:200])

    # 2. A child the parent stops: its brain is killed and its sandbox destroyed.
    task, out2 = child_scenario("child2", [("bash", "Bash", {"command": "echo second-child"})])
    text = lifecycle_turn(pid, "spawn2", [("spawn", "agent_spawn", {"template": "e2e-child", "task": task, "sandbox": "new"})])
    c2, s2 = spawned(text("spawn"))
    check("lifetimes: a second child", c2 and s2, text("spawn")[:300])
    if not (c2 and s2):
        return
    try:
        wait_for(lambda: results_by_label(out2).get("bash") or None, 120, 0.5, "the second child's task")
    except TimeoutError as e:
        check("lifetimes: the second child ran its task", False, str(e)[:200])
    text = lifecycle_turn(pid, "stop", [("stop", "agent_stop", {"agent": c2, "destroy_sandbox": True, "reason": "e2e"})])
    check("lifetimes: agent_stop answered", c2 in text("stop") and "stopped" in text("stop"), text("stop")[:200])
    try:
        wait_for(lambda: (api("GET", f"/v1/sandboxes/{s2}")[1] or {}).get("state") == "destroyed" or None, 120, 0.5, "the stopped child's sandbox destroyed")
        check("lifetimes: the stopped child's sandbox is destroyed once its brain is gone", True)
    except TimeoutError as e:
        check("lifetimes: the stopped child's sandbox is destroyed once its brain is gone", False, str(e)[:200])
    st, info = api("GET", f"/v1/agents/{c2}")
    check("lifetimes: the stopped child ended (stopped, by the parent)", (info.get("ended") or {}).get("by") == pid and info.get("brain") is None,
          json.dumps({k: info.get(k) for k in ("ended", "brain")})[:300])
    check("lifetimes: the GC registry dropped the second sandbox", live_sandboxes() == before, f"{before} -> {live_sandboxes()}")
    st, kids = api("GET", f"/v1/agents/{pid}/children")
    check("lifetimes: the parent's index has both, ended", st == 200 and sorted(k["agent"] for k in kids) == sorted([c1, c2]) and all(k["ended"] for k in kids),
          json.dumps(kids)[:300])

    # 3. The operator ends the parent for good (freeing its brain slot).
    st, r = api("POST", f"/v1/agents/{pid}/stop", {"end": True})
    check("lifetimes: the operator ends the parent", st == 200 and r.get("status") == "stopped", json.dumps(r)[:200])
    try:
        wait_for(lambda: (api("GET", f"/v1/agents/{pid}")[1] or {}).get("brain") is None or None, 90, 0.5, "the parent's brain gone")
        check("lifetimes: the parent's brain is gone", True)
    except TimeoutError as e:
        check("lifetimes: the parent's brain is gone", False, str(e)[:200])


def run_retention(ids):
    """Generation retention, `on` in this harness: the sandbox's real commits (turn ends from nestd) are listed
    with their state and why each is kept, its head is a ready restore source, no turn end was dropped (there are
    fewer than 20), and no placement found its head refused."""
    sbx = ids["sandbox"]
    st, info = api("GET", f"/v1/sandboxes/{sbx}")
    head = (info or {}).get("head") if st == 200 else None
    st, gens = api("GET", f"/v1/sandboxes/{sbx}/generations")
    ok = check("retention: generations listed with their state and keep reason",
               st == 200 and isinstance(gens, list) and len(gens) > 0
               and all(g.get("state") in ("ready", "deleting") and "retained" in g for g in gens), json.dumps(gens)[:300])
    if not ok:
        return
    by = {g["record"]["id"]: g for g in gens}
    check("retention: the head is a ready restore source", head in by and by[head]["state"] == "ready" and by[head]["retained"] == "restore_source",
          json.dumps({"head": head, "row": by.get(head)})[:300])
    ends = [g for g in gens if g["record"]["reason"] == "turn_end"]
    check("retention: every turn end is kept", ends and all(g["state"] == "ready" and g["retained"] for g in ends),
          f"{len(ends)} turn ends: {[(g['state'], g['retained']) for g in ends]}"[:300])
    check("retention: no placement refused its head", "is not a restore source" not in read(os.path.join(WORK, "logs", "wrangler.log")))


def checkpoint_turn(agid, name, steps):
    """Enqueue one scripted fake-brain turn; returns its results path (read with results_by_label)."""
    path = os.path.join(WORK, f"ckpt-{name}.json")
    out = os.path.join(WORK, f"ckpt-{name}.jsonl")
    with open(path, "w") as fh:
        json.dump({"results": out, "steps": steps}, fh, indent=2)
    st, t = api("POST", f"/v1/agents/{agid}/turns", {"text": f"E2E {path}"})
    check(f"checkpoint pause: turn {name} enqueued", st == 201, json.dumps(t)[:200])
    return out


def write_disk(path, mib):
    """Fill the first `mib` MiB of the sandbox's (sparse) disk image with data no chunk store has seen,
    so the next commit's chunking pass, which holds the VM paused, stores new chunks and takes a while."""
    salt = uuid.uuid4().bytes
    with open(path, "r+b") as f:
        for i in range(mib // 4):
            pattern = salt + i.to_bytes(8, "little")
            f.write((pattern * ((4 << 20) // len(pattern) + 1))[: 4 << 20])
        f.flush()
        os.fsync(f.fileno())


def run_checkpoint_pause(ids):
    """2026-11-02, cell use1: hands calls failed at once ("hands unavailable: bind timed out") while a turn-end
    checkpoint held the VM paused for its chunking pass. Here a turn-end checkpoint's pause is held (the sandbox
    host's nestd is stopped with SIGSTOP while it reads the disk, the only part of a commit the VM is paused for since
    M1: docs/sandbox/state/disk/) while the next turn makes a hands call:
    the gateway answers `busy` at once (nestd marked the sandbox paused), the runner waits it out, and the call
    runs once the VM does."""
    if REAL:
        skip("hands during a checkpoint's pause", "fake mode only: the turns are scripted around the pause")
        return
    sbx, agid = ids["sandbox"], ids["agent"]
    # The incarnation's directory, `<state_dir>/sandboxes/<sandbox>/<epoch>/` (the newest epoch).
    base = os.path.join(WORK, "state", "sandboxes", sbx)
    epochs = sorted((d for d in os.listdir(base) if d.isdigit()), key=int) if os.path.isdir(base) else []
    disks = [p for p in (os.path.join(base, e, "disk.img") for e in epochs) if os.path.exists(p)]
    if not check("checkpoint pause: the sandbox's disk image is on the host", disks, str(disks)):
        return
    disk = disks[-1]

    def generations():
        st, g = api("GET", f"/v1/sandboxes/{sbx}/generations")
        return len(g) if st == 200 and isinstance(g, list) else None

    # A first turn's checkpoint lands; the next turn ends within 10 s of that landing (SandboxDO's
    # TURN_CHECKPOINT_MIN_MS), so its checkpoint is deferred until the interval is up, by which time the turn
    # after it is running and blocked on the cue. 1 GiB of fresh data first, so the first pass stores it.
    write_disk(disk, 1024)
    before = generations() or 0
    out = checkpoint_turn(agid, "p", [{"label": "p", "tool": "Bash", "args": {"command": "echo p"}}])
    try:
        wait_for(lambda: results_by_label(out).get("p") or None, 60, 0.25, "turn p's result")
        wait_for(lambda: (generations() or 0) > before or None, 60, 0.25, "turn p's checkpoint landed")
    except TimeoutError as e:
        check("checkpoint pause: a first turn-end checkpoint lands", False, str(e)[:200])
        return
    cue = os.path.join(WORK, "ckpt-cue")
    paused_marker = "sandbox paused: binds get busy"
    paused_before = gateway_log().count(paused_marker)
    out_a = checkpoint_turn(agid, "a", [{"label": "a", "tool": "Bash", "args": {"command": "echo a"}}])
    out_b = checkpoint_turn(agid, "b", [{"label": "cue", "await_file": cue, "timeout_s": 90},
                                         {"label": "during", "tool": "Bash", "args": {"command": "echo during-checkpoint"}}])
    try:
        wait_for(lambda: os.path.exists(cue + ".waiting") or None, 30, 0.05, "turn b blocked on the cue")
    except TimeoutError as e:
        check("checkpoint pause: the next turn is waiting before the checkpoint", False, str(e)[:200])
        open(cue, "w").close()
        return
    if not check("checkpoint pause: the next turn is waiting before the checkpoint", gateway_log().count(paused_marker) == paused_before,
                 "no pause before it (a pause here means turn a's checkpoint wasn't deferred: turn p landed over 10 s before turn a ended)"):
        open(cue, "w").close()
        return
    # 1 GiB more no store has seen, so the deferred checkpoint's read (the pause) takes long enough to catch.
    write_disk(disk, 1024)
    try:
        # Outlasts the 10 s interval from turn p's landing, the deferred checkpoint's deadline.
        wait_for(lambda: gateway_log().count(paused_marker) > paused_before or None, 30, 0.02, "the deferred turn-end checkpoint pauses the VM")
    except TimeoutError as e:
        check("checkpoint pause: a turn-end checkpoint pauses the VM and nestd tells the gateway", False, str(e)[:200])
        open(cue, "w").close()
        return
    # Hold the pause: stop nestd mid-read (the VM stays paused, the gateway keeps its mark). The VM must not
    # have run again before the stop landed.
    nestd = pid_of("nestd")
    os.kill(nestd, signal.SIGSTOP)
    held_at = time.time()
    try:
        caught = "sandbox running again" not in gateway_log().split(paused_marker)[-1]
        if not check("checkpoint pause: nestd stopped while the checkpoint's read still held the VM paused", caught,
                     "" if caught else "the read ended before the stop: the VM ran again first"):
            return
        open(cue, "w").close()

        def refused_busy():
            gl = gateway_log()
            i = -1
            for _ in range(paused_before + 1):
                i = gl.find(paused_marker, i + 1)
            return re.search(r"bind refused.*busy", gl[i:]) if i >= 0 else None
        try:
            # The hold stays well under the sandbox host's 20 s lease (self-fence): at most 5 s here and 3 s below.
            wait_for(refused_busy, 5, 0.05, "a bind refused busy while paused")
            busy = True
        except TimeoutError:
            busy = False
        time.sleep(3)  # the runner keeps waiting: a call that gave up would have returned by now
        early = results_by_label(out_b).get("during")
    finally:
        os.kill(nestd, signal.SIGCONT)
        if not os.path.exists(cue):
            open(cue, "w").close()
    held = time.time() - held_at
    gl = gateway_log()
    check("checkpoint pause: the gateway refused the call's bind busy at once while the VM was paused", busy,
          " | ".join(re.findall(r"[^\n]*(?:sandbox paused|bind refused)[^\n]*", gl)[-3:])[-400:])
    check("checkpoint pause: the call waited while the VM was paused", early is None, json.dumps(early)[:200])
    try:
        during = wait_for(lambda: results_by_label(out_b).get("during"), 90, 0.25, "the call after the pause")
    except TimeoutError as e:
        check("checkpoint pause: the call ran once the VM ran again", False, str(e)[:200])
        return
    check("checkpoint pause: the call ran once the VM ran again",
          not during.get("is_error") and "during-checkpoint" in (during.get("text") or ""),
          f"held {held:.1f}s: {json.dumps(during)[:200]}")
    a = results_by_label(out_a).get("a") or {}
    check("checkpoint pause: the turn before it ran", not a.get("is_error") and "a" in (a.get("text") or ""), json.dumps(a)[:200])
    check("checkpoint pause: the gateway heard the VM run again", "sandbox running again" in gateway_log().split(paused_marker)[-1])


def run_fencing(ids):
    brains = real_brains() if REAL else children_named(FAKE_CLAUDE)
    guests = children_named(os.path.join(BIN, "nest-guest"))
    check("pre-fence: brain + guest alive", brains and guests, f"brains={brains} guests={guests}")
    log("stopping the control plane to cut heartbeats")
    t0 = time.time()
    stop_control_plane()
    # Both hosts hold a lease: each nestd self-fences on its own (the sandbox host its VMs, the
    # brain host its runner's brains).
    for name, what in (("nestd.log", "sandbox host"), ("nestd-brain.log", "brain host")):
        nestd_log = os.path.join(WORK, "logs", name)
        try:
            wait_for(lambda: re.search(r"self[- _]?fenc", read(nestd_log), re.I), FENCE_BUDGET_S, 0.5, f"{what} nestd self-fence log")
            dt = time.time() - t0
            check(f"{what} nestd self-fences after control-plane loss", dt <= 25, f"{dt:.1f}s after cut (spec: ~20s after last sent renewal)")
        except TimeoutError:
            check(f"{what} nestd self-fences after control-plane loss", False, f"no self-fence in {name} within budget")
    time.sleep(2)
    left = [p for p in brains if alive(p)]
    check("runner brains killed", not left, f"still alive: {left}")
    states = {p: proc_state(p) for p in guests}
    check("sandbox paused or stopped", all(s in (None, "T", "t", "Z") for s in states.values()), f"guest states {states}")
    p = in_userns(["bash", "-c", "timeout 5 bash -c 'exec 3<>/dev/tcp/172.16.0.1/443' && echo OPEN || echo CLOSED"], netns=ids["netns"]) \
        if os.path.exists(ids["netns"]) else None
    check("proxy listeners dropped / netns removed",
          p is None or "CLOSED" in p.stdout,
          "netns removed" if p is None else (p.stdout + p.stderr).strip()[:200])
    if ids.get("target"):
        t = ids["target"]
        r = gateway_probe(t["url"], t["binding"], t["guest"]["protocol_version"])
        m = r.get("message") or {}
        gl = gateway_log()
        removed = f"sandbox removed sandbox={ids['sandbox']}" in gl
        link_lost = bool(re.search(r"nestd link (lost|closed)", gl))
        check("gateway refuses the fenced sandbox's binding (moved, because nestd removed it)",
              m.get("type") == "error" and m.get("error", {}).get("code") == "moved" and removed and not link_lost,
              f"{json.dumps(r)[:140]} removed={removed} link_lost={link_lost}")
    # The lifecycle machine runs beside nestd and decides nothing yet (nestd_core::lifecycle): a
    # step it refused, or a state it reported that nestd didn't, is logged. Over the whole run,
    # the self-fence above included, there is none.
    # The fence's own stop of the VM runs in a task of its own: read the log once it has been
    # quiet for a second (10 s at most).
    nestd_log = os.path.join(WORK, "logs", "nestd.log")
    size, quiet_since, deadline = -1, time.time(), time.time() + 10
    while time.time() < deadline and time.time() - quiet_since < 1:
        now = os.path.getsize(nestd_log)
        if now != size:
            size, quiet_since = now, time.time()
        time.sleep(0.1)
    mismatches = [l for l in ANSI.sub("", read(os.path.join(WORK, "logs", "nestd.log"))).splitlines() if "lifecycle shadow mismatch" in l]
    check("the lifecycle machine agreed with nestd throughout", not mismatches, f"{len(mismatches)} mismatches; first: {mismatches[0][:300] if mismatches else ''}")


def main():
    if MODE not in ("fake", "real"):
        log(f"NEST_E2E_CLAUDE must be `fake` or `real`, not {MODE!r}")
        sys.exit(2)
    if REAL and not TOKEN:
        log("SKIP: NEST_E2E_CLAUDE=real needs the owner's Claude token in NEST_CLAUDE_OAUTH_TOKEN; nothing was run")
        sys.exit(2)
    if REAL and not (os.environ.get("NEST_CLAUDE_BIN") or shutil.which("claude")):
        log("SKIP: NEST_E2E_CLAUDE=real needs `claude` on PATH or NEST_CLAUDE_BIN; nothing was run")
        sys.exit(2)
    started = time.time()
    try:
        build()
        prepare_work()
        if REAL:
            prepare_real()
        start_control_plane()
        configure_host()
        start_inner()
        for name, what in (("nestd.log", "sandbox host"), ("nestd-brain.log", "brain host")):
            try:
                wait_for(lambda: re.search(r"enrolled", read(os.path.join(WORK, "logs", name))), 30, 0.5, f"{what} nestd enrolled")
                check(f"{what} nestd enrolled + fleet connected", True)
            except TimeoutError as e:
                check(f"{what} nestd enrolled + fleet connected", False, str(e))
        try:
            wait_for(lambda: ("nest-gateway listening" in gateway_log() and "resync done" in gateway_log()) or None, 30, 0.5, "gateway up and synced")
            check("gateway listening + synced with nestd", True)
        except TimeoutError as e:
            check("gateway listening + synced with nestd", False, str(e))
        check_gateway_unprivileged()
        ids = run_scenario()
        run_checkpoint_pause(ids)
        run_mcp(ids)
        run_mcp_oauth(ids)
        run_brokered(ids)
        run_rule_approvals(ids)
        run_repos(ids)
        run_checkpoints(ids)
        run_cut_under_writes(ids)
        run_lifecycle(ids)
        run_retention(ids)
        # After the turns: the token has been handed to the brains by now.
        check_token_not_in("the Claude token is not in the gateway's environment or command line", children_named(GW_BIN))
        run_fencing(ids)
        skip("transparent :443 interception", "the process driver runs the guest inside the netns itself (no tap0 peer), so nft's tap0 redirect never applies; covered by nestd's netns_redirect_reaches_listener test")
    except Exception as e:  # noqa: BLE001
        check("harness", False, f"{type(e).__name__}: {e}")
    finally:
        stop_control_plane()
        stop_mcp_server()
        stop_inner()
        passed = sum(1 for _, ok, _ in RESULTS if ok)
        failed = [n for n, ok, _ in RESULTS if ok is False]
        skipped = sum(1 for _, ok, _ in RESULTS if ok is None)
        log(f"done in {time.time() - started:.0f}s: {passed} passed, {len(failed)} failed, {skipped} skipped; logs in {WORK}/logs")
        for n in failed:
            log(f"  failed: {n}")
        with open(os.path.join(WORK, "summary.json"), "w") as f:
            json.dump([{"check": n, "ok": ok, "detail": d} for n, ok, d in RESULTS], f, indent=2)
        if REAL:
            finish_real()
    sys.exit(1 if any(ok is False for _, ok, _ in RESULTS) else 0)


if __name__ == "__main__":
    main()

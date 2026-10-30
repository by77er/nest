#!/usr/bin/env python3
"""nest local end-to-end harness. See e2e/README.md.

Runs the real control plane (wrangler dev --local) and the real host components inside an
unprivileged user namespace, as two hosts: a sandbox host (nest-proxy, nest-gateway, nestd with the
`process` driver running nest-guest) and a brain host (a second nestd in brain mode, nest-runner),
then drives a scenario through the admin API and checks the results.

NEST_E2E_CLAUDE=fake (default): brains are e2e/fake_claude.py running a scripted scenario; the real
`claude` binary is never invoked. NEST_E2E_CLAUDE=real: brains are the real `claude` with the token
from NEST_CLAUDE_OAUTH_TOKEN, given a short natural-language turn that uses the hands tools.
"""
import json, os, pwd, re, shutil, signal, subprocess, sys, time, urllib.error, urllib.request, uuid

E2E = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(E2E)
WORK = os.environ.get("NEST_E2E_WORK", os.path.join(E2E, ".work"))
BIN = os.path.join(ROOT, "target", "e2e", "release")
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


def id_maps():
    """`unshare` mappings for the gateway's own uid and gid (1..count onto the subordinate ranges),
    beside root (the invoking user). Exits with a reason when they can't be made."""
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
        f.write(f"ADMIN_TOKEN={ADMIN}\nHOST_TOKEN_SECRET=e2e-host-token-secret-0123456789abcdef\nALLOW_DEV_CA=1\n")


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
         "--var", f"PUBLIC_BASE_URL:{BASE}", "--var", "ASK_SYNC_WINDOW_MS:5000",
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
        "network": {"type": "netns", "persist_dir": os.path.join(WORK, "netns")},
        "gateway_url": GW_URL,
        # As on a host: only the gateway's uid on gateway.sock, and its group owns that socket and
        # each guest's vsock socket.
        "sockets": {"gateway_gid": GW_UID, "gateway_uids": [GW_UID]},
        "flush_interval_ms": 500,
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
               NEST_E2E_GATEWAY_BIN=GW_BIN)
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
    for pat in [os.path.join(BIN, "nest-guest"), GW_BIN, os.path.join(E2E, "fake_claude.py"),
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
        ("notify", "notify", {"to": "user", "message": "hello from the e2e fake claude"}),
    ]
    path = os.path.join(WORK, "scenario.json")
    with open(path, "w") as fh:
        json.dump({"results": os.path.join(WORK, "results.jsonl"),
                   "steps": [{"label": l, "tool": t, "args": a} for l, t, a in steps]}, fh, indent=2)
    return path, len(steps), sum(1 for _, tool, _ in steps if tool in HANDS_TOOLS)


def results_by_label():
    out = {}
    for line in read(os.path.join(WORK, "results.jsonl")).splitlines():
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
    st, ws = api("POST", "/v1/workstreams", {"goal": "e2e"})
    assert st == 201, (st, ws)
    wsid = ws.get("workstream") or ws.get("id")
    sbx = wait_for(lambda: (lambda r: r[1] if r[0] == 201 else None)(api("POST", "/v1/sandboxes", {"workstream": wsid, "cell": "local", "policy": E2E_POLICY})),
                   60, 1.0, "sandbox placed on a connected host")
    sbxid = sbx.get("sandbox") or sbx.get("id")
    check("sandbox placed", sbx.get("host"), f"{sbxid} on {sbx.get('host')}")
    netns = os.path.join(WORK, "netns", f"ns-{sbxid}")
    wait_for(lambda: os.path.exists(netns), 20, 0.2, "sandbox netns")

    # The brain host must be connected before the agent starts (otherwise its start waits for one).
    wait_for(lambda: any(h["role"] == "brain" and h["connected"] for h in (api("GET", "/v1/admin/fleet?cell=local")[1] or {}).get("hosts", [])),
             30, 0.5, "the brain host connected")
    body = {"template": "worker", "workstream": wsid, "sandbox": sbxid, "cell": "local"}
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
        skip("scripted hands, egress, notify and audit checks", "fake mode only: they need scripted tool calls; real mode checks hands through a natural-language turn")
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
        check("platform tool notify", res.get("notify") and not res["notify"]["is_error"], text("notify").strip()[:300])

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
    st, evs = api("GET", f"/v1/workstreams/{wsid}/events")
    evs_s = json.dumps(evs)
    check("workstream events visible", st == 200, evs_s[:300])
    if REAL:
        return {"workstream": wsid, "sandbox": sbxid, "agent": agid, "netns": netns, "target": ids_target}
    st, notes = api("GET", f"/v1/workstreams/{wsid}/notifications")
    check("notify reached the user-notification queue", st == 200 and "hello from the e2e fake claude" in json.dumps(notes), json.dumps(notes)[:300])

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

    return {"workstream": wsid, "sandbox": sbxid, "agent": agid, "netns": netns, "target": ids_target}


def gateway_log():
    """The gateway's log without tracing's ANSI colour codes, which sit between a field's name and its value."""
    return re.sub(r"\x1b\[[0-9;]*m", "", read(os.path.join(WORK, "logs", "gateway.log")))


def gateway_probe(url, binding, version):
    """Open /hands on the gateway as a brain would and return the first reply (see gateway_probe.mjs)."""
    p = subprocess.run(["node", os.path.join(E2E, "gateway_probe.mjs"), url, binding, str(version)], capture_output=True, text=True, timeout=30)
    try:
        return json.loads(p.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        return {"error": (p.stdout + p.stderr).strip()[:200]}


def tamper_signature(binding):
    """Flip one character of the signature segment: the claims stay intact, the signature no longer verifies."""
    if "." not in binding:
        return binding + ".AA"
    head, sig = binding.rsplit(".", 1)
    c = "A" if sig[0] != "A" else "B"
    return f"{head}.{c}{sig[1:]}"


def run_fencing(ids):
    brains = real_brains() if REAL else children_named(os.path.join(E2E, "fake_claude.py"))
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
        # After the turns: the token has been handed to the brains by now.
        check_token_not_in("the Claude token is not in the gateway's environment or command line", children_named(GW_BIN))
        run_fencing(ids)
        skip("transparent :443 interception", "the process driver runs the guest inside the netns itself (no tap0 peer), so nft's tap0 redirect never applies; covered by nestd's netns_redirect_reaches_listener test")
    except Exception as e:  # noqa: BLE001
        check("harness", False, f"{type(e).__name__}: {e}")
    finally:
        stop_control_plane()
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

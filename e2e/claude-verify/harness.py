"""Shared plumbing for the claude-verify probes: nest's argv/env/settings (mirrors of
`nest_protocol::host::claude`), the private mount namespace, a stream-json driver, redaction and the
report. Stdlib only."""
import glob, hashlib, json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, threading, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
PROTOCOL = os.path.join(ROOT, "protocol", "claude-code")
TOKEN_ENV = "NEST_CLAUDE_OAUTH_TOKEN"
SKIP_EXIT = 2

PASS, FAIL, INCONCLUSIVE, SKIPPED = "pass", "fail", "inconclusive", "skipped"

# `nest_protocol::host::claude::WORKER_BUILTIN_TOOLS`.
WORKER_BUILTIN_TOOLS = ["Agent", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TodoWrite", "WebSearch", "WebFetch"]
# Built-ins the runner refuses (docs/interfaces/host-internal/runner-claude/).
HOST_BUILTINS = {"Bash", "BashOutput", "KillShell", "KillBash", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit",
                 "Glob", "Grep", "LS", "PowerShell", "Monitor"}
# `_meta` keys `nest mcp` reads the tool-use id from (crates/nest-cli/src/mcp.rs).
BRIDGE_META_KEYS = ["claudecode/toolUseId", "toolUseId", "tool_use_id"]
# `claude::env` PATH; Claude Code itself is started by absolute path.
CHILD_PATH = "/usr/local/bin:/usr/bin:/bin"
MCP_TOOL_TIMEOUT_MS = 15 * 60 * 1000


# ---------------------------------------------------------------------------------- redaction
class Redactor:
    """Replaces secrets in text, and (same length, so binary files stay well-formed) in files."""

    def __init__(self, *secrets):
        self.secrets = [s for s in secrets if s and len(s) >= 8]

    def __call__(self, text):
        if not isinstance(text, str):
            return text
        for s in self.secrets:
            text = text.replace(s, "<redacted>")
        return text

    def scrub_tree(self, root, max_bytes=64 << 20):
        """Overwrite every occurrence of a secret under `root` with `*`s. Returns the files changed;
        files over `max_bytes` (sandbox disk images) are skipped and listed in `self.skipped`."""
        changed, self.skipped = [], []
        needles = [s.encode() for s in self.secrets]
        if not needles:
            return changed
        for d, _, files in os.walk(root):
            for name in files:
                p = os.path.join(d, name)
                if os.path.islink(p) or not os.path.isfile(p):
                    continue
                if os.path.getsize(p) > max_bytes:
                    self.skipped.append(p)
                    continue
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                except OSError:
                    continue
                new = data
                for n in needles:
                    new = new.replace(n, b"*" * len(n))
                if new != data:
                    with open(p, "r+b") as f:
                        f.write(new)
                    changed.append(p)
        return changed


def sha16(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------------- nest's invocation
def nest_args(builtin_tools, config_dir, session, model=None, mode="append", drop=(), extra=()):
    """`claude::args` (golden: `worker_args_golden` in crates/nest-protocol/src/host.rs).
    `session` is ("session-id", uuid) or ("resume", path-or-id). `drop` removes flags (probe deviations
    are recorded by the caller)."""
    a = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
         "--restricted", "--tools", ",".join(builtin_tools),
         "--strict-mcp-config", "--mcp-config", f"{config_dir}/nest-mcp.json",
         "--permission-mode", "dontAsk", "--permission-prompts", "none",
         "--allowedTools", ",".join(["mcp__nest__*"] + list(builtin_tools)),
         "--disable-slash-commands",
         "--append-system-prompt-file" if mode == "append" else "--system-prompt-file", f"{config_dir}/nest-system-prompt.md"]
    if model:
        a += ["--model", model]
    kind, value = session
    a += ["--session-id" if kind == "session-id" else "--resume", value]
    a = [x for x in a if x not in drop]
    return a + list(extra)


def nest_env(config_dir, token, tmpdir, agent, sock_dir, extra=None):
    """`claude::env`: the complete environment (nothing inherited)."""
    env = {
        "PATH": CHILD_PATH, "HOME": config_dir, "LANG": "C.UTF-8", "TZ": "UTC", "TMPDIR": tmpdir,
        "CLAUDE_CONFIG_DIR": config_dir, "CLAUDE_CODE_OAUTH_TOKEN": token,
        "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1", "CLAUDE_CODE_MCP_ALLOWLIST_ENV": "1", "DISABLE_AUTOUPDATER": "1",
        "NEST_AGENT_ID": agent, "NEST_HOOK_DGRAM": f"{sock_dir}/hook.dgram", "NEST_HOOK_SOCK": f"{sock_dir}/hook.sock",
        "NEST_HOOK_SPOOL": f"{config_dir}/nest-hook-spool.jsonl",
    }
    for k, v in (extra or {}).items():
        if v is None:
            env.pop(k, None)
        else:
            env[k] = v
    return env


def mcp_config(command, args, env):
    """Same shape as protocol/claude-code/mcp-config.json (`claude::mcp_config`), other command."""
    return {"mcpServers": {"nest": {"type": "stdio", "command": command, "args": list(args), "env": dict(env),
                                    "timeout": MCP_TOOL_TIMEOUT_MS, "alwaysLoad": True}}}


def managed_settings(hook_command, bwrap=None, reference=os.path.join(PROTOCOL, "managed-settings.json")):
    """nest's managed settings with every hook command replaced by `hook_command` (a string, or a
    function of the original command; timeouts, `onFailure`, `async` and matchers kept), plus
    `sandbox.bwrapPath` when bwrap isn't on PATH."""
    with open(reference) as f:
        s = json.load(f)
    s.pop("$comment", None)
    for groups in s.get("hooks", {}).values():
        for g in groups:
            for h in g.get("hooks", []):
                if h.get("type") == "command":
                    h["command"] = hook_command(h["command"]) if callable(hook_command) else hook_command
    if bwrap:
        s.setdefault("sandbox", {})["bwrapPath"] = bwrap
    return s


def find_bwrap(cache_dir, run=subprocess.run):
    """Bubblewrap for `sandbox.bwrapPath` (Claude Code needs it on Linux for
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1). Returns (path, source); path is None if bwrap is on the
    child's PATH (Claude Code finds it itself) or unavailable. Without one installed, the distro
    package is extracted into `cache_dir` (`apt-get download`; nothing is installed)."""
    if os.environ.get("NEST_CLAUDE_BWRAP"):
        return os.environ["NEST_CLAUDE_BWRAP"], "NEST_CLAUDE_BWRAP"
    if shutil.which("bwrap", path=CHILD_PATH):
        return None, f"on PATH ({shutil.which('bwrap', path=CHILD_PATH)})"
    local = os.path.join(cache_dir, "usr", "bin", "bwrap")
    if os.access(local, os.X_OK):
        return local, f"extracted earlier into {cache_dir}"
    if not (shutil.which("apt-get") and shutil.which("dpkg-deb")):
        return None, "unavailable (not installed; no apt-get to fetch it)"
    dl = tempfile.mkdtemp(prefix="nest-cv-bwrap-")
    try:
        run(["apt-get", "download", "bubblewrap"], cwd=dl, capture_output=True, timeout=120, check=True)
        debs = glob.glob(os.path.join(dl, "bubblewrap_*.deb"))
        if debs:
            os.makedirs(cache_dir, exist_ok=True)
            run(["dpkg-deb", "-x", debs[0], cache_dir], capture_output=True, timeout=60, check=True)
    except (OSError, subprocess.SubprocessError) as e:
        return None, f"unavailable (fetching the bubblewrap package failed: {e})"
    finally:
        shutil.rmtree(dl, ignore_errors=True)
    if os.access(local, os.X_OK):
        return local, f"extracted from the distro package into {cache_dir} (apt-get download; not installed)"
    return None, "unavailable (the bubblewrap package had no usr/bin/bwrap)"


def hook_command(python, hook_logger, log_path, decisions_path):
    return " ".join(shlex.quote(x) for x in [python, hook_logger, log_path, decisions_path])


def user_line(text):
    """`StreamIn::user_text` (no `session_id`)."""
    return {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": None}


def interrupt_line(request_id):
    return {"type": "control_request", "request_id": request_id, "request": {"subtype": "interrupt"}}


# ---------------------------------------------------------------------------------- transcript paths
def encode_documented(cwd):
    """Documented rule: every non-alphanumeric character becomes `-`."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def encode_nest(cwd):
    """`claude::project_dir` (crates/nest-protocol/src/host.rs): every UTF-16 unit that isn't an ASCII
    letter or digit becomes `-`; past 200 units the name keeps its first 200 and gains `-` plus the
    base-36 absolute value of the cwd's Java `hashCode`."""
    raw = cwd.encode("utf-16-le")
    units = [int.from_bytes(raw[i:i + 2], "little") for i in range(0, len(raw), 2)]
    name = "".join(chr(u) if u < 128 and chr(u).isalnum() else "-" for u in units)
    if len(name) <= 200:
        return name
    h = 0
    for u in units:
        h = (31 * h + u) & 0xFFFFFFFF
    signed = h - (1 << 32) if h >= (1 << 31) else h
    return f"{name[:200]}-{to_base36(abs(signed))}"


def common_prefix_len(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def identify_suffix(cwd, suffix):
    """Try to name the hash Claude Code appends to long project directory names."""
    s = suffix.strip("-").lower()
    if not s:
        return None
    cands = {}
    for name in ("sha256", "sha1", "md5"):
        cands[name + "_hex"] = hashlib.new(name, cwd.encode()).hexdigest()
    h = 0
    for ch in cwd:  # Java String.hashCode over UTF-16 units (BMP assumed)
        h = (31 * h + ord(ch)) & 0xFFFFFFFF
    signed = h - (1 << 32) if h >= (1 << 31) else h
    cands["java_hashcode_abs_base36"] = to_base36(abs(signed))
    cands["java_hashcode_abs_hex"] = format(abs(signed), "x")
    cands["java_hashcode_abs_dec"] = str(abs(signed))
    d = 5381
    for ch in cwd.encode():
        d = ((d << 5) + d + ch) & 0xFFFFFFFF
    cands["djb2_base36"] = to_base36(d)
    cands["djb2_hex"] = format(d, "x")
    for k, v in cands.items():
        if v == s or (len(s) >= 6 and v.startswith(s)):
            return k
    return None


def to_base36(n):
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if n == 0:
            return out


# ---------------------------------------------------------------------------------- stream-json driver
class Session:
    """One Claude Code process in its own process group, driven over stream-json."""

    def __init__(self, argv, env, cwd, log_dir, name, redact):
        self.name, self.redact, self.argv = name, redact, argv
        os.makedirs(log_dir, exist_ok=True)
        self.out_path = os.path.join(log_dir, f"{name}.stdout.jsonl")
        self.err_path = os.path.join(log_dir, f"{name}.stderr.log")
        self.in_path = os.path.join(log_dir, f"{name}.stdin.jsonl")
        self.lines = []  # {"ts", "obj", "raw"}
        self.sent = []   # {"ts", "obj"}
        self.cv = threading.Condition()
        self.eof = False
        self.t0 = time.time()
        self.p = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, start_new_session=True)
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read_out(self):
        with open(self.out_path, "a") as f:
            for raw in self.p.stdout:
                text = raw.decode(errors="replace").rstrip("\n")
                try:
                    obj = json.loads(text)
                except ValueError:
                    obj = None
                e = {"ts": time.time(), "obj": obj if isinstance(obj, dict) else None, "raw": text}
                f.write(self.redact(json.dumps({"t": round(e["ts"] - self.t0, 3), "line": obj if obj is not None else text})) + "\n")
                f.flush()
                with self.cv:
                    self.lines.append(e)
                    self.cv.notify_all()
        with self.cv:
            self.eof = True
            self.cv.notify_all()

    def _read_err(self):
        with open(self.err_path, "a") as f:
            for raw in self.p.stderr:
                f.write(self.redact(raw.decode(errors="replace")))
                f.flush()

    def send(self, obj):
        line = json.dumps(obj)
        self.sent.append({"ts": time.time(), "obj": obj})
        with open(self.in_path, "a") as f:
            f.write(self.redact(line) + "\n")
        try:
            self.p.stdin.write((line + "\n").encode())
            self.p.stdin.flush()
            return True
        except (BrokenPipeError, ValueError, OSError):
            return False

    def send_user(self, text):
        return self.send(user_line(text))

    def send_interrupt(self, request_id):
        return self.send(interrupt_line(request_id))

    def wait_for(self, pred, timeout, start=0):
        """First stdout entry (index >= start) whose parsed line satisfies `pred`, or None."""
        deadline = time.time() + timeout
        with self.cv:
            while True:
                for e in self.lines[start:]:
                    if e["obj"] is not None and pred(e["obj"]):
                        return e
                left = deadline - time.time()
                if left <= 0 or (self.eof and self.p.poll() is not None):
                    return None
                self.cv.wait(min(left, 0.2))

    def wait_exit(self, timeout):
        try:
            return self.p.wait(timeout)
        except subprocess.TimeoutExpired:
            return None

    def close_stdin(self):
        try:
            self.p.stdin.close()
        except OSError:
            pass

    def kill(self):
        try:
            os.killpg(self.p.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return self.wait_exit(10)

    def finish(self, timeout=20):
        """Close stdin and wait for exit; SIGKILL the group if it lingers. Returns the exit code."""
        self.close_stdin()
        rc = self.wait_exit(timeout)
        if rc is None:
            rc = self.kill()
        else:  # stragglers in the group (MCP server, async hooks)
            try:
                os.killpg(self.p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return rc

    def objs(self):
        with self.cv:
            return [e["obj"] for e in self.lines if e["obj"] is not None]

    def entries(self):
        with self.cv:
            return list(self.lines)

    def stderr_tail(self, n=2000):
        try:
            with open(self.err_path, errors="replace") as f:
                return f.read()[-n:]
        except FileNotFoundError:
            return ""


def is_init(o):
    return o.get("type") == "system" and o.get("subtype") == "init"


def is_result(o):
    return o.get("type") == "result"


def tool_uses(objs, prefix="mcp__"):
    out = []
    for o in objs:
        if o.get("type") == "assistant":
            for b in (o.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name", "").startswith(prefix):
                    out.append(b)
    return out


def pick(d, *keys):
    return {k: d.get(k) for k in keys if isinstance(d, dict) and k in d}


def read_jsonl(path):
    out = []
    try:
        with open(path, errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except FileNotFoundError:
        pass
    return out


def wait_until(fn, timeout, interval=0.2):
    deadline = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() >= deadline:
            return v
        time.sleep(interval)


# ---------------------------------------------------------------------------------- isolation
def namespace_argv(python, script, argv):
    return ["unshare", "--user", "--map-root-user", "--mount", "--propagation", "private", python, script] + list(argv)


def mount_ns():
    return os.readlink("/proc/self/ns/mnt")


def isolate(work, managed_dir, home, extra_masks=(), run=subprocess.run):
    """Inside a private mount namespace: put `managed_dir` at /etc/claude-code (overlaying /etc when the
    directory doesn't exist, so nothing is created on the host) and mask the invoking user's Claude
    configuration with empty read-only mounts. Returns a description of what was mounted."""
    done = []

    def mount(*args):
        run(["mount", *args], check=True, capture_output=True)

    if not os.path.isdir("/etc/claude-code"):
        upper, wk = os.path.join(work, "etc-overlay", "upper"), os.path.join(work, "etc-overlay", "work")
        os.makedirs(upper, exist_ok=True)
        os.makedirs(wk, exist_ok=True)
        mount("-t", "overlay", "overlay", "-o", f"lowerdir=/etc,upperdir={upper},workdir={wk}", "/etc")
        os.makedirs("/etc/claude-code", exist_ok=True)
        done.append("overlay on /etc (upper in the work dir)")
    mount("--bind", managed_dir, "/etc/claude-code")
    done.append(f"{managed_dir} bound at /etc/claude-code")
    empty_dir, empty_file = os.path.join(work, "mask", "dir"), os.path.join(work, "mask", "file")
    os.makedirs(empty_dir, exist_ok=True)
    open(empty_file, "a").close()
    for target in [os.path.join(home, ".claude"), os.path.join(home, ".claude.json"), *extra_masks]:
        if not target or not os.path.exists(target):
            continue
        src = empty_dir if os.path.isdir(target) else empty_file
        mount("--bind", src, target)
        mount("-o", "remount,bind,ro", target)
        done.append(f"{target} masked (empty, read-only)")
    # Prove it: a sentinel written to managed_dir must appear in /etc/claude-code.
    sentinel = f".sentinel-{uuid.uuid4().hex}"
    open(os.path.join(managed_dir, sentinel), "w").close()
    ok = os.path.exists(os.path.join("/etc/claude-code", sentinel))
    os.remove(os.path.join(managed_dir, sentinel))
    if not ok:
        raise RuntimeError("/etc/claude-code is not the probe's managed-settings directory")
    return done


# ---------------------------------------------------------------------------------- results and report
def result(n, key, title, status, summary, evidence=None):
    assert status in (PASS, FAIL, INCONCLUSIVE, SKIPPED), status
    return {"n": n, "item": key, "title": title, "status": status, "summary": summary, "evidence": evidence or {}}


def render_markdown(meta, results, max_evidence=6000):
    out = ["# Claude Code verification report", ""]
    for k in ("claude_version", "claude_bin", "model", "started", "duration_s", "total_cost_usd", "turns_sent"):
        if k in meta:
            out.append(f"- **{k}:** `{meta[k]}`")
    out += ["", "| # | Item | Status | Finding |", "|---|---|---|---|"]
    for r in results:
        finding = str(r["summary"]).replace("|", "\\|").replace("\n", " ")
        out.append(f"| {r['n']} | {r['title']} | **{r['status']}** | {finding} |")
    for r in results:
        out += ["", f"## {r['n']}. {r['title']}", "", f"**{r['status']}**: {r['summary']}", ""]
        ev = json.dumps(r["evidence"], indent=2, default=str)
        if len(ev) > max_evidence:
            ev = ev[:max_evidence] + f"\n… ({len(ev) - max_evidence} more characters in report.json)"
        out += ["```json", ev, "```"]
    return "\n".join(out) + "\n"


def write_report(out_dir, meta, results, redact):
    os.makedirs(out_dir, exist_ok=True)
    jp, mp = os.path.join(out_dir, "report.json"), os.path.join(out_dir, "report.md")
    with open(jp, "w") as f:
        f.write(redact(json.dumps({"meta": meta, "results": results}, indent=2, default=str)) + "\n")
    with open(mp, "w") as f:
        f.write(redact(render_markdown(meta, results)))
    return jp, mp


def exit_code(results):
    """1 if any probe failed, else 0 (inconclusive and skipped items don't fail the run)."""
    return 1 if any(r["status"] == FAIL for r in results) else 0


def eprint(*a):
    print(*a, file=sys.stderr, flush=True)

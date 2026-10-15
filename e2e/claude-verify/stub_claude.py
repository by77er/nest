#!/usr/bin/env python3
"""Stand-in for the `claude` binary, used only by test_claude_verify.py to run every probe end to end
without a token. It never talks to a model. It mimics what the probes observed from Claude Code
2.1.300 (lazy system/init, bubblewrap required by the env scrub, long-path hashing) and the
documented behavior the probes check for (`_meta` tool-use id, cancellation, defer, resume,
SessionStart after `/compact`), so every probe except init_order takes its pass path.
"""
import json, os, queue, re, subprocess, sys, threading, time, uuid

ARGS = sys.argv[1:]
ENV = dict(os.environ)
MANAGED = "/etc/claude-code/managed-settings.json"


def settings():
    try:
        with open(MANAGED) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def scrub_on():
    return ENV.get("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB") == "1"


def need_bwrap():
    if scrub_on() and not (settings().get("sandbox") or {}).get("bwrapPath"):
        print("error: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y "
              "bubblewrap, set sandbox.bwrapPath in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable "
              "(loses subprocess isolation).", file=sys.stderr)
        sys.exit(1)


if ARGS == ["--version"]:
    print("2.1.300 (Claude Code)")
    sys.exit(0)
if ARGS[:2] == ["auth", "status"]:
    need_bwrap()
    print(json.dumps({"loggedIn": True, "authMethod": "oauth_token" if ENV.get("CLAUDE_CODE_OAUTH_TOKEN") else "none",
                      "apiProvider": "firstParty", "configDirectory": ENV.get("CLAUDE_CONFIG_DIR"),
                      "forcedLoginMethod": settings().get("forceLoginMethod")}, indent=2))
    sys.exit(0)
need_bwrap()


def flag(name):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else None


def encode(cwd):
    enc = re.sub(r"[^A-Za-z0-9]", "-", cwd)
    if len(enc) <= 200:
        return enc
    h = 0
    for ch in cwd:
        h = (31 * h + ord(ch)) & 0xFFFFFFFF
    h = abs(h - (1 << 32) if h >= (1 << 31) else h)
    digits, out = "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while True:
        h, r = divmod(h, 36)
        out = digits[r] + out
        if not h:
            break
    return enc[:200] + "-" + out


CWD = os.getcwd()
RESUME = flag("--resume")
SID = (os.path.basename(RESUME)[:-6] if RESUME and RESUME.endswith(".jsonl") else RESUME) or flag("--session-id")
TRANSCRIPT = os.path.join(ENV["CLAUDE_CONFIG_DIR"], "projects", encode(CWD), f"{SID}.jsonl")
os.makedirs(os.path.dirname(TRANSCRIPT), exist_ok=True)
TOOLS = [t for t in (flag("--tools") or "").split(",") if t]
TOOLS = ["Task" if t == "Agent" else t for t in TOOLS]
SLASH = "--disable-slash-commands" not in ARGS
out_lock = threading.Lock()


def emit(o):
    o.setdefault("session_id", SID)
    with out_lock:
        sys.stdout.write(json.dumps(o) + "\n")
        sys.stdout.flush()


def record(o):
    with open(TRANSCRIPT, "a") as f:
        f.write(json.dumps(o) + "\n")


def sub_env():
    e = dict(ENV)
    if scrub_on():
        for k in ("CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"):
            e.pop(k, None)
    return e


def hook(event, **fields):
    data = {"session_id": SID, "transcript_path": TRANSCRIPT, "cwd": CWD, "hook_event_name": event, **fields}
    outs = []
    for g in (settings().get("hooks") or {}).get(event, []):
        for hk in g.get("hooks", []):
            if event in ("SessionStart", "Stop", "SessionEnd", "UserPromptSubmit", "PreCompact", "PostCompact"):
                emit({"type": "system", "subtype": "hook_started", "hook_event": event})
            p = subprocess.run(["sh", "-c", hk["command"]], input=json.dumps(data), capture_output=True, text=True, env=sub_env(), timeout=30)
            if p.stdout.strip():
                outs.append(json.loads(p.stdout))
    return outs


class Mcp:
    def __init__(self):
        cfg = json.load(open(flag("--mcp-config")))["mcpServers"]["nest"]
        env = {"PATH": ENV.get("PATH", "/usr/bin:/bin")} if ENV.get("CLAUDE_CODE_MCP_ALLOWLIST_ENV") == "1" else sub_env()
        env.update(cfg.get("env", {}))
        self.p = subprocess.Popen([cfg["command"]] + cfg.get("args", []), stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True)
        self.n, self.resp, self.cv = 0, {}, threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "stub", "version": "0"}})
        self.send("notifications/initialized", None)
        self.tools = [t["name"] for t in self.call("tools/list")["result"]["tools"]]

    def _read(self):
        for line in self.p.stdout:
            m = json.loads(line)
            with self.cv:
                self.resp[m.get("id")] = m
                self.cv.notify_all()

    def send(self, method, params, rid=None):
        m = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if rid is not None:
            m["id"] = rid
        self.p.stdin.write(json.dumps(m) + "\n")
        self.p.stdin.flush()

    def call(self, method, params=None):
        self.n += 1
        rid = self.n
        self.send(method, params, rid)
        return self.wait(rid, 30)

    def wait(self, rid, timeout, abort=None):
        end = time.time() + timeout
        with self.cv:
            while rid not in self.resp:
                if (abort and abort()) or time.time() > end:
                    return None
                self.cv.wait(0.05)
            return self.resp.pop(rid)


inbox = queue.Queue()


def read_stdin():
    for line in sys.stdin:
        if line.strip():
            inbox.put(json.loads(line))
    inbox.put(None)


hook("SessionStart", source="resume" if RESUME else "startup")
mcp = Mcp()
threading.Thread(target=read_stdin, daemon=True).start()
inited = False
pending = []


def init():
    global inited
    if not inited:
        inited = True
        emit({"type": "system", "subtype": "init", "cwd": CWD, "tools": TOOLS + [f"mcp__nest__{t}" for t in mcp.tools],
              "mcp_servers": [{"name": "nest", "status": "connected"}], "model": "stub", "permissionMode": "default",
              "apiKeySource": "none", "claude_code_version": "2.1.300", "capabilities": ["interrupt_receipt_v1"]})


def interrupted():
    while True:
        try:
            m = inbox.get_nowait()
        except queue.Empty:
            return bool(pending)
        if m and m.get("type") == "control_request":
            pending.append(m)
        else:
            inbox.put(m)
            return bool(pending)


def result(**kw):
    emit({"type": "result", "subtype": "success", "is_error": False, "num_turns": 1, "duration_ms": 5, "total_cost_usd": 0.001,
          "usage": {}, "stop_reason": "end_turn", **kw})


def tool(name, args, tid=None):
    """Returns False if the run must end (defer)."""
    tid = tid or "toolu_" + uuid.uuid4().hex[:16]
    if not any(r.get("tool_use_id") == tid for r in rows()):
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": f"mcp__nest__{name}", "input": args}]}})
        record({"type": "assistant", "tool_use_id": tid, "name": name, "input": args})
    outs = hook("PreToolUse", tool_name=f"mcp__nest__{name}", tool_input=args, tool_use_id=tid)
    decision = next((o.get("hookSpecificOutput", {}).get("permissionDecision") for o in outs), "allow")
    if decision == "defer":
        record({"type": "deferred", "tool_use_id": tid})
        result(stop_reason="tool_deferred", deferred_tool_use={"id": tid, "name": f"mcp__nest__{name}", "input": args})
        return False
    mcp.n += 1
    rid = mcp.n
    mcp.send("tools/call", {"name": name, "arguments": args, "_meta": {"claudecode/toolUseId": tid, "progressToken": rid}}, rid)
    r = mcp.wait(rid, 600, abort=interrupted)
    if r is None and pending:
        mcp.send("notifications/cancelled", {"requestId": rid, "reason": "interrupted"})
        for m in pending:
            emit({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
        pending.clear()
        result(subtype="error_during_execution", is_error=True, stop_reason="interrupted")
        return None
    record({"type": "user", "tool_result": tid})
    hook("PostToolUse", tool_name=f"mcp__nest__{name}", tool_input=args, tool_use_id=tid)
    emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "DONE"}]}})
    hook("Stop", stop_hook_active=False)
    result()
    return True


def rows():
    try:
        return [json.loads(x) for x in open(TRANSCRIPT) if x.strip()]
    except OSError:
        return []


def turn(text):
    init()
    record({"type": "user", "text": text})
    hook("UserPromptSubmit", prompt=text)
    if text.strip() == "/compact" and SLASH:
        hook("PreCompact", trigger="manual")
        emit({"type": "system", "subtype": "compact_boundary", "compact_metadata": {"trigger": "manual", "pre_tokens": 10}})
        hook("PostCompact", trigger="manual")
        hook("SessionStart", source="compact")
        return result()
    m = re.search(r"mcp__nest__(echo|sleep)", text)
    if not m:
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "OK"}]}})
        return result()
    q = re.search(r'"([^"]+)"', text)
    return tool(m.group(1), {"text": q.group(1) if q else "x"} if m.group(1) == "echo" else {"seconds": 120})


# A resumed session with an unfinished tool call: a deferred one re-runs; an interrupted one
# continues when CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1.
if RESUME:
    rs = rows()
    calls = [r for r in rs if r.get("type") == "assistant"]
    done = {r.get("tool_result") for r in rs}
    last = calls[-1] if calls else None
    if last and last["tool_use_id"] not in done:
        deferred = any(r.get("type") == "deferred" and r["tool_use_id"] == last["tool_use_id"] for r in rs)
        if deferred or ENV.get("CLAUDE_CODE_RESUME_INTERRUPTED_TURN") == "1":
            init()
            if tool(last["name"], last["input"], last["tool_use_id"]) is False:
                sys.exit(0)

while True:
    msg = inbox.get()
    if msg is None:
        break
    if msg.get("type") == "user":
        c = msg["message"]["content"]
        text = c if isinstance(c, str) else "".join(b.get("text", "") for b in c)
        if turn(text) is False:
            break
    elif msg.get("type") == "control_request":
        emit({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {}}})
hook("SessionEnd", reason="other")
mcp.p.stdin.close()

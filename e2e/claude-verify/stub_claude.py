#!/usr/bin/env python3
"""Stand-in for the `claude` binary, used only by test_claude_verify.py to run every probe end to end
without a token. It never talks to a model. It mimics what the probes observed from Claude Code
2.1.300 (lazy system/init, bubblewrap required by the env scrub, long-path hashing) and the
documented behavior the probes check for (`_meta` tool-use id, cancellation, defer, resume,
SessionStart after `/compact`) and what 2.1.316 did with hook answers (PostToolUse context followed by
the main loop and declined by a subagent; a blocked Stop continues, fires Stop again and ends with one
result), so every probe except init_order takes its pass path. STUB_IGNORE_CONTEXT=1 drops PostToolUse
context, for the probe's failure path. On `notifications/tools/list_changed` it lists again (as the
docs say Claude Code does); a prompt naming an MCP tool it doesn't have ends the turn with MISSING.
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
        self.n, self.resp, self.cv, self.lock = 0, {}, threading.Condition(), threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()
        self.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "stub", "version": "0"}})
        self.send("notifications/initialized", None)
        self.relist()

    def relist(self):
        self.tools = [t["name"] for t in self.call("tools/list")["result"]["tools"]]

    def _read(self):
        for line in self.p.stdout:
            m = json.loads(line)
            if m.get("method") == "notifications/tools/list_changed":
                threading.Thread(target=self.relist, daemon=True).start()
                continue
            with self.cv:
                self.resp[m.get("id")] = m
                self.cv.notify_all()

    def next_id(self):
        with self.lock:
            self.n += 1
            return self.n

    def send(self, method, params, rid=None):
        m = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if rid is not None:
            m["id"] = rid
        with self.lock:
            self.p.stdin.write(json.dumps(m) + "\n")
            self.p.stdin.flush()

    def call(self, method, params=None):
        rid = self.next_id()
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


def call(name, args, tid=None, parent=None, agent=None):
    """One tool call with its hooks: an MCP tool (`echo`, `sleep`) or a built-in (a capitalized
    name). `agent` is the subagent id when a subagent makes the call. Returns ("ok", the PostToolUse
    additionalContext texts), ("deferred", None) or ("interrupted", None)."""
    mcp_tool = name[:1].islower()
    full = f"mcp__nest__{name}" if mcp_tool else name
    who = {"agent_id": agent, "agent_type": "general-purpose"} if agent else {}
    tid = tid or "toolu_" + uuid.uuid4().hex[:16]
    if not any(r.get("tool_use_id") == tid for r in rows()):
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": full, "input": args}]},
              "parent_tool_use_id": parent})
        record({"type": "assistant", "tool_use_id": tid, "name": name, "input": args})
    outs = hook("PreToolUse", tool_name=full, tool_input=args, tool_use_id=tid, **who)
    decision = next((o.get("hookSpecificOutput", {}).get("permissionDecision") for o in outs), "allow")
    if decision == "defer":
        record({"type": "deferred", "tool_use_id": tid})
        result(stop_reason="tool_deferred", deferred_tool_use={"id": tid, "name": full, "input": args})
        return "deferred", None
    if mcp_tool:
        rid = mcp.next_id()
        mcp.send("tools/call", {"name": name, "arguments": args, "_meta": {"claudecode/toolUseId": tid, "progressToken": rid}}, rid)
        r = mcp.wait(rid, 600, abort=interrupted)
        if r is None and pending:
            mcp.send("notifications/cancelled", {"requestId": rid, "reason": "interrupted"})
            for m in pending:
                emit({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
            pending.clear()
            result(subtype="error_during_execution", is_error=True, stop_reason="interrupted")
            return "interrupted", None
    elif name in ("Agent", "Task"):
        subagent(tid)
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]},
          "parent_tool_use_id": parent})
    record({"type": "user", "tool_result": tid})
    outs = hook("PostToolUse", tool_name=full, tool_input=args, tool_use_id=tid, **who)
    if ENV.get("STUB_IGNORE_CONTEXT") == "1":  # a model that never sees PostToolUse context
        return "ok", []
    return "ok", [o.get("hookSpecificOutput", {}).get("additionalContext") for o in outs if o.get("hookSpecificOutput", {}).get("additionalContext")]


ECHO_ORDER = re.compile(r'mcp__nest__echo tool[^"]*with text "([^"]+)"')


def follow(instructions, parent=None, agent=None):
    """The stub's model obeys an instruction to call mcp__nest__echo with a given text."""
    for text in instructions:
        for token in ECHO_ORDER.findall(text):
            call("echo", {"text": token}, parent=parent, agent=agent)


def subagent(parent):
    """A foreground subagent that calls mcp__nest__sleep and, like Claude Code 2.1.316's haiku
    subagent, declines an instruction that arrives with a tool result (but says so)."""
    aid = "a" + uuid.uuid4().hex[:16]
    _, ctx = call("sleep", {"seconds": 1}, parent=parent, agent=aid)
    path = os.path.join(os.path.dirname(TRANSCRIPT), SID, "subagents", f"agent-{aid}.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = "DONE" + ("\n\nThe tool result included an instruction to call the echo tool; I ignored it." if ctx else "")
    with open(path, "a") as f:
        f.write(json.dumps({"type": "assistant", "isSidechain": True, "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}}) + "\n")


def end_turn(text):
    """The final text, then the Stop chain: a `block` makes the model act on the reason and stop
    again (`stop_hook_active: true`); one result line at the very end."""
    active = False
    while True:
        emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
        block = next((o for o in hook("Stop", stop_hook_active=active) if o.get("decision") == "block"), None)
        if not block:
            return result(result=text)
        reason = block.get("reason", "")
        emit({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "Stop hook feedback:\n" + reason}]}})
        follow([reason])
        m = re.search(r"single word (\w+)", reason)
        text, active = (m.group(1) if m else "OK"), True


def tool(name, args, tid=None):
    """Returns False if the run must end (defer), None if it was interrupted."""
    status, ctx = call(name, args, tid)
    if status != "ok":
        return False if status == "deferred" else None
    follow(ctx)
    end_turn("DONE")
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
    if "Agent tool" in text:
        return tool("Agent", {"subagent_type": "general-purpose", "prompt": text})
    if "TaskList" in text:
        return tool("TaskList", {})
    m = re.search(r"mcp__nest__(\w+)", text)
    if not m:
        w = re.search(r"single word (\w+)", text)
        return end_turn(w.group(1) if w else "OK")
    if m.group(1) not in mcp.tools:
        return end_turn("MISSING")
    q = re.search(r'"([^"]+)"', text)
    return tool(m.group(1), {"seconds": 120} if m.group(1) == "sleep" else {"text": q.group(1) if q else "x"})


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

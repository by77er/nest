#!/usr/bin/env python3
"""Fake Claude Code for nest's end-to-end tests (`cargo test -p nest-cli` and e2e/). Never talks
to any model.

Emulates what the runner relies on (docs/interfaces/host-internal/runner-claude/):
`auth status`, `--version`, stream-json on stdio (shapes from protocol/claude-code/),
the session JSONL file, an MCP client for `nest mcp`, and hooks as nest's managed settings wire
them (`managed-settings.json` beside this file, else the repo's protocol/claude-code/ copy):
which events run `nest hook`, synchronously (`--sync`) or not, within each hook's timeout.

Turn behavior (by user text):
- contains SLOW     → mcp__nest__Bash `sleep 30`; honors stream-json interrupts
- contains PLATFORM → also calls the `checkpoint` platform tool
- `E2E <scenario.json>` (alone, or as an agent's message: `Message from <sender>: E2E …`) → the scripted tool calls in that file ({"results": path, "steps":
  [{"tool", "args", "label"}]}), each result appended to `results` at once (JSONL, flushed); a step
  {"await_tool": name, "absent"?: bool, "timeout_s"?: n, "label"} instead waits until the tool list
  has (or lacks) `<name>` (as `nest mcp` lists it) and records `listed`/`unlisted` or `timeout`; a step
  {"await_file": path, "timeout_s"?: n, "label"} creates `<path>.waiting`, waits until that file exists (the
  harness's cue) and records `present` or `timeout`
As Claude Code does under `-p` (docs: "Dynamic tool updates"), `notifications/tools/list_changed` from
`nest mcp` makes it list the tools again.
- otherwise         → mcp__nest__Bash `echo <text>`
As the model would, it reads a `PostToolUse` hook's `additionalContext` and works on it before
stopping (another step, with that text), and a `Stop` hook's `decision: block` continues the turn
with the reason; neither emits a `result` before the turn ends.

Everything observable is appended to $HOME/fake-claude-runs.jsonl (HOME == config dir).
"""
import json, os, queue, re, subprocess, sys, threading, time, uuid

ARGS = sys.argv[1:]
HOME = os.environ.get("HOME", "/tmp")
TOKEN = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN", "")

if ARGS[:2] == ["auth", "status"]:
    method = "api_key" if TOKEN.startswith("apikey") else "oauth_token"
    print(json.dumps({"loggedIn": True, "authMethod": method, "configDirectory": os.environ.get("CLAUDE_CONFIG_DIR")}))
    sys.exit(0)
if ARGS == ["--version"]:
    print("2.1.296 (Claude Code)")
    sys.exit(0)

def flag(name):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else None

RUN = {"argv": ARGS, "env": dict(os.environ), "cwd": os.getcwd(), "events": []}

def log(kind, **kw):
    RUN["events"].append(dict(kind=kind, **kw))

def save():
    with open(os.path.join(HOME, "fake-claude-runs.jsonl"), "a") as f:
        f.write(json.dumps(RUN) + "\n")

mcp_cfg = json.load(open(flag("--mcp-config")))["mcpServers"]["nest"]
NEST = mcp_cfg["command"]
fork = "--fork-session" in ARGS
if flag("--resume"):
    resume_path = flag("--resume")
    SESSION = str(uuid.uuid4()) if fork else os.path.basename(resume_path)[: -len(".jsonl")]
else:
    resume_path = None
    SESSION = flag("--session-id")
PROJECT = os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "projects", os.getcwd().replace("/", "-"))
TRANSCRIPT = resume_path if (resume_path and not fork) else os.path.join(PROJECT, SESSION + ".jsonl")
os.makedirs(os.path.dirname(TRANSCRIPT), exist_ok=True)
RUN["session"], RUN["transcript"] = SESSION, TRANSCRIPT

out_lock = threading.Lock()

def emit(obj):
    obj.setdefault("session_id", SESSION)
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

def transcript(obj):
    with open(TRANSCRIPT, "a") as f:
        f.write(json.dumps(obj) + "\n")

def managed_hooks():
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(here, "managed-settings.json"),
              os.path.join(here, "..", "..", "..", "protocol", "claude-code", "managed-settings.json")):
        if os.path.exists(p):
            return json.load(open(p))["hooks"]
    sys.exit("fake_claude: no managed-settings.json")

HOOKS = managed_hooks()

def hook(payload):
    """Run the managed hooks for `payload`'s event, with `nest` from the MCP config standing in for
    the installed path; the output of a synchronous one (`--sync`) is returned."""
    payload = dict(payload, session_id=SESSION, transcript_path=TRANSCRIPT, cwd=os.getcwd())
    out = {}
    for group in HOOKS.get(payload["hook_event_name"], []):
        for h in group["hooks"]:
            args = h["command"].split()[1:]
            try:
                p = subprocess.run([NEST] + args, input=json.dumps(payload).encode(), capture_output=True,
                                   env=os.environ.copy(), timeout=h.get("timeout", 60))
                text, code = p.stdout.decode().strip(), p.returncode
            except subprocess.TimeoutExpired:
                text, code = "", "timeout"
            sync = "--sync" in args
            if sync and text:
                out = json.loads(text)
            log("hook", event=payload["hook_event_name"], sync=sync, exit=code, output=json.loads(text) if text else {})
    return out

class Mcp:
    def __init__(self):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        env.update(mcp_cfg.get("env", {}))
        self.p = subprocess.Popen([NEST] + mcp_cfg.get("args", []), stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.n = 0
        self.responses = {}
        self.notifications = []
        self.cv = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            msg = json.loads(line)
            with self.cv:
                if "id" in msg and msg["id"] is not None:
                    self.responses[msg["id"]] = msg
                else:
                    self.notifications.append(msg)
                self.cv.notify_all()
            if msg.get("method") == "notifications/tools/list_changed":
                # Not on this thread: it reads the answer.
                threading.Thread(target=relist, args=("list_changed",), daemon=True).start()

    def send(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notify:
            self.n += 1
            msg["id"] = self.n
        self.p.stdin.write((json.dumps(msg) + "\n").encode())
        self.p.stdin.flush()
        return msg.get("id")

    def wait(self, rid, timeout=30, abort=None):
        deadline = time.time() + timeout
        with self.cv:
            while rid not in self.responses:
                if abort and abort():
                    return None
                left = deadline - time.time()
                if left <= 0:
                    return None
                self.cv.wait(min(left, 0.05))
            return self.responses.pop(rid)

    def call(self, method, params=None, timeout=30):
        return self.wait(self.send(method, params), timeout)

# ---- startup -------------------------------------------------------------------------------
emit({"type": "system", "subtype": "init", "cwd": os.getcwd(), "tools": ["TodoWrite", "mcp__nest__Bash"],
      "mcp_servers": [{"name": "nest", "status": "connected"}], "model": "claude-opus-5-5", "permissionMode": "dontAsk",
      "apiKeySource": "ANTHROPIC_API_KEY" if TOKEN.startswith("apisrc") else "none", "claude_code_version": "2.1.296",
      "capabilities": ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"], "uuid": str(uuid.uuid4())})
hook({"hook_event_name": "SessionStart", "source": "resume" if resume_path else "startup"})
mcp = Mcp()
mcp.call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-claude", "version": "0"}})
mcp.send("notifications/initialized", notify=True)
TOOL_NAMES = []  # the latest tools/list, as Claude Code would hold it

def relist(trigger):
    global TOOL_NAMES
    r = mcp.call("tools/list")
    names = [t["name"] for t in r["result"]["tools"]] if r and "result" in r else None
    if names is not None:
        TOOL_NAMES = names
    log("tools", names=names, trigger=trigger)

relist("start")
save_lock = threading.Lock()

# ---- stdin reader --------------------------------------------------------------------------
inbox = queue.Queue()
def read_stdin():
    for line in sys.stdin:
        if line.strip():
            inbox.put(json.loads(line))
    inbox.put(None)
threading.Thread(target=read_stdin, daemon=True).start()

pending_interrupt = []

def take_interrupt():
    """Non-blocking: move any queued interrupt control requests aside."""
    keep = []
    while True:
        try:
            m = inbox.get_nowait()
        except queue.Empty:
            break
        if m and m.get("type") == "control_request":
            pending_interrupt.append(m)
        else:
            keep.append(m)
    for m in keep:
        inbox.put(m)
    return bool(pending_interrupt)

def tool(name, args):
    tid = "toolu_" + uuid.uuid4().hex[:12]
    emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": tid, "name": "mcp__nest__" + name, "input": args}]}, "parent_tool_use_id": None})
    transcript({"type": "assistant", "tool_use": {"id": tid, "name": name, "input": args}})
    pre = hook({"hook_event_name": "PreToolUse", "tool_name": "mcp__nest__" + name, "tool_input": args, "tool_use_id": tid})
    decision = pre.get("hookSpecificOutput", {}).get("permissionDecision")
    interrupted = False
    if decision != "allow":
        text, is_error = "denied: " + str(pre.get("hookSpecificOutput", {}).get("permissionDecisionReason")), True
    else:
        rid = mcp.send("tools/call", {"name": name, "arguments": args})
        resp = mcp.wait(rid, timeout=60, abort=take_interrupt)
        if resp is None and pending_interrupt:
            interrupted = True
            mcp.send("notifications/cancelled", {"requestId": rid, "reason": "interrupted"}, notify=True)
            resp = mcp.wait(rid, timeout=15)
        result = (resp or {}).get("result", {"content": [{"type": "text", "text": "no response"}], "isError": True})
        text = "\n".join(c.get("text", "") for c in result.get("content", []))
        is_error = result.get("isError", False)
    emit({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": text}], "is_error": is_error}]}, "parent_tool_use_id": None})
    transcript({"type": "user", "tool_result": {"id": tid, "text": text, "is_error": is_error}})
    post = hook({"hook_event_name": "PostToolUse", "tool_name": "mcp__nest__" + name, "tool_input": args, "tool_response": {"text": text}, "tool_use_id": tid})
    context = post.get("hookSpecificOutput", {}).get("additionalContext")
    if context:
        transcript({"type": "attachment", "hook_additional_context": context})
    log("tool", name=name, args=args, decision=decision, text=text, is_error=is_error, interrupted=interrupted, context=context)
    return interrupted, context

def say(text):
    emit({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}, "parent_tool_use_id": None})
    transcript({"type": "assistant", "text": text})

def stop_chain():
    """The Stop hook, again for every `block` (whose reason the model reads and answers)."""
    active = False
    while True:
        stop = hook({"hook_event_name": "Stop", "stop_hook_active": active})
        if stop.get("decision") != "block":
            return
        transcript({"type": "user", "message": {"role": "user", "content": stop.get("reason", "")}})
        say("noted: " + stop.get("reason", "")[:40])
        active = True

def scripted(path):
    sc = json.load(open(path))
    for step in sc["steps"]:
        if "await_tool" in step:
            name, absent = step["await_tool"], step.get("absent", False)
            deadline = time.time() + step.get("timeout_s", 30)
            while (name in TOOL_NAMES) == absent and time.time() < deadline:
                time.sleep(0.1)
            ok = (name in TOOL_NAMES) != absent
            text = ("unlisted" if absent else "listed") if ok else "timeout"
            log("await_tool", name=name, absent=absent, text=text, names=TOOL_NAMES)
            with open(sc["results"], "a") as f:
                f.write(json.dumps({"label": step.get("label", name), "tool": name, "text": text, "is_error": not ok}) + "\n")
                f.flush()
            continue
        if "await_file" in step:
            open(step["await_file"] + ".waiting", "w").close()  # the harness's sign that this turn is blocked here
            deadline = time.time() + step.get("timeout_s", 30)
            while not os.path.exists(step["await_file"]) and time.time() < deadline:
                time.sleep(0.05)
            ok = os.path.exists(step["await_file"])
            log("await_file", path=step["await_file"], present=ok)
            with open(sc["results"], "a") as f:
                f.write(json.dumps({"label": step.get("label", "await_file"), "tool": "await_file", "text": "present" if ok else "timeout", "is_error": not ok}) + "\n")
                f.flush()
            continue
        name, args = step["tool"], step["args"]
        tool(name, args)
        last = RUN["events"][-1]
        with open(sc["results"], "a") as f:
            f.write(json.dumps({"label": step.get("label", name), "tool": name, "text": last.get("text"),
                                "is_error": last.get("is_error"), "decision": last.get("decision")}) + "\n")
            f.flush()
    say("scenario done")
    stop_chain()
    emit({"type": "result", "subtype": "success", "is_error": False, "num_turns": len(sc["steps"]), "duration_ms": 12, "total_cost_usd": 0.0,
          "usage": {"input_tokens": 100, "output_tokens": 20}, "stop_reason": "end_turn", "result": "done"})

def turn(text):
    # An agent's message (a spawn's task: "Message from <sender>: E2E <path>") runs a scenario too.
    msg = re.match(r"Message from \S+: (E2E .*)$", text, re.S)
    if msg:
        text = msg.group(1)
    if text.startswith("E2E "):
        return scripted(text[4:].strip())
    hook({"hook_event_name": "UserPromptSubmit", "prompt": text})
    steps = 0
    while True:
        steps += 1
        transcript({"type": "user", "message": {"role": "user", "content": text}})
        cmd = "sleep 30" if "SLOW" in text else "echo " + text.split("\n")[0][:40]
        interrupted, context = tool("Bash", {"command": cmd})
        if interrupted:
            for m in pending_interrupt:
                emit({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
            pending_interrupt.clear()
            emit({"type": "result", "subtype": "error_during_execution", "is_error": True, "num_turns": steps, "duration_ms": 5,
                  "total_cost_usd": 0.0, "usage": {"input_tokens": 1, "output_tokens": 1}, "stop_reason": "interrupted", "result": "interrupted"})
            return
        if "PLATFORM" in text:
            more = tool("checkpoint", {})[1]
            context = "\n".join(c for c in (context, more) if c)
        say("done: " + text[:40])
        if not context:
            break
        text = context
    stop_chain()
    emit({"type": "result", "subtype": "success", "is_error": False, "num_turns": steps, "duration_ms": 12, "total_cost_usd": 0.01,
          "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 50}, "stop_reason": "end_turn", "result": "done"})

try:
    while True:
        m = inbox.get()
        if m is None:
            break
        if m.get("type") == "user":
            content = m["message"]["content"]
            text = content if isinstance(content, str) else "".join(b.get("text", "") for b in content)
            log("user_input", text=text)
            turn(text)
        elif m.get("type") == "control_request":
            emit({"type": "control_response", "response": {"subtype": "success", "request_id": m["request_id"], "response": {"still_queued": []}}})
    hook({"hook_event_name": "SessionEnd", "reason": "stdin closed"})
    delay = os.path.join(HOME, "fake-exit-delay-ms")
    if os.path.exists(delay):
        time.sleep(int(open(delay).read().strip() or "0") / 1000)
finally:
    save()
    try:
        mcp.p.stdin.close()
        mcp.p.wait(timeout=5)
    except Exception:
        pass

"""The claude-verify probes: one function per item in docs/README.md's "Verify against the real Claude
Code binary" list (plus the `forceLoginMethod` item above it). Each returns `harness.result(...)`.

Items 1-5, 7 and the short-cwd half of 8 share one baseline session (one short turn with one
`mcp__nest__echo` call), so the whole run stays at about a dozen small model requests."""
import glob, json, os, shutil, subprocess, sys, time, traceback, uuid

import harness as h
from harness import FAIL, INCONCLUSIVE, PASS, SKIPPED, is_init, is_result, pick

PROBE_SYSTEM_PROMPT = ("You are being exercised by an automated test of the Claude Code CLI. Follow the user's "
                       "instructions exactly, use only the tools they name, and keep every reply to one word.")
BASELINE_PROMPT = 'Call the mcp__nest__echo tool exactly once with text "nest-probe". After it returns, reply with the single word DONE.'
SLEEP_PROMPT = "Call the mcp__nest__sleep tool exactly once with seconds set to 120. When it returns, reply with the single word DONE."
DEFER_PROMPT = 'Call the mcp__nest__echo tool exactly once with text "deferred-call". After it returns, reply with the single word DONE.'
OK_PROMPT = "Reply with the single word OK."
AGENT = "agt_claudeverify"
# --tools name → the name system/init reports for it (seen in 2.1.300).
TOOL_ALIASES = {"Agent": "Task"}

ITEMS = [
    (1, "auth", "CLAUDE_CODE_OAUTH_TOKEN under forceLoginMethod: claudeai; `claude auth status` JSON"),
    (2, "init_order", "system/init before the first user message; hook events before it"),
    (3, "user_shape", "stdin user message without session_id"),
    (4, "meta_tool_use_id", "MCP tools/call `_meta` key carrying the tool-use id"),
    (5, "restricted_tools", "--restricted honors the --tools built-in list"),
    (6, "cancel", "notifications/cancelled reaches MCP on interrupt"),
    (7, "env_scrub", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps NEST_* for hooks and MCP"),
    (8, "transcript_path", "Transcript path encoding (cwd over 200 characters included)"),
    (9, "resume_defer", "CLAUDE_CODE_RESUME_INTERRUPTED_TURN and PreToolUse defer under stream-json"),
    (10, "compaction", "SessionStart fires after compaction"),
]


# ---------------------------------------------------------------------------------- context
class Context:
    def __init__(self, claude_bin, model, token, work, managed_dir, temp_root, redact,
                 turn_timeout=120.0, startup_timeout=30.0, init_wait=10.0):
        self.claude_bin, self.model, self.token = claude_bin, model, token
        self.work, self.managed_dir, self.temp_root, self.redact = work, managed_dir, temp_root, redact
        self.turn_timeout, self.startup_timeout, self.init_wait = turn_timeout, startup_timeout, init_wait
        self.python = sys.executable
        self.sessions = []
        self._baseline = None
        self.bwrap = None      # `sandbox.bwrapPath` for the managed settings
        self.env_extra = {}    # deviations from nest's env, applied to every session
        self.bwrap_info = {}

    def prepare(self, bwrap_path, bwrap_source):
        """Claude Code on Linux refuses CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 without bubblewrap. Detect
        that with a free `claude auth status` under nest's exact settings, then use the bwrap the
        caller found (via `sandbox.bwrapPath`), or turn the scrub off for the other probes."""
        info = {"bwrap_source": bwrap_source}
        if shutil.which("bwrap", path=h.CHILD_PATH):
            info["required"] = None  # can't test: Claude Code finds it on PATH
        else:
            a = self.workspace("preflight_bwrap").auth_status()
            err = a.get("stderr") or ""
            info["required"] = "bubblewrap is required" in err
            info["preflight_auth_status"] = {"rc": a.get("rc"), "stderr": next((l.strip() for l in err.splitlines() if "bubblewrap" in l), err[-300:])}
            if info["required"]:
                if bwrap_path:
                    self.bwrap = bwrap_path
                    info["deviation"] = f"managed settings get sandbox.bwrapPath={bwrap_path}"
                else:
                    self.env_extra["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"] = "0"
                    info["deviation"] = "no bubblewrap: every other probe runs with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0"
        self.bwrap_info = info
        return info

    def workspace(self, name, cwd=None):
        return Workspace(self, name, cwd)

    def temp_cwd(self, *parts):
        """Working directories live outside the repo, so no CLAUDE.md above them is picked up."""
        p = os.path.join(self.temp_root, *parts)
        os.makedirs(p, exist_ok=True)
        return p

    def baseline(self):
        if self._baseline is None:
            self._baseline = run_baseline(self)
        return self._baseline

    def cost(self):
        total, turns = 0.0, 0
        for s in self.sessions:
            turns += sum(1 for x in s.sent if x["obj"].get("type") == "user")
            for o in s.objs():
                if is_result(o):
                    total += float(o.get("total_cost_usd") or 0)
        return round(total, 6), turns


class Workspace:
    """Per-probe config dir (CLAUDE_CONFIG_DIR = HOME), cwd, logs and the managed settings that wire
    hooks to `hook_logger.py`."""

    def __init__(self, ctx, name, cwd=None):
        self.ctx, self.name = ctx, name
        self.dir = os.path.join(ctx.work, "probes", name)
        self.config, self.tmp = os.path.join(self.dir, "config"), os.path.join(self.dir, "tmp")
        self.state, self.sock = os.path.join(self.dir, "mcp-state"), os.path.join(self.dir, "run")
        for d in (self.config, self.tmp, self.state, self.sock):
            os.makedirs(d, exist_ok=True)
        self.cwd = cwd or ctx.temp_cwd(name)
        self.hooks_log, self.mcp_log = os.path.join(self.dir, "hooks.jsonl"), os.path.join(self.dir, "mcp.jsonl")
        self.decisions = os.path.join(self.dir, "decisions.json")
        with open(os.path.join(self.config, "nest-system-prompt.md"), "w") as f:
            f.write(PROBE_SYSTEM_PROMPT + "\n")
        cfg = h.mcp_config(ctx.python, [os.path.join(h.HERE, "mcp_logger.py"), "--log", self.mcp_log, "--state-dir", self.state],
                           {"NEST_AGENT_ID": AGENT, "NEST_MCP_SOCK": f"{self.sock}/mcp.sock"})
        with open(os.path.join(self.config, "nest-mcp.json"), "w") as f:
            json.dump(cfg, f, indent=2)

    def set_decisions(self, d):
        with open(self.decisions, "w") as f:
            json.dump(d, f)

    def env(self, extra=None):
        return h.nest_env(self.config, self.ctx.token, self.tmp, AGENT, self.sock, {**self.ctx.env_extra, **(extra or {})})

    def install_settings(self):
        cmd = h.hook_command(self.ctx.python, os.path.join(h.HERE, "hook_logger.py"), self.hooks_log, self.decisions)
        with open(os.path.join(self.ctx.managed_dir, "managed-settings.json"), "w") as f:
            json.dump(h.managed_settings(cmd, bwrap=self.ctx.bwrap), f, indent=2)

    def start(self, session, name, tools=h.WORKER_BUILTIN_TOOLS, mode="append", env_extra=None, drop=(), extra=()):
        self.install_settings()
        argv = [self.ctx.claude_bin] + h.nest_args(tools, self.config, session, self.ctx.model, mode, drop, extra)
        s = h.Session(argv, self.env(env_extra), self.cwd, self.dir, name, self.ctx.redact)
        self.ctx.sessions.append(s)
        return s

    def auth_status(self):
        self.install_settings()
        try:
            p = subprocess.run([self.ctx.claude_bin, "auth", "status"], cwd=self.cwd, env=self.env(), stdin=subprocess.DEVNULL,
                               capture_output=True, text=True, timeout=30)
        except subprocess.TimeoutExpired:
            return {"rc": None, "json": None, "stdout": "", "stderr": "timed out after 30 s"}
        try:
            j = json.loads(p.stdout)
        except ValueError:
            j = None
        return {"rc": p.returncode, "json": j, "stdout": self.ctx.redact(p.stdout[-3000:]), "stderr": self.ctx.redact(p.stderr[-2000:])}

    def hooks(self, event=None, after=0.0):
        return [e for e in h.read_jsonl(self.hooks_log) if (event is None or e.get("event") == event) and e.get("ts", 0) >= after]

    def mcp(self):
        return h.read_jsonl(self.mcp_log)

    def tool_calls(self, name=None, after=0.0):
        out = []
        for e in self.mcp():
            m = e.get("msg") or {}
            if e.get("dir") == "in" and m.get("method") == "tools/call" and e.get("ts", 0) >= after:
                if name is None or (m.get("params") or {}).get("name") == name:
                    out.append(e)
        return out

    def transcript(self, sid):
        """The session file: SessionStart's transcript_path, else a search under projects/."""
        for e in self.hooks("SessionStart"):
            p = (e.get("input") or {}).get("transcript_path")
            if p and os.path.basename(p).startswith(sid):
                return p
        found = glob.glob(os.path.join(self.config, "projects", "*", f"{sid}.jsonl"))
        return found[0] if found else None


def started(ctx, s):
    """True if the process came up: it printed system/init, or it is still running 2 s after its
    first stdout line (or after `startup_timeout` with none: it may wait for input silently). False
    if it exited, e.g. with an error result for a session it can't find."""
    first = s.wait_for(lambda o: True, ctx.startup_timeout)
    if first and is_init(first["obj"]):
        return True
    return s.wait_exit(2) is None or bool(s.wait_for(is_init, 0.1))


def start_resume(ctx, ws, sid, transcript, name, **kw):
    """`--resume <transcript path>` as the runner does; if that doesn't start, `--resume <session id>`."""
    attempts = []
    for how, value in (("path", transcript), ("session_id", sid)):
        if not value:
            continue
        s = ws.start(("resume", value), f"{name}-by-{how}", **kw)
        ok = started(ctx, s)
        attempts.append({"resume_by": how, "started": ok, "rc": s.p.poll(), "stderr_tail": s.stderr_tail(600) if not ok else ""})
        if ok:
            return s, attempts
        s.finish(5)
    return None, attempts


def last_text(objs):
    for o in reversed(objs):
        if o.get("type") == "assistant":
            for b in (o.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                    return b["text"].strip()[:200]
    return None


def api_errors(objs):
    return [pick(o, "subtype", "error", "error_status", "attempt") for o in objs
            if o.get("type") == "system" and o.get("subtype") == "api_retry"]


def auth_rejected(objs):
    """The API refused the token (then no probe that needs a model turn can conclude anything)."""
    for o in objs:
        if o.get("type") == "system" and o.get("subtype") == "api_retry" and (o.get("error") == "authentication_failed" or o.get("error_status") == 401):
            return True
        if is_result(o) and o.get("is_error") and "authenticat" in str(o.get("result", "")).lower():
            return True
    return False


def no_turn(what, objs):
    return what + (" (the API rejected the token)" if auth_rejected(objs) else "")


def wait_call_or_end(ctx, ws, s, name):
    """Wait for an MCP tools/call of `name`, but stop as soon as the turn ended or the process exited."""
    def check():
        if s.wait_for(is_result, 0) or s.p.poll() is not None:
            return ws.tool_calls(name) or "ended"
        return ws.tool_calls(name)
    return h.wait_until(check, ctx.turn_timeout)


def result_view(o):
    return pick(o or {}, "subtype", "is_error", "stop_reason", "terminal_reason", "num_turns", "total_cost_usd", "result",
                "deferred_tool_use", "errors")


def transcript_tail(path, n=6):
    rows = h.read_jsonl(path) if path else []
    out = []
    for r in rows[-n:]:
        content = (r.get("message") or {}).get("content")
        blocks = [pick(b, "type", "name", "id", "tool_use_id") for b in content if isinstance(b, dict)] if isinstance(content, list) else None
        out.append({"type": r.get("type"), "subtype": r.get("subtype"), "blocks": blocks})
    return out


# ---------------------------------------------------------------------------------- baseline session
def run_baseline(ctx):
    ws = ctx.workspace("baseline", cwd=ctx.temp_cwd("baseline", "cwd.nest_probe"))  # '.' and '_' exercise the encoding
    b = {"ws": ws, "auth": ws.auth_status(), "sid": str(uuid.uuid4())}
    s = ws.start(("session-id", b["sid"]), "baseline")
    init = s.wait_for(is_init, ctx.init_wait)  # nothing written to stdin yet
    b["init_before_input"] = init is not None
    b["init_wait_s"] = round(init["ts"] - s.t0, 3) if init else None
    b["stdout_before_input"] = [pick(e["obj"] or {}, "type", "subtype", "hook_event") for e in s.entries()]
    sent_at = time.time()
    s.send_user(BASELINE_PROMPT)
    if init is None:
        init = s.wait_for(is_init, ctx.startup_timeout)
    res = s.wait_for(is_result, ctx.turn_timeout)
    b["rc"] = s.finish()
    b.update(session=s, init_entry=init, init=init["obj"] if init else None, result=res["obj"] if res else None, sent_at=sent_at)
    return b


# ---------------------------------------------------------------------------------- 1. auth
def probe_auth(ctx, n, key, title):
    b = ctx.baseline()
    a, init, res = b["auth"], b["init"] or {}, b["result"] or {}
    j = a.get("json") or {}
    errs = api_errors(b["session"].objs())
    checks = {
        "auth_status_exit_0": a.get("rc") == 0,
        "authMethod_oauth_token": j.get("authMethod") == "oauth_token",
        "configDirectory_is_CLAUDE_CONFIG_DIR": j.get("configDirectory") == b["ws"].config,
        "managed_forceLoginMethod_in_effect": j.get("forcedLoginMethod", "claudeai") == "claudeai",
        "init_apiKeySource_none": init.get("apiKeySource") == "none",
        "turn_succeeded": res.get("subtype") == "success" and not res.get("is_error"),
    }
    ev = {"checks": checks, "auth_status_keys": sorted(j), "auth_status": j or {"stdout": a.get("stdout"), "stderr": a.get("stderr")},
          "init_apiKeySource": init.get("apiKeySource"), "result": result_view(res), "api_retries": errs[:5],
          "managed_settings": "/etc/claude-code/managed-settings.json (protocol/claude-code/managed-settings.json, hooks → hook_logger.py)"}
    if all(checks.values()):
        return h.result(n, key, title, PASS, f"Token accepted under forceLoginMethod=claudeai (forcedLoginMethod={j.get('forcedLoginMethod')!r}); "
                        f"auth status has authMethod=oauth_token and configDirectory=CLAUDE_CONFIG_DIR; init apiKeySource=none; the turn succeeded.", ev)
    bad = [k for k, v in checks.items() if not v]
    why = " (the API rejected the token: " + ", ".join(sorted({str(e.get('error')) for e in errs})) + ")" if errs and not checks["turn_succeeded"] else ""
    return h.result(n, key, title, FAIL, f"Failed checks: {', '.join(bad)}{why}.", ev)


# ---------------------------------------------------------------------------------- 2. init order
def probe_init_order(ctx, n, key, title):
    b = ctx.baseline()
    s, ws = b["session"], b["ws"]
    init_ts = b["init_entry"]["ts"] if b["init_entry"] else None
    kinds = lambda xs: [x.get("subtype") or x.get("type") for x in xs]
    before = [pick(e["obj"] or {}, "type", "subtype", "hook_event") for e in s.entries() if init_ts and e["ts"] < init_ts]
    hooks_before = [x["event"] for x in ws.hooks() if init_ts and x.get("ts", 0) < init_ts]
    hooks_before_input = [x["event"] for x in ws.hooks() if x.get("ts", 0) < b["sent_at"]]
    # With --include-hook-events and no input at all (no model request): what reaches stdout?
    ws2 = ctx.workspace("init_order_hook_events")
    s2 = ws2.start(("session-id", str(uuid.uuid4())), "include-hook-events", extra=["--include-hook-events"])
    s2.wait_for(is_init, ctx.init_wait)
    s2.finish()
    stream2 = [pick(e["obj"] or {}, "type", "subtype", "hook_event") for e in s2.entries()]
    ev = {"init_before_any_input": b["init_before_input"], "init_after_spawn_s": b["init_wait_s"], "waited_without_input_s": ctx.init_wait,
          "init_after_first_input_s": round(init_ts - b["sent_at"], 3) if init_ts and not b["init_before_input"] else None,
          "stdout_before_first_input": b["stdout_before_input"], "stdout_before_init": before,
          "hook_events_before_init": hooks_before, "hook_events_before_first_input": hooks_before_input,
          "include_hook_events_without_input": stream2[:12]}
    if b["init_before_input"]:
        return h.result(n, key, title, PASS, f"system/init arrived {b['init_wait_s']} s after spawn with nothing written to stdin; hooks before it: "
                        f"{hooks_before or 'none'}; stdout before it: {kinds(before) or 'nothing'}.", ev)
    if init_ts:
        return h.result(n, key, title, FAIL, f"No system/init in {ctx.init_wait:g} s without input; it came {ev['init_after_first_input_s']} s after the first "
                        f"user message. Before it, hooks ran ({hooks_before or 'none'}) and stdout carried {kinds(before) or 'nothing'}.", ev)
    return h.result(n, key, title, INCONCLUSIVE, "No system/init at all from the baseline session.", ev)


# ---------------------------------------------------------------------------------- 3. user message shape
def probe_user_shape(ctx, n, key, title):
    b = ctx.baseline()
    s, res = b["session"], b["result"] or {}
    sent = s.sent[0]["obj"] if s.sent else None
    objs = s.objs()
    ev = {"stdin_line": sent, "has_session_id": bool(sent and "session_id" in sent), "result": result_view(res),
          "assistant_messages": sum(1 for o in objs if o.get("type") == "assistant"), "last_text": last_text(objs),
          "api_retries": api_errors(objs)[:3], "stderr_tail": s.stderr_tail(800)}
    if res.get("subtype") == "success" and not res.get("is_error"):
        return h.result(n, key, title, PASS, "The runner's exact stdin line (no session_id) started a turn that completed successfully.", ev)
    if auth_rejected(objs):
        return h.result(n, key, title, INCONCLUSIVE, "The token was rejected, so the turn never reached the model; the shape can't be judged.", ev)
    return h.result(n, key, title, FAIL, f"The turn did not succeed: {result_view(res) or 'no result line'}.", ev)


# ---------------------------------------------------------------------------------- 4. _meta tool-use id
def find_value_paths(obj, needle, path=""):
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out += find_value_paths(v, needle, f"{path}/{k}" if path else k)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += find_value_paths(v, needle, f"{path}[{i}]")
    elif obj == needle:
        out.append(path)
    return out


def probe_meta_tool_use_id(ctx, n, key, title):
    b = ctx.baseline()
    ws, objs = b["ws"], b["session"].objs()
    calls = ws.tool_calls("echo")
    pre = ws.hooks("PreToolUse")
    stream_ids = [u.get("id") for u in h.tool_uses(objs) if u.get("name") == "mcp__nest__echo"]
    pre_ids = [(x.get("input") or {}).get("tool_use_id") for x in pre]
    ev = {"tools_call_requests": [c["msg"] for c in calls[:2]], "pre_tool_use_tool_use_ids": pre_ids,
          "stream_tool_use_ids": stream_ids, "pre_tool_use_matches_stream": bool(pre_ids) and pre_ids[:len(stream_ids)] == stream_ids,
          "bridge_reads": h.BRIDGE_META_KEYS}
    if not calls:
        return h.result(n, key, title, INCONCLUSIVE, no_turn("The model made no mcp__nest__echo call, so there was no tools/call to inspect", objs) + ".", ev)
    params = calls[0]["msg"].get("params") or {}
    meta = params.get("_meta")
    want = (stream_ids or pre_ids or [None])[0]
    paths = find_value_paths(meta, want) if (meta and want) else []
    ev.update(meta=meta, tool_use_id=want, meta_paths_with_tool_use_id=paths)
    if paths:
        k = paths[0]
        if k in h.BRIDGE_META_KEYS:
            return h.result(n, key, title, PASS, f"tools/call carries the tool-use id in _meta[{k!r}], which `nest mcp` reads; PreToolUse tool_use_id matches: {ev['pre_tool_use_matches_stream']}.", ev)
        return h.result(n, key, title, FAIL, f"The id is in _meta at {k!r}, which `nest mcp` doesn't read (it reads {h.BRIDGE_META_KEYS}).", ev)
    return h.result(n, key, title, FAIL, f"No _meta key carries the tool-use id (_meta keys: {sorted(meta) if isinstance(meta, dict) else meta}); "
                    f"`nest mcp` will always fall back to hc_ ids. PreToolUse tool_use_id matches the stream: {ev['pre_tool_use_matches_stream']}.", ev)


# ---------------------------------------------------------------------------------- 5. --restricted + --tools
def probe_restricted_tools(ctx, n, key, title):
    b = ctx.baseline()
    tools = (b["init"] or {}).get("tools") or []
    builtins = [t for t in tools if not t.startswith("mcp__")]
    want = set(h.WORKER_BUILTIN_TOOLS)
    missing, extra = sorted(want - set(builtins)), sorted(set(builtins) - want)
    forbidden = sorted(set(builtins) & h.HOST_BUILTINS)
    renamed = {flag: init_name for flag, init_name in TOOL_ALIASES.items() if flag in missing and init_name in extra}
    missing, extra = [t for t in missing if t not in renamed], [t for t in extra if t not in renamed.values()]
    # Captain shape (--tools "" with --system-prompt-file). init needs a user message unless the
    # baseline showed it arrives without one; the turn is one word.
    ws2 = ctx.workspace("restricted_tools_captain")
    s2 = ws2.start(("session-id", str(uuid.uuid4())), "captain", tools=[], mode="replace")
    init2 = s2.wait_for(is_init, ctx.init_wait if b["init_before_input"] else 0)
    if not init2:
        s2.send_user(OK_PROMPT)
        init2 = s2.wait_for(is_init, ctx.startup_timeout)
        s2.wait_for(is_result, ctx.turn_timeout)
    s2.finish()
    tools2 = (init2["obj"].get("tools") if init2 else None)
    builtins2 = [t for t in tools2 or [] if not t.startswith("mcp__")]
    ev = {"tools_flag": ",".join(h.WORKER_BUILTIN_TOOLS), "init_tools": tools, "missing": missing, "extra": extra, "renamed": renamed,
          "host_builtins_present": forbidden, "mcp_tools": [t for t in tools if t.startswith("mcp__")],
          "init_permissionMode": (b["init"] or {}).get("permissionMode"),
          "captain": {"init_seen": init2 is not None, "init_tools": tools2, "builtins": builtins2}}
    if not b["init"]:
        return h.result(n, key, title, INCONCLUSIVE, "No system/init from the baseline session.", ev)
    ok = not missing and not extra and not forbidden and (init2 is None or not builtins2)
    cap = "captain --tools \"\" gave no built-ins" if init2 and not builtins2 else (
        f"captain --tools \"\" gave {builtins2}" if init2 else "captain variant: no system/init")
    ren = f" (init names {', '.join(f'{a} as {b}' for a, b in renamed.items())})" if renamed else ""
    if ok:
        return h.result(n, key, title, PASS, f"init.tools built-ins are exactly the --tools list{ren}; {cap}.", ev)
    return h.result(n, key, title, FAIL, f"Built-ins differ from --tools: missing {missing}, extra {extra}, host-side {forbidden}{ren}; {cap}.", ev)


# ---------------------------------------------------------------------------------- 6. cancel on interrupt
def probe_cancel(ctx, n, key, title):
    ws = ctx.workspace("cancel")
    s = ws.start(("session-id", str(uuid.uuid4())), "cancel")
    s.send_user(SLEEP_PROMPT.replace(" When it returns, reply with the single word DONE.", " Do not call any other tool."))
    call = wait_call_or_end(ctx, ws, s, "sleep")
    init = s.wait_for(is_init, 0)
    ev = {"capabilities": (init["obj"].get("capabilities") if init else None)}
    if not isinstance(call, list):
        res = s.wait_for(is_result, 1)
        s.finish()
        ev.update(result=result_view(res["obj"] if res else None), api_retries=api_errors(s.objs())[:3])
        return h.result(n, key, title, INCONCLUSIVE, no_turn("The model never called mcp__nest__sleep, so there was nothing to interrupt", s.objs()) + ".", ev)
    time.sleep(1.0)
    mark, t_int = len(s.entries()), time.time()
    s.send_interrupt("req_probe_interrupt")
    ack = s.wait_for(lambda o: o.get("type") == "control_response", 30, start=mark)
    cancelled = h.wait_until(lambda: [e for e in ws.mcp() if (e.get("msg") or {}).get("method") == "notifications/cancelled"], 20)
    res = s.wait_for(is_result, 30, start=mark)
    s.finish()
    rid = call[0]["msg"].get("id")
    cmsg = cancelled[0]["msg"] if cancelled else None
    ev.update(tools_call=call[0]["msg"], interrupt=s.sent[-1]["obj"], control_response=ack["obj"] if ack else None,
              cancelled_notification=cmsg, cancel_latency_s=round(cancelled[0]["ts"] - t_int, 3) if cancelled else None,
              result=result_view(res["obj"] if res else None),
              server_log=[pick(e, "event", "request_id", "was_running") for e in ws.mcp() if e.get("event")])
    if cmsg and (cmsg.get("params") or {}).get("requestId") == rid:
        return h.result(n, key, title, PASS, f"notifications/cancelled for request {rid} reached the MCP server {ev['cancel_latency_s']} s after the interrupt "
                        f"(reason {(cmsg.get('params') or {}).get('reason')!r}); control_response: {bool(ack)}; result: {ev['result'].get('subtype')}.", ev)
    if cmsg:
        return h.result(n, key, title, FAIL, f"A cancellation arrived but for request {(cmsg.get('params') or {}).get('requestId')!r}, not {rid!r}.", ev)
    return h.result(n, key, title, FAIL, f"No notifications/cancelled within 20 s of the interrupt (control_response: {bool(ack)}, result: {ev['result'] or None}).", ev)


# ---------------------------------------------------------------------------------- 7. env scrub
HOOK_NEST = ["NEST_AGENT_ID", "NEST_HOOK_DGRAM", "NEST_HOOK_SOCK", "NEST_HOOK_SPOOL"]
MCP_NEST = ["NEST_AGENT_ID", "NEST_MCP_SOCK"]


def env_view(env, token_hash):
    names = set(env.get("names") or [])
    return {"nest": sorted(k for k in names if k.startswith("NEST_")),
            "token_by_name": "CLAUDE_CODE_OAUTH_TOKEN" in names,
            "token_by_value": token_hash in (env.get("sha256_16") or {}).values(),
            "CLAUDE_CONFIG_DIR": "CLAUDE_CONFIG_DIR" in names, "count": len(names)}


def scrub_observation(ws, token_hash):
    by_event = {}
    for x in ws.hooks():
        by_event.setdefault(x["event"], env_view(x.get("env") or {}, token_hash))
    starts = [e for e in ws.mcp() if e.get("event") == "start"]
    mcp = env_view(starts[0].get("env") or {}, token_hash) if starts else None
    return by_event, mcp


def probe_env_scrub(ctx, n, key, title):
    b = ctx.baseline()
    th = h.sha16(ctx.token)
    hooks, mcp = scrub_observation(b["ws"], th)
    # Same, without CLAUDE_CODE_MCP_ALLOWLIST_ENV, to see the scrub alone on the MCP server (no input, no model request).
    ws2 = ctx.workspace("env_scrub_no_allowlist")
    s2 = ws2.start(("session-id", str(uuid.uuid4())), "no-allowlist", env_extra={"CLAUDE_CODE_MCP_ALLOWLIST_ENV": None})
    h.wait_until(lambda: [e for e in ws2.mcp() if e.get("event") == "start"], ctx.init_wait)
    time.sleep(1)
    s2.finish()
    hooks2, mcp2 = scrub_observation(ws2, th)
    warnings = [l.strip() for l in b["session"].stderr_tail(4000).splitlines() if "SUBPROCESS_ENV_SCRUB" in l]
    ev = {"hooks": hooks, "mcp_server": mcp, "without_mcp_allowlist": {"hooks": hooks2, "mcp_server": mcp2 or "not started without input"},
          "expected_in_hooks": HOOK_NEST, "expected_in_mcp (config env)": MCP_NEST, "bubblewrap": ctx.bwrap_info,
          "init_permissionMode": (b["init"] or {}).get("permissionMode"), "stderr_scrub_warnings": warnings}
    if not hooks and not mcp:
        return h.result(n, key, title, INCONCLUSIVE, "Neither a hook nor the MCP server ran.", ev)
    problems = []
    if ctx.bwrap_info.get("required") and "SCRUB" in ctx.bwrap_info.get("deviation", ""):
        problems.append("Claude Code refuses CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 without bubblewrap and none was available, so the scrub ran off")
    for ev_name, v in hooks.items():
        miss = [k for k in HOOK_NEST if k not in v["nest"]]
        if miss:
            problems.append(f"{ev_name} hook lacks {miss}")
        if v["token_by_name"] or v["token_by_value"]:
            problems.append(f"{ev_name} hook sees the OAuth token")
    if mcp:
        miss = [k for k in MCP_NEST if k not in mcp["nest"]]
        if miss:
            problems.append(f"MCP server lacks {miss}")
        if mcp["token_by_name"] or mcp["token_by_value"]:
            problems.append("MCP server sees the OAuth token")
    else:
        problems.append("the MCP server never started")
    bw = ctx.bwrap_info
    note = (("Claude Code needs bubblewrap for the scrub (without it: " + repr(bw.get("preflight_auth_status", {}).get("stderr")) + "). ") if bw.get("required") else "") + \
           (f"init permissionMode: {ev['init_permissionMode']!r}{' (' + warnings[0] + ')' if warnings else ''}. ") + \
           (f"Without the MCP allowlist the MCP server gets NEST_* {mcp2['nest']}. " if mcp2 else "") + \
           f"CLAUDE_CONFIG_DIR in hooks: {sorted({v['CLAUDE_CONFIG_DIR'] for v in hooks.values()})}."
    if problems:
        return h.result(n, key, title, FAIL, "; ".join(problems) + ". " + note, ev)
    return h.result(n, key, title, PASS, f"Hooks ({', '.join(sorted(hooks))}) keep {HOOK_NEST}; the MCP server keeps its config env {MCP_NEST}; "
                    f"neither sees the token. " + note, ev)


# ---------------------------------------------------------------------------------- 8. transcript path
def path_view(cfg, cwd, sid, observed):
    enc = os.path.basename(os.path.dirname(observed)) if observed else None
    doc = h.encode_documented(cwd)
    v = {"cwd": cwd, "cwd_len": len(cwd), "observed": observed, "encoded_dir": enc, "encoded_len": len(enc) if enc else None,
         "documented_rule": f"{cfg}/projects/{doc}/{sid}.jsonl", "nest_formula": f"{cfg}/projects/{h.encode_nest(cwd)}/{sid}.jsonl",
         "file_exists": bool(observed) and os.path.exists(observed)}
    v["matches_documented_rule"] = observed == v["documented_rule"]
    v["matches_nest_formula"] = observed == v["nest_formula"]
    if enc and not v["matches_documented_rule"]:
        k = h.common_prefix_len(enc, doc)
        v.update(common_prefix_with_rule=k, rest_after_prefix=enc[k:], hash_guess=h.identify_suffix(cwd, enc[k:]))
    return v


def session_start_path(ws):
    for e in ws.hooks("SessionStart"):
        i = e.get("input") or {}
        if i.get("transcript_path"):
            return i["transcript_path"], i.get("cwd")
    return None, None


def probe_transcript_path(ctx, n, key, title):
    b = ctx.baseline()
    obs, cwd = session_start_path(b["ws"])
    short = path_view(b["ws"].config, cwd or b["ws"].cwd, b["sid"], obs)
    seg = "/seg.dir_0123456789-abcdefghij"
    long_cwd = ctx.temp_cwd("long", *([seg.strip("/")] * 8))
    ws = ctx.workspace("transcript_path_long", cwd=long_cwd)
    sid = str(uuid.uuid4())
    s = ws.start(("session-id", sid), "long-cwd")
    got = h.wait_until(lambda: ws.hooks("SessionStart"), ctx.startup_timeout)
    turned = False
    if not got:  # SessionStart may wait for the first message
        s.send_user(OK_PROMPT)
        turned = True
        s.wait_for(is_result, ctx.turn_timeout)
    s.finish()
    obs2, cwd2 = session_start_path(ws)
    long = path_view(ws.config, cwd2 or long_cwd, sid, obs2)
    long["turn_sent"] = turned
    prod = "/var/lib/nest/empty"
    ev = {"short": short, "long": long, "production_cwd_rules_agree": h.encode_documented(prod) == h.encode_nest(prod)}
    if not obs:
        return h.result(n, key, title, INCONCLUSIVE, "No SessionStart transcript_path in the baseline session.", ev)
    long_note = ("long cwd: no SessionStart" if not obs2 else
                 "long cwd follows the same rule" if long["matches_documented_rule"] else
                 f"long cwd ({long['cwd_len']} chars) → {long['encoded_len']}-char directory: first {long.get('common_prefix_with_rule')} chars follow the rule, "
                 f"then {long.get('rest_after_prefix')!r} (hash: {long.get('hash_guess') or 'unidentified'})")
    nest_note = "" if short["matches_nest_formula"] else " `claude::project_dir` differs for this cwd."
    if short["matches_documented_rule"]:
        return h.result(n, key, title, PASS, f"Non-alphanumerics become '-' ({short['encoded_dir']}); {long_note}.{nest_note}", ev)
    return h.result(n, key, title, FAIL, f"Observed {short['observed']}, expected {short['documented_rule']}; {long_note}.", ev)


# ---------------------------------------------------------------------------------- 9. resume + defer
def resume_interrupted(ctx):
    ws = ctx.workspace("resume_interrupted")
    env = {"CLAUDE_CODE_RESUME_INTERRUPTED_TURN": "1"}
    sid = str(uuid.uuid4())
    s = ws.start(("session-id", sid), "run1", env_extra=env)
    s.send_user(SLEEP_PROMPT)
    call = wait_call_or_end(ctx, ws, s, "sleep")
    ev = {}
    if not isinstance(call, list):
        s.finish()
        ev["api_retries"] = api_errors(s.objs())[:3]
        return INCONCLUSIVE, no_turn("the model never called mcp__nest__sleep, so there was no turn to cut off", s.objs()), ev
    time.sleep(2.0)  # the transcript is written asynchronously
    s.kill()  # SIGKILL the process group mid tool call, like a host crash
    t_kill = time.time()
    open(os.path.join(ws.state, "fast"), "w").close()  # a re-run sleep returns at once
    first_ids = [(x.get("input") or {}).get("tool_use_id") for x in ws.hooks("PreToolUse")]
    path = ws.transcript(sid)
    ev.update(cut_off_tool_use_id=first_ids[:1], transcript=path, transcript_tail_after_kill=transcript_tail(path))
    s2, attempts = start_resume(ctx, ws, sid, path, "run2-resume", env_extra=env)
    ev["resume_attempts"] = attempts
    if not s2:
        return FAIL, "the resumed process didn't start", ev
    act = s2.wait_for(lambda o: o.get("type") in ("assistant", "result"), 45)
    if act:
        s2.wait_for(is_result, ctx.turn_timeout)
    s2.finish()
    objs = s2.objs()
    res = next((o for o in reversed(objs) if is_result(o)), None)
    pre_after = [(x.get("input") or {}).get("tool_use_id") for x in ws.hooks("PreToolUse", after=t_kill)]
    ev.update(auto_continued=bool(act), first_activity=pick(act["obj"], "type", "subtype") if act else None,
              tool_calls_after_resume=[pick(c["msg"].get("params") or {}, "name", "arguments") for c in ws.tool_calls(after=t_kill)],
              pre_tool_use_after_resume=pre_after, reran_same_tool_use_id=bool(pre_after) and pre_after[0] in first_ids,
              result=result_view(res), last_text=last_text(objs))
    if act:
        rerun = ("re-ran the cut-off call with the same tool_use_id" if ev["reran_same_tool_use_id"] else
                 f"made {len(ev['tool_calls_after_resume'])} new tool call(s)" if ev["tool_calls_after_resume"] else "made no tool call")
        return PASS, f"after SIGKILL mid tool call, `--resume` with CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1 continued the turn without input ({rerun}; result {ev['result'].get('subtype')})", ev
    return FAIL, "after SIGKILL mid tool call, the resumed process did nothing for 45 s without a new user message", ev


def defer(ctx):
    ws = ctx.workspace("defer")
    ws.set_decisions({"PreToolUse": ["defer", "allow"]})
    sid = str(uuid.uuid4())
    s = ws.start(("session-id", sid), "run1")
    s.send_user(DEFER_PROMPT)
    res = s.wait_for(is_result, ctx.turn_timeout)
    rc = s.wait_exit(20)  # stdin is still open: does the process end on its own?
    exited = rc is not None
    if not exited:
        s.finish()
    t_resume = time.time()
    pre1 = ws.hooks("PreToolUse")
    deferred_ids = [(x.get("input") or {}).get("tool_use_id") for x in pre1 if ((x.get("output") or {}).get("hookSpecificOutput") or {}).get("permissionDecision") == "defer"]
    calls_before = ws.tool_calls("echo")
    ev = {"result": result_view(res["obj"] if res else None), "exited_with_stdin_open": exited, "exit_code": rc,
          "deferred_tool_use_ids": deferred_ids, "mcp_calls_before_resume": len(calls_before)}
    if not deferred_ids:
        ev["api_retries"] = api_errors(s.objs())[:3]
        return INCONCLUSIVE, no_turn("no PreToolUse fired for mcp__nest__echo, so nothing was deferred", s.objs()), ev
    path = ws.transcript(sid)
    ev.update(transcript=path, transcript_tail=transcript_tail(path))
    s2, attempts = start_resume(ctx, ws, sid, path, "run2-resume")
    ev["resume_attempts"] = attempts
    if not s2:
        return FAIL, "the resumed process didn't start", ev
    again = h.wait_until(lambda: ws.hooks("PreToolUse", after=t_resume), 45)
    needed_input = False
    if not again:
        needed_input = True
        s2.send_user("Continue.")
        again = h.wait_until(lambda: ws.hooks("PreToolUse", after=t_resume), ctx.turn_timeout)
    h.wait_until(lambda: ws.tool_calls("echo", after=t_resume), 15)
    res2 = s2.wait_for(is_result, ctx.turn_timeout)
    s2.finish()
    ids2 = [(x.get("input") or {}).get("tool_use_id") for x in again or []]
    calls_after = ws.tool_calls("echo", after=t_resume)
    ev.update(needed_user_message_to_resume=needed_input, pre_tool_use_ids_after_resume=ids2,
              same_tool_use_id=bool(ids2) and ids2[0] == deferred_ids[0],
              mcp_calls_after_resume=[pick(c["msg"].get("params") or {}, "name", "arguments") for c in calls_after],
              result_after_resume=result_view(res2["obj"] if res2 else None))
    r1 = ev["result"] or {}
    deferred_ok = r1.get("stop_reason") == "tool_deferred" or exited
    if deferred_ok and ev["same_tool_use_id"] and calls_after and not calls_before and not needed_input:
        return PASS, (f"defer ended the run (stop_reason {r1.get('stop_reason')!r}, exited with stdin open: {exited}); "
                      f"`--resume` re-fired PreToolUse for the same tool_use_id without input and the call ran"), ev
    bits = []
    if not deferred_ok:
        bits.append(f"defer didn't end the run (stop_reason {r1.get('stop_reason')!r}, still running)")
    if calls_before:
        bits.append("the deferred call ran before resume")
    if needed_input:
        bits.append("the resumed process waited for a user message before re-running the call")
    if not ev["same_tool_use_id"]:
        bits.append(f"PreToolUse after resume had ids {ids2}, not {deferred_ids[:1]}")
    if not calls_after:
        bits.append("the call never ran after resume")
    return FAIL, "; ".join(bits), ev


def probe_resume_defer(ctx, n, key, title):
    parts = {}
    for name, fn in (("resume_interrupted_turn", resume_interrupted), ("defer", defer)):
        try:
            st, summary, ev = fn(ctx)
        except Exception as e:  # noqa: BLE001
            st, summary, ev = INCONCLUSIVE, f"probe crashed: {type(e).__name__}: {e}", {"traceback": traceback.format_exc()[-2000:]}
        parts[name] = {"status": st, "summary": summary, "evidence": ev}
    sts = [p["status"] for p in parts.values()]
    status = FAIL if FAIL in sts else PASS if all(x == PASS for x in sts) else INCONCLUSIVE
    summary = " | ".join(f"{k}: {p['status']}: {p['summary']}" for k, p in parts.items())
    return h.result(n, key, title, status, summary, parts)


# ---------------------------------------------------------------------------------- 10. compaction
def compaction_observed(ws, s, start, t0):
    boundary = s.wait_for(lambda o: o.get("type") == "system" and o.get("subtype") == "compact_boundary", 1, start=start)
    hooks = ws.hooks(after=t0)
    return boundary, hooks, any(x["event"] in ("PreCompact", "PostCompact") for x in hooks)


def probe_compaction(ctx, n, key, title):
    ws = ctx.workspace("compaction")
    sid = str(uuid.uuid4())
    s = ws.start(("session-id", sid), "run1")
    s.send_user(OK_PROMPT)
    r1 = s.wait_for(is_result, ctx.turn_timeout)
    attempts = []
    ev = {"first_turn": result_view(r1["obj"] if r1 else None)}
    if not r1 or (r1["obj"].get("is_error")):
        s.finish()
        ev["api_retries"] = api_errors(s.objs())[:3]
        return h.result(n, key, title, INCONCLUSIVE, no_turn("The first turn failed, so there was nothing to compact", s.objs()) + ".", ev)

    def attempt(sess, label, line):
        mark, t0 = len(sess.entries()), time.time()
        sess.send(line)
        sess.wait_for(lambda o: is_result(o) or (o.get("type") == "system" and o.get("subtype") == "compact_boundary"), ctx.turn_timeout, start=mark)
        boundary, hooks, hooked = compaction_observed(ws, sess, mark, t0)
        if boundary or hooked:  # give the post-compaction SessionStart a moment
            h.wait_until(lambda: ws.hooks("SessionStart", after=t0), 15)
            boundary, hooks, hooked = compaction_observed(ws, sess, mark, t0)
        res = sess.wait_for(is_result, 5 if (boundary or hooked) else 0.5, start=mark)
        a = {"how": label, "compact_boundary": boundary["obj"] if boundary else None,
             "hooks_after": [{"event": x["event"], "source": (x.get("input") or {}).get("source"), "trigger": (x.get("input") or {}).get("trigger")} for x in hooks],
             "result": result_view(res["obj"] if res else None), "last_text": last_text(sess.objs()[-5:])}
        attempts.append(a)
        return bool(boundary) or hooked, a

    done, a = attempt(s, "stdin `/compact` (content blocks), nest flags incl. --disable-slash-commands", h.user_line("/compact"))
    s.finish()
    if not done:  # retry without --disable-slash-commands, plain-string content
        path = ws.transcript(sid)
        s2, starts = start_resume(ctx, ws, sid, path, "run2-slash-commands", drop=("--disable-slash-commands",))
        ev["resume_attempts"] = starts
        if s2:
            done, a = attempt(s2, "stdin `/compact` (string content), resumed without --disable-slash-commands",
                              {"type": "user", "message": {"role": "user", "content": "/compact"}, "parent_tool_use_id": None})
            s2.finish()
    ev["attempts"] = attempts
    if not done:
        return h.result(n, key, title, INCONCLUSIVE, "`/compact` over stdin didn't compact (no compact_boundary, no PreCompact/PostCompact), "
                        "with or without --disable-slash-commands; auto-compaction needs a near-full context, which isn't cheap.", ev)
    starts_after = [x for x in a["hooks_after"] if x["event"] == "SessionStart"]
    srcs = [x["source"] for x in starts_after]
    flag = "" if len(attempts) == 1 else " (only without --disable-slash-commands)"
    if "compact" in srcs:
        return h.result(n, key, title, PASS, f"After `/compact`{flag}, SessionStart fired with source 'compact'.", ev)
    return h.result(n, key, title, FAIL, f"Compaction happened{flag} but no SessionStart with source 'compact' followed (SessionStart sources: {srcs or 'none'}).", ev)


PROBES = {
    "auth": probe_auth, "init_order": probe_init_order, "user_shape": probe_user_shape, "meta_tool_use_id": probe_meta_tool_use_id,
    "restricted_tools": probe_restricted_tools, "cancel": probe_cancel, "env_scrub": probe_env_scrub,
    "transcript_path": probe_transcript_path, "resume_defer": probe_resume_defer, "compaction": probe_compaction,
}


def run_all(ctx, selected, log=print):
    results = []
    for n, key, title in ITEMS:
        if selected and key not in selected and str(n) not in selected:
            results.append(h.result(n, key, title, SKIPPED, "not selected (--only)"))
            continue
        log(f"[claude-verify] {n}. {title} …")
        t = time.time()
        try:
            r = PROBES[key](ctx, n, key, title)
        except Exception as e:  # noqa: BLE001
            r = h.result(n, key, title, INCONCLUSIVE, f"probe crashed: {type(e).__name__}: {e}", {"traceback": traceback.format_exc()[-3000:]})
        r["duration_s"] = round(time.time() - t, 1)
        log(f"[claude-verify] {n}. {r['status'].upper()}: {ctx.redact(r['summary'])}")
        results.append(r)
    return results

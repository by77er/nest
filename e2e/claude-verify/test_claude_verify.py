"""Tests for the claude-verify probe harness that need no token.

    python3 -m unittest discover -s e2e/claude-verify

The last test runs every probe end to end against stub_claude.py (in a private mount namespace);
it is skipped when unprivileged user namespaces are unavailable.
"""
import hashlib, json, os, queue, shutil, subprocess, sys, tempfile, threading, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import harness as h  # noqa: E402

PY = sys.executable


def slurp(path, mode="r"):
    with open(path, mode) as f:
        return f.read()


class Lines:
    """Line reader with a timeout over a subprocess's stdout."""

    def __init__(self, stream):
        self.q = queue.Queue()
        threading.Thread(target=self._pump, args=(stream,), daemon=True).start()

    def _pump(self, stream):
        for line in stream:
            self.q.put(line)
        self.q.put(None)

    def get(self, timeout=10):
        line = self.q.get(timeout=timeout)
        return json.loads(line) if line else None

    def empty_for(self, seconds):
        try:
            self.q.get(timeout=seconds)
            return False
        except queue.Empty:
            return True


class McpLoggerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "mcp.jsonl")
        self.p = subprocess.Popen([PY, os.path.join(HERE, "mcp_logger.py"), "--log", self.log, "--state-dir", self.dir],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                                  env={"PATH": "/usr/bin:/bin", "NEST_AGENT_ID": "agt_t", "NEST_MCP_SOCK": "/x.sock"})
        self.out = Lines(self.p.stdout)

    def tearDown(self):
        if self.p.poll() is None:
            self.p.kill()
            self.p.wait()
        for f in (self.p.stdin, self.p.stdout):
            try:
                f.close()
            except OSError:
                pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def send(self, msg):
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def close(self):
        self.p.stdin.close()
        self.p.wait(10)
        return h.read_jsonl(self.log)

    def test_framing_tools_and_full_request_logging(self):
        self.send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        r = self.out.get()
        self.assertEqual((r["id"], r["result"]["protocolVersion"]), (1, "2025-06-18"))
        self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual([t["name"] for t in self.out.get()["result"]["tools"]], ["echo", "sleep"])
        call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": {"name": "echo", "arguments": {"text": "hi"}, "_meta": {"claudecode/toolUseId": "toolu_1", "progressToken": 3}}}
        self.send(call)
        r = self.out.get()
        self.assertEqual(r["result"]["content"][0]["text"], "echo: hi")
        self.send({"jsonrpc": "2.0", "id": 4, "method": "nope"})
        self.assertEqual(self.out.get()["error"]["code"], -32601)
        self.send({"jsonrpc": "2.0", "id": 5, "method": "ping"})
        self.assertEqual(self.out.get(), {"jsonrpc": "2.0", "id": 5, "result": {}})
        self.p.stdin.write("not json\n")
        self.p.stdin.flush()
        self.assertEqual(self.out.get()["error"]["code"], -32700)
        log = self.close()
        start = log[0]
        self.assertEqual(start["event"], "start")
        self.assertEqual(start["env"]["nest"], {"NEST_AGENT_ID": "agt_t", "NEST_MCP_SOCK": "/x.sock"})
        inbound = [e["msg"] for e in log if e.get("dir") == "in" and "msg" in e]
        self.assertIn(call, inbound)  # the whole request, _meta included
        self.assertEqual(log[-1]["event"], "eof")

    def test_sleep_is_cancellable_and_gets_no_response(self):
        self.send({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "sleep", "arguments": {"seconds": 60}}})
        self.assertTrue(self.out.empty_for(0.3))
        self.send({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 7, "reason": "interrupted"}})
        self.assertTrue(self.out.empty_for(0.5))  # MCP: a cancelled request gets no response
        events = [e for e in self.close() if e.get("event")]
        cancel = next(e for e in events if e["event"] == "cancelled")
        self.assertEqual((cancel["request_id"], cancel["reason"], cancel["was_running"]), (7, "interrupted", True))
        self.assertIn("sleep_cancelled", [e["event"] for e in events])

    def test_sleep_fast_mode(self):
        open(os.path.join(self.dir, "fast"), "w").close()
        self.send({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "sleep", "arguments": {"seconds": 60}}})
        self.assertIn("fast mode", self.out.get(timeout=5)["result"]["content"][0]["text"])


class HookLoggerTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "hooks.jsonl")
        self.decisions = os.path.join(self.dir, "decisions.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_hook(self, data, env=None):
        p = subprocess.run([PY, os.path.join(HERE, "hook_logger.py"), self.log, self.decisions], input=json.dumps(data),
                           capture_output=True, text=True, env=env or {"PATH": "/usr/bin:/bin"}, timeout=10)
        self.assertEqual(p.returncode, 0)
        return json.loads(p.stdout) if p.stdout.strip() else None

    def test_pre_tool_use_allows_by_default_and_logs_input_and_env(self):
        env = {"PATH": "/usr/bin:/bin", "NEST_HOOK_SOCK": "/run/h.sock", "SECRETISH": "tok-123456789"}
        out = self.run_hook({"hook_event_name": "PreToolUse", "tool_use_id": "toolu_9"}, env)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "allow")
        e = h.read_jsonl(self.log)[0]
        self.assertEqual((e["event"], e["input"]["tool_use_id"]), ("PreToolUse", "toolu_9"))
        self.assertEqual(e["env"]["nest"], {"NEST_HOOK_SOCK": "/run/h.sock"})
        self.assertFalse(e["env"]["present"]["CLAUDE_CODE_OAUTH_TOKEN"])
        self.assertIn(h.sha16("tok-123456789"), e["env"]["sha256_16"].values())  # spotted by hash, never written
        self.assertNotIn("tok-123456789", slurp(self.log))

    def test_decision_sequence_then_last_repeats(self):
        with open(self.decisions, "w") as f:
            json.dump({"PreToolUse": ["defer", "allow"]}, f)
        got = [self.run_hook({"hook_event_name": "PreToolUse"})["hookSpecificOutput"]["permissionDecision"] for _ in range(3)]
        self.assertEqual(got, ["defer", "allow", "allow"])

    def test_object_entries_print_verbatim_and_tool_keys_win(self):
        ctx = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "inbox"}}
        block = {"decision": "block", "reason": "more"}
        with open(self.decisions, "w") as f:
            json.dump({"PostToolUse:mcp__nest__echo": [ctx, None], "Stop": [block, None]}, f)
        post = lambda tool: self.run_hook({"hook_event_name": "PostToolUse", "tool_name": tool})
        self.assertIsNone(post("TaskList"))  # no key for this tool, no plain PostToolUse key
        self.assertEqual([post("mcp__nest__echo"), post("mcp__nest__echo")], [ctx, None])
        self.assertEqual([self.run_hook({"hook_event_name": "Stop"}) for _ in range(3)], [block, None, None])

    def test_other_events_print_nothing(self):
        self.assertIsNone(self.run_hook({"hook_event_name": "SessionStart", "source": "startup"}))
        self.assertEqual(h.read_jsonl(self.log)[0]["event"], "SessionStart")


class HarnessTest(unittest.TestCase):
    def test_nest_args_match_the_rust_golden(self):
        # crates/nest-protocol/src/host.rs: worker_args_golden
        got = h.nest_args(h.WORKER_BUILTIN_TOOLS, "/var/lib/nest/agents/agt_w", ("session-id", "0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69"))
        self.assertEqual(got, [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--restricted", "--tools", "Agent,TaskCreate,TaskGet,TaskUpdate,TaskList,TodoWrite,WebSearch,WebFetch",
            "--strict-mcp-config", "--mcp-config", "/var/lib/nest/agents/agt_w/nest-mcp.json",
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--allowedTools", "mcp__nest__*,Agent,TaskCreate,TaskGet,TaskUpdate,TaskList,TodoWrite,WebSearch,WebFetch",
            "--disable-slash-commands", "--append-system-prompt-file", "/var/lib/nest/agents/agt_w/nest-system-prompt.md",
            "--session-id", "0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69"])
        cap = h.nest_args([], "/c", ("resume", "/c/p.jsonl"), model="haiku", mode="replace", drop=("--disable-slash-commands",))
        self.assertEqual(cap[cap.index("--tools") + 1], "")
        self.assertIn("--system-prompt-file", cap)
        self.assertNotIn("--disable-slash-commands", cap)
        self.assertEqual(cap[-4:], ["--model", "haiku", "--resume", "/c/p.jsonl"])

    def test_env_is_explicit(self):
        env = h.nest_env("/cfg", "tok", "/tmp/x", "agt_1", "/run", extra={"CLAUDE_CODE_MCP_ALLOWLIST_ENV": None, "X": "1"})
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "tok")
        self.assertNotIn("CLAUDE_CODE_MCP_ALLOWLIST_ENV", env)
        self.assertFalse([k for k in env if k.startswith("ANTHROPIC_")])
        self.assertEqual(env["NEST_HOOK_SPOOL"], "/cfg/nest-hook-spool.jsonl")

    def test_managed_settings_rewrites_every_hook(self):
        s = h.managed_settings("LOG", bwrap="/opt/bwrap")
        ref = json.loads(slurp(os.path.join(h.PROTOCOL, "managed-settings.json")))
        self.assertEqual(s["forceLoginMethod"], "claudeai")
        self.assertEqual(s["sandbox"], {"bwrapPath": "/opt/bwrap"})
        self.assertEqual(set(s["hooks"]), set(ref["hooks"]))
        for ev, groups in s["hooks"].items():
            for g, rg in zip(groups, ref["hooks"][ev]):
                for hk, rh in zip(g["hooks"], rg["hooks"]):
                    self.assertEqual(hk["command"], "LOG")
                    self.assertEqual({k: v for k, v in hk.items() if k != "command"}, {k: v for k, v in rh.items() if k != "command"})
        s2 = h.managed_settings(lambda c: c.replace("/usr/lib/nest/nest", "/b/nest"))
        self.assertEqual(s2["hooks"]["PreToolUse"][0]["hooks"][0]["command"], "/b/nest hook --sync")
        self.assertNotIn("sandbox", s2)

    def test_transcript_encodings_and_hash_guess(self):
        self.assertEqual(h.encode_documented("/a/b.c_d"), "-a-b-c-d")
        self.assertEqual(h.encode_nest("/a/b.c_d"), "-a-b-c-d")
        cwd = "/tmp/" + "x.y_" * 60
        hsh = 0
        for ch in cwd:
            hsh = (31 * hsh + ord(ch)) & 0xFFFFFFFF
        hsh = abs(hsh - (1 << 32) if hsh >= (1 << 31) else hsh)
        self.assertEqual(h.identify_suffix(cwd, "-" + h.to_base36(hsh)), "java_hashcode_abs_base36")
        self.assertEqual(h.identify_suffix(cwd, "-" + hashlib.sha256(cwd.encode()).hexdigest()[:8]), "sha256_hex")
        self.assertIsNone(h.identify_suffix(cwd, "-zzzzzzzz"))
        # The observed sample from e2e/claude-verify (a 266-character cwd), mirrored by `claude::project_dir`.
        self.assertEqual(h.encode_nest(cwd), h.encode_documented(cwd)[:200] + "-" + h.to_base36(hsh))

    def test_redactor(self):
        r = h.Redactor("sk-ant-oat01-secret")
        self.assertEqual(r("a sk-ant-oat01-secret b"), "a <redacted> b")
        d = tempfile.mkdtemp()
        try:
            p = os.path.join(d, "f.bin")
            with open(p, "wb") as f:
                f.write(b"\x00head sk-ant-oat01-secret tail\x00")
            self.assertEqual(r.scrub_tree(d), [p])
            data = slurp(p, "rb")
            self.assertEqual(len(data), len(b"\x00head sk-ant-oat01-secret tail\x00"))
            self.assertNotIn(b"secret", data)
        finally:
            shutil.rmtree(d)

    def test_report(self):
        d = tempfile.mkdtemp()
        try:
            res = [h.result(1, "auth", "Auth", h.PASS, "ok with tok-SECRET-1234", {"x": "tok-SECRET-1234"}),
                   h.result(2, "x", "Pipe | title", h.FAIL, "bad | thing", {"big": "y" * 10000})]
            jp, mp = h.write_report(d, {"claude_version": "1.0", "model": "haiku"}, res, h.Redactor("tok-SECRET-1234"))
            doc = json.loads(slurp(jp))
            self.assertEqual([r["status"] for r in doc["results"]], ["pass", "fail"])
            self.assertEqual(set(doc["results"][0]), {"n", "item", "title", "status", "summary", "evidence"})
            md = slurp(mp)
            self.assertNotIn("tok-SECRET-1234", slurp(jp) + md)
            self.assertIn("| 2 | Pipe | title | **fail** | bad \\| thing |", md)
            self.assertIn("more characters in report.json", md)
            self.assertEqual(h.exit_code(res), 1)
            self.assertEqual(h.exit_code(res[:1] + [h.result(3, "y", "Y", h.INCONCLUSIVE, "?")]), 0)
        finally:
            shutil.rmtree(d)


def userns_available():
    if not shutil.which("unshare"):
        return False
    return subprocess.run(["unshare", "--user", "--map-root-user", "--mount", "true"], capture_output=True).returncode == 0


class RunTest(unittest.TestCase):
    def test_skips_without_token(self):
        work = tempfile.mkdtemp()
        shutil.rmtree(work)
        env = {k: v for k, v in os.environ.items() if k != h.TOKEN_ENV}
        p = subprocess.run([PY, os.path.join(HERE, "run.py"), "--work", work], capture_output=True, text=True, env=env, timeout=30)
        self.assertEqual(p.returncode, 2)
        self.assertIn("SKIPPED", p.stderr)
        self.assertIn(h.TOKEN_ENV, p.stderr)
        self.assertFalse(os.path.exists(work))

    def run_stub(self, work, token, claude=os.path.join(HERE, "stub_claude.py"), only=()):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("ANTHROPIC_", "CLAUDE_"))}
        env.update({h.TOKEN_ENV: token, "NEST_CLAUDE_BIN": claude, "NEST_CLAUDE_BWRAP": "/bin/true",
                    "NEST_CLAUDE_INIT_WAIT_S": "1", "NEST_CLAUDE_TURN_TIMEOUT_S": "20"})
        argv = [PY, os.path.join(HERE, "run.py"), "--work", work] + (["--only", ",".join(only)] if only else [])
        p = subprocess.run(argv, capture_output=True, text=True, env=env, timeout=300)
        doc = json.loads(slurp(os.path.join(work, "report.json")))
        return p, doc, {r["item"]: r for r in doc["results"]}

    @unittest.skipUnless(userns_available(), "needs unprivileged user namespaces")
    def test_post_tool_context_fails_when_the_model_never_sees_it(self):
        work = tempfile.mkdtemp(prefix="cv-test-")
        wrapper = os.path.join(work, "claude")
        with open(wrapper, "w") as f:
            f.write(f"#!/bin/sh\nSTUB_IGNORE_CONTEXT=1 exec {PY} {os.path.join(HERE, 'stub_claude.py')} \"$@\"\n")
        os.chmod(wrapper, 0o755)
        try:
            p, _, by = self.run_stub(os.path.join(work, "w"), "stub-token-0123456789abcdef", claude=wrapper, only=("post_tool_context",))
            r = by["post_tool_context"]
            self.assertEqual(r["status"], h.FAIL, p.stdout[-3000:] + p.stderr[-2000:])
            self.assertTrue(r["evidence"]["parts"]["mcp"]["context_delivered_by_hook"])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    @unittest.skipUnless(userns_available(), "needs unprivileged user namespaces")
    def test_all_probes_against_the_stub(self):
        work = tempfile.mkdtemp(prefix="cv-test-")
        token = "stub-token-0123456789abcdef"
        etc_before = os.path.exists("/etc/claude-code")
        try:
            p, doc, by = self.run_stub(work, token)
            got = {k: r["status"] for k, r in by.items()}
            want = {k: h.PASS for k in got}
            want["init_order"] = h.FAIL  # the stub, like Claude Code 2.1.300, prints system/init only after the first user message
            self.assertEqual(got, want, p.stdout[-3000:] + p.stderr[-2000:])
            # PostToolUse context: followed by the main loop for an MCP and a built-in tool; the
            # subagent (which declines it, like 2.1.316's) is still credited with seeing it.
            parts = by["post_tool_context"]["evidence"]["parts"]
            self.assertEqual({k: (v["followed"], v["receivers"]) for k, v in parts.items()},
                             {"mcp": (True, ["main"]), "builtin": (True, ["main"]), "subagent": (False, ["subagent"])})
            self.assertFalse(by["post_tool_context"]["evidence"]["control"]["seen_by_model"])
            # Stop block: Stop twice, one result after the second.
            t1 = by["stop_block"]["evidence"]["turn1"]
            self.assertEqual([x["stop_hook_active"] for x in t1["stop_hooks"]], [False, True])
            self.assertEqual([r["after_stop_hooks"] for r in t1["results"]], [2])
            self.assertEqual(p.returncode, 1)
            self.assertTrue(os.path.exists(os.path.join(work, "report.md")))
            self.assertTrue(doc["meta"]["bubblewrap"]["required"])
            for d, _, files in os.walk(work):
                for name in files:
                    with open(os.path.join(d, name), "rb") as f:
                        self.assertNotIn(token.encode(), f.read(), os.path.join(d, name))
            # Nothing leaked out of the private mount namespace.
            self.assertEqual(os.path.exists("/etc/claude-code"), etc_before)
            if etc_before and os.path.exists("/etc/claude-code/managed-settings.json"):
                self.assertNotIn("hook_logger.py", slurp("/etc/claude-code/managed-settings.json"))
        finally:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()

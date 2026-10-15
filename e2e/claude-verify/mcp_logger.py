#!/usr/bin/env python3
"""Logging stdio MCP server for the claude-verify probes (configured as server `nest`, so its tools
appear as `mcp__nest__echo` and `mcp__nest__sleep`).

    mcp_logger.py --log <mcp.jsonl> [--state-dir <dir>]

Newline-delimited JSON-RPC on stdio, like `nest mcp`. Every inbound message is logged in full
(`{"ts", "dir": "in", "msg"}`), every outbound one as `"dir": "out"`, plus a `start` line with the
environment summary (`hook_logger.env_summary`) and an `eof` line.

Tools:
- `echo {text}` returns `echo: <text>`.
- `sleep {seconds}` waits (max 600 s) and returns `slept`, unless `<state-dir>/fast` exists, in which
  case it returns at once. `notifications/cancelled` for its request id stops it without a response
  (MCP: a cancelled request gets no response) and is logged as `{"event": "cancelled"}`.
"""
import json, os, sys, threading, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from hook_logger import env_summary  # noqa: E402

TOOLS = [
    {"name": "echo", "description": "Echo the given text back.",
     "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}},
    {"name": "sleep", "description": "Wait for the given number of seconds, then return.",
     "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}}, "required": ["seconds"]}},
]
MAX_SLEEP_S = 600


class Server:
    def __init__(self, log_path, state_dir=None, out=None):
        self.log_path = log_path
        self.state_dir = state_dir
        self.out = out or sys.stdout
        self.lock = threading.Lock()
        self.running = {}  # json.dumps(request id) -> threading.Event (set = cancelled)

    def log(self, **entry):
        entry = {"ts": time.time(), **entry}
        with self.lock, open(self.log_path, "a") as f:
            f.write(json.dumps(entry) + "\n")

    def send(self, msg):
        self.log(dir="out", msg=msg)
        with self.lock:
            self.out.write(json.dumps(msg) + "\n")
            self.out.flush()

    def result(self, rid, result):
        self.send({"jsonrpc": "2.0", "id": rid, "result": result})

    def error(self, rid, code, message):
        self.send({"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}})

    def fast(self):
        return bool(self.state_dir) and os.path.exists(os.path.join(self.state_dir, "fast"))

    def handle_line(self, line):
        if not line.strip():
            return
        try:
            msg = json.loads(line)
        except ValueError as e:
            self.log(dir="in", raw=line[:4000], error=str(e))
            self.error(None, -32700, f"parse error: {e}")
            return
        self.log(dir="in", msg=msg)
        method, rid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
        if method is None:
            return  # a response to something we never send
        if rid is None:  # notification
            if method == "notifications/cancelled":
                key = json.dumps(params.get("requestId"))
                ev = self.running.get(key)
                self.log(event="cancelled", request_id=params.get("requestId"), reason=params.get("reason"),
                         was_running=ev is not None)
                if ev:
                    ev.set()
            return
        if method == "initialize":
            self.result(rid, {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                              "capabilities": {"tools": {"listChanged": False}},
                              "serverInfo": {"name": "claude-verify-mcp", "version": "0"}})
        elif method == "ping":
            self.result(rid, {})
        elif method == "tools/list":
            self.result(rid, {"tools": TOOLS})
        elif method == "tools/call":
            self.call(rid, params.get("name"), params.get("arguments") or {})
        else:
            self.error(rid, -32601, f"method not found: {method}")

    def call(self, rid, name, args):
        if name == "echo":
            self.result(rid, {"content": [{"type": "text", "text": f"echo: {args.get('text', '')}"}], "isError": False})
        elif name == "sleep":
            if self.fast():
                self.log(event="sleep_fast", request_id=rid)
                self.result(rid, {"content": [{"type": "text", "text": "slept 0 s (fast mode)"}], "isError": False})
                return
            seconds = max(0.0, min(float(args.get("seconds", 1) or 1), MAX_SLEEP_S))
            ev = threading.Event()
            self.running[json.dumps(rid)] = ev
            self.log(event="sleep_start", request_id=rid, seconds=seconds)

            def run():
                cancelled = ev.wait(seconds)
                self.running.pop(json.dumps(rid), None)
                if cancelled:
                    self.log(event="sleep_cancelled", request_id=rid)
                else:
                    self.result(rid, {"content": [{"type": "text", "text": f"slept {seconds:g} s"}], "isError": False})

            threading.Thread(target=run, daemon=True).start()
        else:
            self.result(rid, {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True})


def main(argv):
    log_path, state_dir = None, None
    it = iter(argv[1:])
    for a in it:
        if a == "--log":
            log_path = next(it)
        elif a == "--state-dir":
            state_dir = next(it)
    if not log_path:
        print("usage: mcp_logger.py --log <mcp.jsonl> [--state-dir <dir>]", file=sys.stderr)
        return 2
    srv = Server(log_path, state_dir)
    srv.log(event="start", pid=os.getpid(), ppid=os.getppid(), argv=argv, cwd=os.getcwd(), env=env_summary(dict(os.environ)))
    for line in sys.stdin:
        srv.handle_line(line)
    srv.log(event="eof")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

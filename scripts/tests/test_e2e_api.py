"""The e2e harness's `api` resends a request wrangler dev's proxy lost (e2e/FINDINGS.md), and nothing
else: run against an in-process HTTP server that answers as the proxy and as the Worker do."""

import http.server
import importlib.util
import json
import threading
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path

RUN_PY = Path(__file__).resolve().parents[2] / "e2e" / "run.py"
# miniflare's answer when the proxy's connection to the worker's runtime fails (a text 500 with a stack).
LOST = b"Error: Network connection lost.\n    at async Object.fetch (file:///x/miniflare/dist/src/workers/core/entry.worker.js:1:1)"


def load_run():
    spec = importlib.util.spec_from_file_location("e2e_run", RUN_PY)
    run = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(run)
    return run


class Server(http.server.ThreadingHTTPServer):
    def __init__(self):
        super().__init__(("127.0.0.1", 0), Handler)
        self.seen = []  # (path, body) of every request, in order


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        self.server.seen.append((self.path, body))
        n = sum(1 for p, _ in self.server.seen if p == self.path)
        if self.path == "/lost-once" and n == 1 or self.path == "/lost-always":
            status, ctype, out = 500, "text/plain", LOST
        elif self.path == "/worker-500":
            # The Worker's own 500 is JSON, whatever its message says: never resent.
            status, ctype, out = 500, "application/json", json.dumps(
                {"error": {"code": "internal", "message": "Error: Network connection lost.", "retryable": True}}).encode()
        else:
            status, ctype, out = 200, "application/json", b'{"ok":true}'
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class Resend(unittest.TestCase):
    def setUp(self):
        self.run = load_run()
        self.srv = Server()
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        self.run.BASE = f"http://127.0.0.1:{self.srv.server_address[1]}"

    def api(self, path):
        out = StringIO()
        with redirect_stdout(out):
            r = self.run.api("POST", path, {"x": 1})
        return r, [b for p, b in self.srv.seen if p == path], out.getvalue()

    def test_a_lost_request_is_sent_again_and_its_answer_returned(self):
        (st, body), sent, logged = self.api("/lost-once")
        self.assertEqual((st, body), (200, {"ok": True}))
        self.assertEqual(sent, [b'{"x": 1}'] * 2)
        self.assertIn("sending it again", logged)

    def test_resends_are_bounded_and_the_last_loss_is_returned(self):
        (st, body), sent, _ = self.api("/lost-always")
        self.assertEqual(len(sent), 1 + self.run.DEV_PROXY_RESENDS)
        self.assertEqual(self.run.DEV_PROXY_RESENDS, 2)
        self.assertEqual(st, 500)
        self.assertEqual(body, LOST.decode())

    def test_the_workers_own_500_is_never_resent(self):
        (st, body), sent, logged = self.api("/worker-500")
        self.assertEqual(len(sent), 1)
        self.assertEqual(st, 500)
        self.assertEqual(body["error"]["code"], "internal")
        self.assertNotIn("sending it again", logged)


if __name__ == "__main__":
    unittest.main()

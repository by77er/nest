#!/usr/bin/env python3
"""Cloud check that a sandbox host's gateway reaches its VMs (README.md in this directory).

Creates one sandbox, waits for it to run, attaches an agent that never starts (`start: false`, so no
brain and no turn) to it, resolves the sandbox for that agent as a brain would, and binds to its gateway
over the tunnel: resolve answers only for an attached agent. Then the gateway answers `bound` only after it has connected to the guest's vsock socket, so
`bound` proves a hands call can reach the VM (2026-11-04: a host whose gateway couldn't open the
vsock socket answered `busy` "guest not reachable" to every bind). Reports the host, its instance
and, when the AWS CLI can see it, its type. Stops the agent, deletes its template and destroys the
sandbox on every exit path.

Reads NEST_ADMIN_TOKEN (required), NEST_ACCESS_CLIENT_ID and NEST_ACCESS_CLIENT_SECRET (Cloudflare
Access in front of the gateways), NEST_BASE_URL (default https://nest.bitcru.sh), NEST_CELL (default
use1), CHECK_TIMEOUT_S (default 900). Never prints a token, a binding or a header.

    uv run --with 'websockets>=13' python3 -I dev/cloud-checks/hands_probe_check.py
"""
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

import websockets

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")
ACCESS = {"CF-Access-Client-Id": os.environ.get("NEST_ACCESS_CLIENT_ID", ""), "CF-Access-Client-Secret": os.environ.get("NEST_ACCESS_CLIENT_SECRET", "")}
TIMEOUT_S = int(os.environ.get("CHECK_TIMEOUT_S", "900"))


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=data, method=method, headers={
        "authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


async def bind(url, binding, version):
    """The gateway's first reply to a `bind`, retrying `busy` as a brain does, for up to 120 s."""
    deadline = time.time() + 120
    while True:
        async with websockets.connect(url.rstrip("/") + "/hands", additional_headers=ACCESS, open_timeout=30) as ws:
            await ws.send(json.dumps({"type": "bind", "binding": binding, "protocol_version": int(version), "gateway_version": 1}))
            reply = json.loads(await asyncio.wait_for(ws.recv(), 60))
        busy = reply.get("type") == "error" and (reply.get("error") or {}).get("code") == "busy"
        if not busy or time.time() >= deadline:
            return reply
        await asyncio.sleep(min((reply.get("retry_after_ms") or 1000) / 1000, 5))


def destroy(sid):
    """Destroy the sandbox, retried: True once the API answers 2xx (or 404, already gone). A leaked
    sandbox keeps a host (and its cost) alive, so a cleanup that fails fails the check."""
    for attempt in range(5):
        try:
            st, body = api("DELETE", f"/v1/sandboxes/{sid}")
        except (urllib.error.URLError, OSError) as e:
            st, body = None, str(e)
        print(f"destroy {sid}: {st}")
        if st is not None and (200 <= st < 300 or st == 404):
            return True
        time.sleep(2 * (attempt + 1))
    print(f"LEAKED: {sid} wasn't destroyed ({str(body)[:200]}): destroy it by hand (DELETE /v1/sandboxes/{sid})")
    return False


TEMPLATE_NAME = "hands-probe-check"
# Never started, so the credential and model are never used; the API requires both.
TEMPLATE = {
    "capabilities": [], "hands": "required", "credential": "claude_oauth_token:worker",
    "launch": {"model": "haiku", "builtin_tools": [], "system_prompt": {"mode": "append", "text": "A hands probe; never started."}},
}


def on_sigterm(_signum, _frame):
    # Unwind through main's `finally`, which destroys the sandbox.
    raise KeyboardInterrupt


def main():
    signal.signal(signal.SIGTERM, on_sigterm)
    if not ADMIN or not all(ACCESS.values()):
        sys.exit("NEST_ADMIN_TOKEN, NEST_ACCESS_CLIENT_ID and NEST_ACCESS_CLIENT_SECRET are required")
    st, sbx = api("POST", "/v1/sandboxes", {"cell": CELL, "labels": {"check": "hands-probe"}})
    if st not in (201, 202):
        sys.exit(f"FAIL: create: {st} {sbx}")
    sid = sbx["sandbox"]
    print(f"created {sid} (destroyed on exit; if this process dies, DELETE /v1/sandboxes/{sid} by hand)")
    result = 1
    agent = None
    try:
        st, v = api("PUT", f"/v1/admin/templates/{TEMPLATE_NAME}", TEMPLATE)
        if not 200 <= st < 300:
            print(f"FAIL: template: {st} {str(v)[:200]}")
            return result
        st, v = api("POST", "/v1/agents", {"template": TEMPLATE_NAME, "cell": CELL, "sandbox": sid, "start": False})
        if st != 201 or not isinstance(v, dict):
            print(f"FAIL: agent: {st} {str(v)[:200]}")
            return result
        agent = v["agent"]
        print(f"attached {agent} (never started)")
        deadline = time.time() + TIMEOUT_S
        info = sbx
        while time.time() < deadline and not (info.get("host") and info.get("state") == "running"):
            time.sleep(10)
            _, info = api("GET", f"/v1/sandboxes/{sid}")
            info = info if isinstance(info, dict) else {}
        if info.get("state") != "running":
            print(f"FAIL: {sid} never ran: {json.dumps(info)[:300]}")
            return result
        host = info["host"]
        _, view = api("GET", "/v1/admin/fleet")
        instance = next((h.get("instance_id") for h in (view or {}).get("hosts", []) if h.get("host") == host), None)
        itype = None
        if instance:
            r = subprocess.run(["aws", "--region", os.environ.get("AWS_REGION", "us-east-1"), "ec2", "describe-instances", "--instance-ids", instance,
                                "--query", "Reservations[0].Instances[0].InstanceType", "--output", "text"], capture_output=True, text=True)
            itype = r.stdout.strip() or None
        st, target = api("POST", f"/v1/sandboxes/{sid}/resolve", {"client": agent})
        if st != 200 or not isinstance(target, dict):
            print(f"FAIL: resolve: {st} {str(target)[:200]}")
            return result
        reply = asyncio.run(bind(target["url"], target["binding"], target["guest"]["protocol_version"]))
        ok = reply.get("type") == "bound"
        shown = {"type": reply.get("type"), "error": reply.get("error"), "guest": reply.get("guest")}
        print(json.dumps({"sandbox": sid, "host": host, "instance": instance, "instance_type": itype, "reply": shown}))
        print("the gateway reached the VM (bound)" if ok else "FAIL: the gateway didn't bind to the VM")
        result = 0 if ok else 1
        return result
    finally:
        # The check's own verdict is printed above; a failed cleanup fails the check besides.
        if agent:
            st, _ = api("POST", f"/v1/agents/{agent}/stop")
            print(f"stop {agent}: {st}")
            if not 200 <= st < 300:
                result = 1
        print(f"delete template {TEMPLATE_NAME}: {api('DELETE', f'/v1/admin/templates/{TEMPLATE_NAME}')[0]}")
        if not destroy(sid):
            result = 1
        print("PASS" if result == 0 else "FAIL")
        sys.exit(result)


if __name__ == "__main__":
    sys.exit(main())

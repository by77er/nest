#!/usr/bin/env python3
"""Cloud check that a sandbox host's gateway reaches its VMs (README.md in this directory).

Creates one sandbox, waits for it to run, resolves it as a brain would, and binds to its gateway over
the tunnel: the gateway answers `bound` only after it has connected to the guest's vsock socket, so
`bound` proves a hands call can reach the VM (2026-11-04: a host whose gateway couldn't open the
vsock socket answered `busy` "guest not reachable" to every bind). Reports the host, its instance
and, when the AWS CLI can see it, its type. Destroys the sandbox on every exit path.

Reads NEST_ADMIN_TOKEN (required), NEST_ACCESS_CLIENT_ID and NEST_ACCESS_CLIENT_SECRET (Cloudflare
Access in front of the gateways), NEST_BASE_URL (default https://nest.bitcru.sh), NEST_CELL (default
use1), CHECK_TIMEOUT_S (default 900). Never prints a token, a binding or a header.

    uv run --with 'websockets>=13' python3 -I dev/cloud-checks/hands_probe_check.py
"""
import asyncio
import json
import os
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


def main():
    if not ADMIN or not all(ACCESS.values()):
        sys.exit("NEST_ADMIN_TOKEN, NEST_ACCESS_CLIENT_ID and NEST_ACCESS_CLIENT_SECRET are required")
    st, sbx = api("POST", "/v1/sandboxes", {"cell": CELL, "labels": {"check": "hands-probe"}})
    if st not in (201, 202):
        sys.exit(f"FAIL: create: {st} {sbx}")
    sid = sbx["sandbox"]
    print(f"created {sid}")
    ok = False
    try:
        deadline = time.time() + TIMEOUT_S
        info = sbx
        while time.time() < deadline and not (info.get("host") and info.get("state") == "running"):
            time.sleep(10)
            _, info = api("GET", f"/v1/sandboxes/{sid}")
            info = info if isinstance(info, dict) else {}
        if info.get("state") != "running":
            print(f"FAIL: {sid} never ran: {json.dumps(info)[:300]}")
            return 1
        host = info["host"]
        _, view = api("GET", "/v1/admin/fleet")
        instance = next((h.get("instance_id") for h in (view or {}).get("hosts", []) if h.get("host") == host), None)
        itype = None
        if instance:
            r = subprocess.run(["aws", "--region", os.environ.get("AWS_REGION", "us-east-1"), "ec2", "describe-instances", "--instance-ids", instance,
                                "--query", "Reservations[0].Instances[0].InstanceType", "--output", "text"], capture_output=True, text=True)
            itype = r.stdout.strip() or None
        st, target = api("POST", f"/v1/sandboxes/{sid}/resolve", {"client": "hands-probe-check"})
        if st != 200 or not isinstance(target, dict):
            print(f"FAIL: resolve: {st} {str(target)[:200]}")
            return 1
        reply = asyncio.run(bind(target["url"], target["binding"], target["guest"]["protocol_version"]))
        ok = reply.get("type") == "bound"
        shown = {"type": reply.get("type"), "error": reply.get("error"), "guest": reply.get("guest")}
        print(json.dumps({"sandbox": sid, "host": host, "instance": instance, "instance_type": itype, "reply": shown}))
        print("PASS: the gateway reached the VM (bound)" if ok else "FAIL: the gateway didn't bind to the VM")
        return 0 if ok else 1
    finally:
        st, _ = api("DELETE", f"/v1/sandboxes/{sid}")
        print(f"destroyed {sid} ({st})")


if __name__ == "__main__":
    sys.exit(main())

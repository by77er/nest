#!/usr/bin/env python3
"""Cloud check for brain hosts, against the live Worker (README.md in this directory).

Creates CHECK_AGENTS sandboxes and one worker agent per sandbox, starts each brain and
gives it one turn: run a command in its own sandbox through hands (mcp__nest__Bash). Passes when every
turn is done, every transcript shows the command's output, every brain was only ever seen on a brain
host and every sandbox only on a sandbox host. Both host kinds autoscale from zero, so a cold cell
launches one of each. Stops the agents and destroys the sandboxes on every exit path.

Reads NEST_ADMIN_TOKEN (required), NEST_BASE_URL (default https://nest.bitcru.sh), NEST_CELL (default
use1), CHECK_AGENTS (default 2) and CHECK_TIMEOUT_S (default 1800). Never prints the token or any
request header; it prints response bodies, truncated.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")
N = int(os.environ.get("CHECK_AGENTS", "2"))
TIMEOUT_S = int(os.environ.get("CHECK_TIMEOUT_S", "1800"))
PROMPT = ("Automated cross-host check. Use only mcp__nest__ tools. Run `hostname; echo nest-ok-$((6*7))` "
          "with mcp__nest__Bash, then reply with exactly: check done")


def api(method, path, body=None, raw=False, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=data, method=method, headers={
        "authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (t if raw else (json.loads(t) if t else None))
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t
    except (urllib.error.URLError, OSError, ValueError) as e:
        # No answer (network, timeout) or a body that isn't JSON: status 0, so callers fail cleanly.
        return 0, {"error": {"code": "no_answer", "message": type(e).__name__}}


def short(v, n=200):
    return json.dumps(v)[:n]


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def kind(role):
    """A host's kind from its role, under either name (the rename is expand/contract)."""
    return "sandbox" if role in ("burst", "sandbox") else "brain" if role in ("controller", "brain") else f"?{role}"


def expect(ok, what, value):
    if not ok:
        raise SystemExit(f"FAIL: {what}: {short(value)}")


def fleet():
    s, v = api("GET", "/v1/admin/fleet")
    expect(s == 200, f"GET /v1/admin/fleet answered {s}", v)
    return v


def main():
    if not ADMIN:
        sys.exit("NEST_ADMIN_TOKEN is not set")
    sbxs, agents = [], []
    seen_brain = {}    # agent -> host kinds its brain was seen on
    seen_sandbox = {}  # sandbox -> host kinds it was seen on
    ok = True
    try:
        log(f"{BASE} cell {CELL}: live hosts before: "
            f"{[(h['host'][-6:], kind(h.get('role')), h['status']) for h in fleet()['hosts'] if h['status'] in ('active', 'draining')]}")
        for _ in range(N):
            s, v = api("POST", "/v1/sandboxes", {"cell": CELL})
            expect(s in (201, 202), "create sandbox", v)
            sbxs.append(v["sandbox"])
        for sbx in sbxs:
            s, v = api("POST", "/v1/agents", {"template": "worker", "sandbox": sbx, "cell": CELL, "start": False})
            expect(s == 201, "create agent", v)
            agents.append(v["agent"])
            s, r = api("POST", f"/v1/agents/{v['agent']}/start")
            log(f"start {v['agent'][-6:]}: {s} {short(r, 140)}")
            expect(s == 200 or (s == 503 and isinstance(r, dict) and r.get("error", {}).get("retryable")), "start agent", r)
        log(f"sandboxes {[x[-6:] for x in sbxs]}; agents {[a[-6:] for a in agents]}")
        for a in agents:
            s, v = api("POST", f"/v1/agents/{a}/turns", {"text": PROMPT})
            expect(s in (200, 201, 202), "queue turn", v)

        deadline = time.time() + TIMEOUT_S
        while True:
            f = fleet()
            kinds = {h["host"]: kind(h.get("role")) for h in f["hosts"]}
            for h in f["hosts"]:
                for a in h.get("agents", []):
                    if a in agents:
                        seen_brain.setdefault(a, set()).add(kinds[h["host"]])
            for sb in f.get("sandboxes", []):
                if sb["sandbox"] in sbxs and sb.get("host"):
                    seen_sandbox.setdefault(sb["sandbox"], set()).add(kinds.get(sb["host"], "?unknown"))
            done = []
            for a in agents:
                s, t = api("GET", f"/v1/agents/{a}/turns")
                done.append(s == 200 and bool(t) and all(x.get("status") in ("done", "interrupted") for x in t))
            live = [(h["host"][-6:], kinds[h["host"]], h["status"], len(h.get("agents", [])), len(h.get("sandboxes", [])))
                    for h in f["hosts"] if h["status"] in ("active", "draining")]
            log(f"turns finished {done}; live hosts (id, kind, status, brains, sandboxes): {live}")
            if all(done):
                break
            if time.time() > deadline:
                raise SystemExit(f"FAIL: turns not finished within {TIMEOUT_S} s")
            time.sleep(30)

        for a in agents:
            k = seen_brain.get(a, set())
            log(f"agent {a[-6:]}: brain seen on {sorted(k)}")
            ok &= k == {"brain"}
            s, t = api("GET", f"/v1/agents/{a}/turns")
            ok &= s == 200 and all(x.get("status") == "done" for x in t)
            s, tr = api("GET", f"/v1/agents/{a}/transcript", raw=True)
            found = s == 200 and "nest-ok-42" in (tr or "")
            log(f"agent {a[-6:]}: transcript has nest-ok-42: {found}; 'check done': {'check done' in (tr or '')}")
            ok &= found
        for sbx in sbxs:
            k = seen_sandbox.get(sbx, set())
            log(f"sandbox {sbx[-6:]}: seen on {sorted(k)}")
            ok &= k == {"sandbox"}
    except SystemExit as e:
        log(str(e))
        ok = False
    except Exception as e:  # anything else still cleans up and still prints the ids
        log(f"FAIL: {type(e).__name__}: {str(e)[:200]}")
        ok = False
    finally:
        calls = [("POST", f"/v1/agents/{a}/stop") for a in agents] + [("DELETE", f"/v1/sandboxes/{s}") for s in sbxs]
        for method, path in calls:
            try:
                log(f"{method} {path}: {api(method, path)[0]}")
            except Exception as e:
                log(f"{method} {path}: {type(e).__name__}")
    log("PASS" if ok else "FAIL")
    print(json.dumps({"agents": agents, "sandboxes": sbxs}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

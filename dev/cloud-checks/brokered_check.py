#!/usr/bin/env python3
"""Brokered actions check, against the live Worker and the MCP test server (README.md in this directory).

A real Claude Code agent on AWS calls `http_request` through two operator-defined profiles on the MCP test
server's own HTTP routes (`/tools`; the server's token is attached by nest from BrokerDO, the agent never sees
it), from a session the untrusted mcp-check capability taints from its start. Nothing names a service: the
pipeline is the generic one (grant, hourly cap, stored-value scan, sink gate, journal).
  1. setup    - the MCP test server's token as `cap:mcp-check` (for the capability `mcp-check`, the definition
                mcp_check.py uses) and as `http:brokered-check` (for the profiles); the capability
                `brokered-check` (`brokered`: profile `check-allow`, POST and DELETE under /tools,
                `when_tainted: allow`; profile `check-approve`, the same with `when_tainted: approve`) and the
                template `brokered-check` (nest + mcp-check + brokered-check, no hands, BROKERED_MODEL, Haiku).
  2. turn     - one agent, one turn: add the server tool `extra_<run>_a` through `check-allow` (it goes),
                add `extra_<run>_b` through `check-approve` (held: the session is tainted and the profile says
                approve; the check approves it from the agent's open asks, then the agent calls again), then add
                a tool through `check-allow` with a random throwaway value this run stored as the BrokerDO secret
                `http:brokered-check-scan` in its query, which nest must refuse (it scans for stored secrets'
                exact values, not credential shapes).
  3. verify   - the agent's journal (`GET /v1/agents/<id>/brokered`): one done row per profile, sent once; a
                refused row for the scan with its arguments withheld; no row holding the stored value; the
                approved row tainted and written after the approval that held it was asked for (server clocks);
                no approval asked for anything but `check-approve`. On the server (the script's own token):
                removing each of the two tools answers `changed: true`, so each request reached it.
  4. sleep    - until the brain has idle-exited (BROKERED_IDLE_S).
  5. cleanup  - on every exit path (SIGINT, SIGTERM): the run's tools are removed from the server and the
                agent stopped. The capabilities, the template and the secrets are kept for reruns. The last
                line is the JSON of every id made.

Reads NEST_ADMIN_TOKEN, MCP_TEST_URL and MCP_TEST_TOKEN (all required; no token is printed), NEST_BASE_URL
(https://nest.bitcru.sh), NEST_CELL (use1), BROKERED_MODEL (haiku), BROKERED_TIMEOUT_S (1200), BROKERED_IDLE_S
(900), BROKERED_OUT (brokered-check-<run>.jsonl). Needs only the standard library.
"""
import json
import os
import secrets
import signal
import string
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")
MCP_URL = os.environ.get("MCP_TEST_URL", "").rstrip("/")
MCP_TOKEN = os.environ.get("MCP_TEST_TOKEN", "")
MODEL = os.environ.get("BROKERED_MODEL", "haiku")
TIMEOUT_S = int(os.environ.get("BROKERED_TIMEOUT_S", "1200"))
IDLE_S = int(os.environ.get("BROKERED_IDLE_S", "900"))
RUN = time.strftime("r%m%d%H%M%S")
OUT = os.environ.get("BROKERED_OUT", f"brokered-check-{RUN}.jsonl")
# The MCP test server's origin: its HTTP routes (`/tools`) sit beside `/mcp`.
SERVER = urllib.parse.urlsplit(MCP_URL)._replace(path="", query="", fragment="").geturl() if MCP_URL else ""

MCP_CAP = "mcp-check"
CAP = "brokered-check"
TEMPLATE_NAME = "brokered-check"
PROFILE_SECRET = "http:brokered-check"
SCAN_SECRET = "http:brokered-check-scan"
ALLOW, APPROVE = "check-allow", "check-approve"
TOOL_A, TOOL_B = f"extra_{RUN}_a", f"extra_{RUN}_b"
# The capability mcp_check.py defines (kept the same, so either check may overwrite it): an untrusted
# server, whose tool list taints the session from the brain's start.
MCP_TOOLS = ["echo", "note_put", "note_get", "counter_add", "slow"]
MCP_CAPABILITY = {
    "mcp": {"url": MCP_URL, "auth": f"cap:{MCP_CAP}", "tools": MCP_TOOLS, "idempotent": {t: t == "note_put" for t in MCP_TOOLS},
            "read_only": ["echo", "note_get", "slow"], "trusted": False, "when_tainted": "approve"},
    "prompt": "The mcp-check server: echo, notes and counters (an automated check's test server).",
}


def profile(name, when_tainted):
    return {"action": "http.request", "profile": name, "base_url": SERVER, "methods": ["POST", "DELETE"], "paths": ["/tools"],
            "auth": {"secret": PROFILE_SECRET}, "when_tainted": when_tainted}


BROKERED_CAPABILITY = {
    # Both are sinks (they write); a tainted session's call through `check-approve` waits for the operator.
    "brokered": [profile(ALLOW, "allow"), profile(APPROVE, "approve")],
    "prompt": "HTTP requests to the mcp-check server's own routes through two profiles (an automated check).",
}
SYSTEM = ("You are an agent in an automated check of nest's brokered actions. Do exactly the steps your turn gives, "
          "each tool call once and in order, with exactly the arguments given; use no other tool. Some calls need the "
          "operator's approval: when a call says so, end your turn at once. When the decision arrives, make that call again "
          "with the same arguments and carry on with the next step. A call that is refused is part of the check: note it and "
          "carry on. Reply with one line at the end.")
TEMPLATE = {
    "capabilities": ["nest", MCP_CAP, CAP],
    "launch": {"model": MODEL, "builtin_tools": [], "system_prompt": {"mode": "append", "text": SYSTEM}},
    "hands": "forbidden", "credential": "claude_oauth_token:worker",
}


def fake_token():
    """A random throwaway value, stored as SCAN_SECRET before the turn: nest's scan of stored values must refuse it."""
    return "nest-check-" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))


def turn_text(fake):
    step = lambda prof, query: f"Call mcp__nest__http_request with profile \"{prof}\", method \"POST\", path \"/tools\" and query {json.dumps(query)}"
    return ("Do these steps in order, each tool call exactly once:\n"
            f"1. {step(ALLOW, {'name': TOOL_A})}.\n"
            f"2. {step(APPROVE, {'name': TOOL_B})}.\n"
            f"3. {step(ALLOW, {'name': f'extra_{RUN}_c', 'note': fake})} (the note is a random test value nest holds as a secret, "
            "not a real credential; the call is expected to be refused).\n"
            "Then reply with one line: the HTTP status each call answered, or that it was refused.")


# --- HTTP ------------------------------------------------------------------------------------------------------

def _send(req, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t[:200]
    except (urllib.error.URLError, OSError, ValueError) as e:
        return 0, {"error": {"code": "no_answer", "message": type(e).__name__}}


def api(method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=data, method=method, headers={
        "authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"})
    return _send(req, timeout)


# --- Pure checks (no network) -----------------------------------------------------------------------------------

def journal_checks(rows, fake):
    """The journal's checks: [(check, ok, detail)]. `rows` newest first, as the route answers."""
    out = []
    by = lambda target, status: [r for r in rows if r.get("action") == "http.request" and r.get("target") == target and r.get("status") == status]
    out.append((f"the journal has one done row for {ALLOW}, sent once", len(by(ALLOW, "done")) == 1 and by(ALLOW, "done")[0].get("attempts") == 1,
                short([(r.get("target"), r.get("status"), r.get("attempts")) for r in rows])))
    out.append((f"the journal has one done row for {APPROVE}, sent once", len(by(APPROVE, "done")) == 1 and by(APPROVE, "done")[0].get("attempts") == 1, ""))
    refused = by(ALLOW, "refused")
    out.append(("the stored value's call was refused by the scan, its arguments withheld",
                len(refused) == 1 and refused[0].get("args") == "(withheld)" and f"the value of {SCAN_SECRET}" in (refused[0].get("detail") or ""),
                short(refused)))
    out.append(("no journal row holds the stored value", fake not in json.dumps(rows), ""))
    approved = by(APPROVE, "done")
    out.append((f"the {APPROVE} call came from a tainted session", bool(approved) and approved[0].get("tainted") is True, short(approved)))
    return out


def approval_checks(asks, rows):
    """The approvals: asked for check-approve only, before its call went out (both server times)."""
    out = []
    held = [e for e in asks if f"http.request on {APPROVE}" in (e.get("question") or "")]
    others = [e for e in asks if e not in held]
    out.append((f"an approval was asked for {APPROVE}", len(held) >= 1, short([e.get("question", "")[:120] for e in asks])))
    out.append((f"no approval was asked for anything else ({ALLOW} is allow)", not others, short([e.get("question", "")[:120] for e in others])))
    sent = [r for r in rows if r.get("action") == "http.request" and r.get("target") == APPROVE and r.get("status") == "done"]
    first_ask = min((e.get("created_ms") or 0 for e in held), default=None)
    out.append((f"the {APPROVE} call went out after it was asked for (journal created_ms > the ask's created_ms)",
                bool(sent) and first_ask is not None and sent[0].get("created_ms", 0) > first_ask,
                short({"asked_ms": first_ask, "sent_ms": sent[0].get("created_ms") if sent else None})))
    return out


def short(v, n=200):
    return json.dumps(v)[:n]


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def record(kind, **kv):
    with open(OUT, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "kind": kind, **kv}) + "\n")


def mark(name, **kv):
    log(f"== {name} {short(kv, 400) if kv else ''}")
    record("mark", name=name, **kv)


def expect(ok, what, value):
    if not ok:
        raise SystemExit(f"FAIL: {what}: {short(value)}")


# --- The run --------------------------------------------------------------------------------------------------

def server(method, path):
    """The MCP test server's own routes, with the script's token (never printed)."""
    req = urllib.request.Request(f"{SERVER}{path}", method=method, headers={
        "authorization": f"Bearer {MCP_TOKEN}", "user-agent": "nest-cloud-check/1"})
    return _send(req, 60)


def remove_tool(name):
    """Remove a run's tool from the server: whether it was there (`changed`), or None if the server didn't answer."""
    s, v = server("DELETE", f"/tools?name={urllib.parse.quote(name)}")
    return v.get("changed") if s == 200 and isinstance(v, dict) else None


def open_asks(agent):
    """The agent's approvals waiting for the operator, oldest first; None: no answer."""
    s, v = api("GET", f"/v1/agents/{agent}/asks")
    return v if s == 200 and isinstance(v, list) else None


def turn_statuses(agent):
    s, t = api("GET", f"/v1/agents/{agent}/turns")
    return [x.get("status") for x in t] if s == 200 and isinstance(t, list) else [None]


def agent_info(agent):
    s, v = api("GET", f"/v1/agents/{agent}")
    return v if s == 200 and isinstance(v, dict) else None


def main():
    missing = [n for n, v in (("NEST_ADMIN_TOKEN", ADMIN), ("MCP_TEST_URL", MCP_URL), ("MCP_TEST_TOKEN", MCP_TOKEN)) if not v]
    if missing:
        sys.exit(f"not set: {', '.join(missing)}")
    made = {"run": RUN, "agent": None, "tools": [TOOL_A, TOOL_B]}
    ok = True
    removed = {}

    def to_interrupt(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, to_interrupt)
    try:
        mark("start", base=BASE, cell=CELL, server=SERVER, model=MODEL, run=RUN)

        # 1. The server's token (for the mcp capability and the profiles); the capabilities and the template.
        for name in (f"cap:{MCP_CAP}", PROFILE_SECRET):
            s, _ = api("PUT", f"/v1/admin/secrets/{name}", {"value": MCP_TOKEN})
            expect(s in (200, 204), f"store the MCP test server's token as {name}", {"status": s})
        for name, body in ((MCP_CAP, MCP_CAPABILITY), (CAP, BROKERED_CAPABILITY)):
            s, v = api("PUT", f"/v1/admin/capabilities/{name}", body)
            expect(s == 200, f"PUT capability {name}", v)
        s, v = api("PUT", f"/v1/admin/templates/{TEMPLATE_NAME}", TEMPLATE)
        expect(s == 200, f"PUT template {TEMPLATE_NAME}", v)
        mark("configured", capabilities=[MCP_CAP, CAP], template=TEMPLATE_NAME)

        # 2. One agent, one turn; the check approves the check-approve call when it's asked for.
        fake = fake_token()
        s, _ = api("PUT", f"/v1/admin/secrets/{SCAN_SECRET}", {"value": fake})
        expect(s in (200, 204), f"store this run's throwaway value as {SCAN_SECRET}", {"status": s})
        s, v = api("POST", "/v1/agents", {"template": TEMPLATE_NAME, "cell": CELL, "start": False})
        expect(s == 201, "create agent", v)
        agent = made["agent"] = v["agent"]
        s, v = api("POST", f"/v1/agents/{agent}/turns", {"text": turn_text(fake), "request_id": f"{RUN}/{agent}/turn"})
        expect(s == 201 and isinstance(v, dict) and v.get("turn"), "enqueue the turn", v)
        mark("turn sent", agent=agent)
        answered = {}
        t0 = time.time()
        ever_live = False
        while True:
            info = agent_info(agent)
            ever_live |= bool(info and info.get("brain"))
            for e in open_asks(agent) or []:
                ask = e.get("ask")
                if ask in answered:
                    continue
                q = e.get("question") or ""
                verdict = "approve" if f"http.request on {APPROVE}" in q else f"deny: this check approves only {APPROVE}"
                s, _ = api("POST", f"/v1/agents/{agent}/asks/{ask}/answer", {"answer": verdict})
                if s == 200:
                    answered[ask] = {"verdict": verdict, "question": q, "created_ms": e.get("created_ms")}
                    record("decision", ask=ask, verdict=verdict.split(":")[0], question=q[:300], local_ms=int(time.time() * 1000))
                    log(f"  {ask}: {verdict.split(':')[0]} ({q[:100]!r})")
            st = turn_statuses(agent)
            log(f"turns {st}; asks answered {len(answered)}")
            if st and all(x == "done" for x in st) and answered and open_asks(agent) == []:
                break
            if "interrupted" in st:
                raise SystemExit("FAIL: a turn was interrupted")
            if time.time() > t0 + TIMEOUT_S:
                raise SystemExit(f"FAIL: the turns weren't done within {TIMEOUT_S} s")
            time.sleep(10)
        mark("turns ended", wall_s=round(time.time() - t0), asks=len(answered))

        # 3. Verify: the journal, the approvals, then the server itself.
        s, rows = api("GET", f"/v1/agents/{agent}/brokered?limit=100")
        expect(s == 200 and isinstance(rows, list), "read the agent's journal", rows)
        for r in rows:
            record("journal", **r)
        results = journal_checks(rows, fake) + approval_checks(list(answered.values()), rows)
        for name in (TOOL_A, TOOL_B):
            removed[name] = remove_tool(name)
            results.append((f"the server had {name} (the request reached it with the profile's credential)", removed[name] is True, short(removed[name])))
        for n, g, d in results:
            log(f"  {'ok  ' if g else 'FAIL'} {n}{'' if g else f': {d}'}")
            ok &= g
        record("checks", checks=[{"check": n, "ok": g, "detail": d} for n, g, d in results])

        # 4. Sleep: the brain idle-exits.
        t1 = time.time()
        gone = None
        while time.time() < t1 + IDLE_S:
            info = agent_info(agent)
            ever_live |= bool(info and info.get("brain"))
            if info is not None and not info.get("brain") and ever_live and not [x for x in turn_statuses(agent) if x in ("queued", "active", None)]:
                gone = round(time.time() - t1)
                break
            time.sleep(20)
        mark("asleep", exited_after_s=gone, ever_live=ever_live)
        ok &= gone is not None
    except SystemExit as e:
        log(str(e))
        ok = False
    except KeyboardInterrupt:
        log("FAIL: interrupted")
        ok = False
    except Exception as e:  # anything else still cleans up and still prints the ids
        log(f"FAIL: {type(e).__name__}: {str(e)[:200]}")
        ok = False
    finally:
        # 5. Cleanup, not interruptible (each call has its own timeout).
        old = signal.signal(signal.SIGINT, signal.SIG_IGN), signal.signal(signal.SIGTERM, signal.SIG_IGN)
        mark("cleanup")
        try:
            for name in (TOOL_A, TOOL_B, f"extra_{RUN}_c"):
                if name not in removed:
                    log(f"removed {name}: {remove_tool(name)}")
            if made["agent"]:
                stop = f"/v1/agents/{made['agent']}/stop"
                log(f"POST {stop}: {api('POST', stop)[0]}")
        except Exception as e:
            log(f"cleanup: {type(e).__name__}")
            ok = False
        finally:
            signal.signal(signal.SIGINT, old[0])
            signal.signal(signal.SIGTERM, old[1])
    log("PASS" if ok else "FAIL")
    print(json.dumps(made))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Ad-hoc cloud check: a tool added on the MCP test server reaches live real-Claude-Code brains without a
restart (connector -> tools_changed -> runner -> nest mcp -> list_changed -> Claude Code re-lists).
Env: NEST_ADMIN_TOKEN, MCP_TEST_URL (/mcp), MCP_TEST_TOKEN. Tokens are never printed."""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

BASE, CELL = "https://nest.bitcru.sh", "use1"
ADMIN, MCP_URL, MCP_TOKEN = os.environ["NEST_ADMIN_TOKEN"], os.environ["MCP_TEST_URL"], os.environ["MCP_TEST_TOKEN"]
SERVER = MCP_URL[: -len("/mcp")]
CAP, TPL, EXTRA = "mcplive", "mcplive", "extra_live"


def send(req):
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t[:200]


def api(method, path, body=None):
    sep = "&" if "?" in path else "?"
    return send(urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=None if body is None else json.dumps(body).encode(), method=method,
                                       headers={"authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"}))


def srv(method, path):
    return send(urllib.request.Request(f"{SERVER}{path}", data=b"" if method != "GET" else None, method=method,
                                       headers={"authorization": f"Bearer {MCP_TOKEN}", "user-agent": "nest-cloud-check/1"}))


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def tool(t):
    return f"mcp__nest__{CAP}_{t}"


def wait_turns(agents, turns, timeout=600):
    t0 = time.time()
    while time.time() < t0 + timeout:
        st = {}
        for a in agents:
            s, v = api("GET", f"/v1/agents/{a}/turns")
            st[a] = {x["turn"]: x["status"] for x in v} if s == 200 else {}
        left = [a for a in agents if st[a].get(turns[a]) != "done"]
        log(f"waiting for {len(left)} turns")
        if not left:
            return True
        time.sleep(10)
    return False


def epoch(a):
    s, v = api("GET", f"/v1/agents/{a}")
    return (v.get("brain") or {}).get("epoch") if s == 200 else None


ok, agents = True, []
try:
    s, v = srv("POST", "/reset")
    srv("DELETE", f"/tools?name={EXTRA}")
    s, v = api("PUT", f"/v1/admin/capabilities/{CAP}", {"mcp": {"url": MCP_URL, "auth": "cap:mcp-check", "trusted": True},
                                                        "prompt": "The mcp-test server (trusted), no allowlist."})
    assert s == 200, v
    s, v = api("PUT", f"/v1/admin/templates/{TPL}", {
        "capabilities": ["nest", CAP], "hands": "forbidden", "credential": "claude_oauth_token:worker", "escalate_to": "workstream",
        "subscribe": [], "params": {},
        "launch": {"model": "haiku", "builtin_tools": [], "system_prompt": {"mode": "append", "text":
                   "You are in an automated check. Do exactly the steps given, each tool call once, then reply with one line."}}})
    assert s == 200, v
    s, v = api("POST", "/v1/workstreams", {"goal": "list_changed cloud check"})
    ws = v["workstream"]
    for _ in range(2):
        s, v = api("POST", "/v1/agents", {"template": TPL, "workstream": ws, "cell": CELL, "start": False})
        agents.append(v["agent"])
    t1 = {}
    for a in agents:
        s, v = api("POST", f"/v1/agents/{a}/turns", {"text": f"Call {tool('echo')} with text \"one {a}\". Then reply done."})
        t1[a] = v["turn"]
    ok &= wait_turns(agents, t1)
    e1 = {a: epoch(a) for a in agents}
    log(f"turn 1 done; epochs {e1}")
    s, v = srv("POST", f"/tools?name={EXTRA}")
    log(f"server: tool {EXTRA} added: {s}")
    t2 = {}
    for a in agents:
        s, v = api("POST", f"/v1/agents/{a}/turns", {"text": f"Call {tool('echo')} with text \"two {a}\". Then reply done."})
        t2[a] = v["turn"]
    ok &= wait_turns(agents, t2)
    log(f"waiting {int(os.environ.get('LC_GAP_S', '75'))} s for the change to propagate")
    time.sleep(int(os.environ.get("LC_GAP_S", "75")))
    t3 = {}
    for a in agents:
        s, v = api("POST", f"/v1/agents/{a}/turns", {"text": f"Call {tool(EXTRA)} with text \"hi {a}\" (it was just added; if you don't have it, say so). Then reply with what it answered."})
        t3[a] = v["turn"]
    ok &= wait_turns(agents, t3)
    e2 = {a: epoch(a) for a in agents}
    s, v = srv("GET", "/calls?since=0")
    calls = v.get("calls", []) if isinstance(v, dict) else []
    for a in agents:
        mine = [c for c in calls if (c.get("_meta") or {}).get("nest/agent") == a]
        extra = [c for c in mine if c.get("tool") == EXTRA]
        good = bool(extra) and e1[a] is not None and e1[a] == e2[a] and all((c.get("_meta") or {}).get("nest/epoch") == e1[a] for c in mine)
        log(f"{'ok  ' if good else 'FAIL'} {a}: calls {[c.get('tool') for c in mine]}; epochs {e1[a]} -> {e2[a]}; "
            f"{EXTRA} answered {[((c.get('result_or_error') or {}).get('result') or {}).get('content') for c in extra]}")
        ok &= good
finally:
    srv("DELETE", f"/tools?name={EXTRA}")
    for a in agents:
        log(f"stop {a}: {api('POST', f'/v1/agents/{a}/stop')[0]}")
    log("PASS" if ok else "FAIL")
    print(json.dumps({"agents": agents}))
    sys.exit(0 if ok else 1)

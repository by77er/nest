#!/usr/bin/env python3
"""Live lifetimes check (dev/deploy.md, agent and sandbox lifetimes): a real-Claude parent spawns an ephemeral
child on a new sandbox; the child does its task and ends itself, and its sandbox is destroyed and leaves the GC
registry. Then a second (non-ephemeral) child, which the parent stops with agent_stop; then the operator ends
the parent. Env: NEST_ADMIN_TOKEN. Never prints a token."""
import json, os, sys, time, urllib.error, urllib.request

BASE, CELL = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh"), os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ["NEST_ADMIN_TOKEN"]
CAP, PARENT, CHILD = "lcspawn", "lc-parent", "lc-child"


def send(req, timeout=60):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t[:300]


def api(method, path, body=None):
    sep = "&" if "?" in path else "?"
    return send(urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=None if body is None else json.dumps(body).encode(), method=method,
                                       headers={"authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"}))


def assistant_texts(agent):
    """The text blocks of the agent's assistant messages, in order, from its session transcript (None: no answer)."""
    texts, since, base = [], 0, None
    for _ in range(50):
        s, v = api("GET", f"/v1/agents/{agent}/transcript?since={since}&limit=500" + (f"&base={base}" if base is not None else ""))
        if s != 200 or not isinstance(v, dict):
            return None
        for line in v.get("lines", []):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict) and e.get("type") == "assistant":
                for b in (e.get("message") or {}).get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                        texts.append(b["text"])
        if not v.get("more"):
            return texts
        since, base = v.get("next_seq", since), v.get("base")
    return texts


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def until(fn, timeout, what, every=10):
    t0 = time.time()
    while time.time() < t0 + timeout:
        v = fn()
        if v:
            return v
        time.sleep(every)
    log(f"timed out after {timeout} s: {what}")
    return None


def turn(agent, text, timeout=900):
    s, v = api("POST", f"/v1/agents/{agent}/turns", {"text": text})
    assert s == 201, ("turn", s, v)
    t = v["turn"]
    def done():
        s, v = api("GET", f"/v1/agents/{agent}/turns")
        st = {x["turn"]: x["status"] for x in v} if s == 200 else {}
        return st.get(t) if st.get(t) in ("done", "interrupted", "failed", "dropped") else None
    return until(done, timeout, f"{agent} turn {t}", 15)


def live_sandboxes():
    s, v = api("GET", "/v1/admin/gc")
    return v.get("sandboxes") if s == 200 and isinstance(v, dict) else None


def info(a):
    return api("GET", f"/v1/agents/{a}")[1] or {}


def sbx_state(s):
    return (api("GET", f"/v1/sandboxes/{s}")[1] or {}).get("state")


def children(p):
    s, v = api("GET", f"/v1/agents/{p}/children")
    return v if s == 200 and isinstance(v, list) else []


ok, parent, sandboxes = True, None, []
checks = []
def check(name, good, detail=""):
    global ok
    checks.append(name)
    log(f"{'ok  ' if good else 'FAIL'} {name}{'' if good else ' :: ' + str(detail)[:300]}")
    ok &= bool(good)

try:
    for path, body in (
        (f"capabilities/{CAP}", {"tools": ["agent_spawn", "agent_stop"], "spawn": [CHILD], "prompt": "You may spawn lc-child agents and stop them."}),
        (f"templates/{CHILD}", {"capabilities": ["nest", "hands"], "hands": "required", "credential": "claude_oauth_token:worker", "escalate_to": "workstream",
                                "subscribe": [], "params": {}, "launch": {"model": "haiku", "builtin_tools": [], "system_prompt": {"mode": "append",
                                "text": "You are in an automated check. Do exactly the task, then reply with one line."}}}),
        (f"templates/{PARENT}", {"capabilities": ["nest", CAP], "hands": "forbidden", "credential": "claude_oauth_token:worker", "escalate_to": "workstream",
                                 "subscribe": [], "params": {}, "launch": {"model": "haiku", "builtin_tools": [], "system_prompt": {"mode": "append",
                                 "text": "You are in an automated check. Make exactly the tool calls given, each once, then reply with the tool's answer verbatim."}}}),
    ):
        s, v = api("PUT", f"/v1/admin/{path}", body)
        assert s == 200, (path, s, v)
    s, v = api("POST", "/v1/workstreams", {"goal": "lifetimes cloud check"})
    ws = v["workstream"]
    before = live_sandboxes()
    log(f"live sandboxes before: {before}")
    s, v = api("POST", "/v1/agents", {"template": PARENT, "workstream": ws, "cell": CELL, "start": False})
    assert s == 201, v
    parent = v["agent"]
    log(f"parent {parent}")

    # 1. An ephemeral child on a new sandbox: does its task, then ends itself, destroying its sandbox.
    st = turn(parent, f"Call mcp__nest__agent_spawn with template \"{CHILD}\", sandbox \"new\", ephemeral true, and task "
                      "\"Run the shell command `echo lifetimes-check-ok` with your Bash tool, then reply with its output.\". Reply with its answer.")
    kids = children(parent)
    check("parent's spawn turn finished", st == "done", st)
    check("agent_spawn made one child", len(kids) == 1, kids)
    c1 = kids[0]["agent"] if kids else None
    if c1:
        i = info(c1)
        s1 = (i.get("hands") or {}).get("sandbox")
        sandboxes.append(s1)
        check("the child is the parent's, ephemeral, on its own sandbox", i.get("owner") == parent and s1, {k: i.get(k) for k in ("owner", "hands", "ephemeral")})
        log(f"child {c1} on {s1}")
        ended = until(lambda: info(c1).get("ended"), 1200, "the ephemeral child ending")
        check("the ephemeral child ended itself when its turn finished (done)", ended and ended.get("reason") == "done" and ended.get("by") == c1, ended)
        final = assistant_texts(c1) or []
        check("the child ran its task in its sandbox", any("lifetimes-check-ok" in t for t in final), final[-1:])
        check("its sandbox was destroyed", until(lambda: sbx_state(s1) == "destroyed", 300, "child sandbox destroyed"), sbx_state(s1))
        check("the GC registry dropped it", until(lambda: live_sandboxes() == before, 120, "registry back"), live_sandboxes())
        check("the parent's index has it ended", any(k["agent"] == c1 and k["ended"] for k in children(parent)), children(parent))
        s, v = api("POST", f"/v1/agents/{c1}/turns", {"text": "more"})
        check("an ended agent takes no turn", s == 404, (s, v))

    # 2. A non-ephemeral child the parent stops with agent_stop, destroying its sandbox.
    st = turn(parent, f"Call mcp__nest__agent_spawn with template \"{CHILD}\", sandbox \"new\", and task \"Reply with the word ready.\". Reply with its answer.")
    kids = [k for k in children(parent) if k["agent"] != c1]
    check("a second child", st == "done" and len(kids) == 1, (st, kids))
    c2 = kids[0]["agent"] if kids else None
    if c2:
        s2 = (info(c2).get("hands") or {}).get("sandbox")
        sandboxes.append(s2)
        log(f"child {c2} on {s2}")
        st = turn(parent, f"Call mcp__nest__agent_stop with agent \"{c2}\", destroy_sandbox true and reason \"cloud check\". Reply with its answer.")
        check("the parent's stop turn finished", st == "done", st)
        ended = until(lambda: info(c2).get("ended"), 300, "the second child ended")
        check("the second child ended, stopped by the parent", ended and ended.get("by") == parent, ended)
        check("its sandbox was destroyed", until(lambda: sbx_state(s2) == "destroyed", 600, "second sandbox destroyed"), sbx_state(s2))
        check("no brain left for it", until(lambda: info(c2).get("brain") is None, 300, "second child's brain gone"), info(c2).get("brain"))
        check("the GC registry is back where it was", until(lambda: live_sandboxes() == before, 120, "registry back"), live_sandboxes())

    # 3. The operator ends the parent for good.
    s, v = api("POST", f"/v1/agents/{parent}/stop", {"end": True})
    check("the operator ends the parent", s == 200, (s, v))
    check("the parent's brain is gone", until(lambda: info(parent).get("brain") is None, 300, "parent brain gone"), info(parent).get("brain"))
    check("the parent ended", bool(info(parent).get("ended")), info(parent).get("ended"))
    parent_done = True
except Exception as e:
    ok = False
    log(f"FAIL: {type(e).__name__}: {str(e)[:400]}")
finally:
    if parent and not info(parent).get("ended"):
        log(f"cleanup: end parent: {api('POST', f'/v1/agents/{parent}/stop', {'end': True, 'destroy_sandbox': True})[0]}")
    for s in sandboxes:
        if s and sbx_state(s) != "destroyed":
            log(f"cleanup: destroy {s}: {api('DELETE', f'/v1/sandboxes/{s}')[0]}")
    log(f"live sandboxes after: {live_sandboxes()}")
    log("PASS" if ok else "FAIL")
    print(json.dumps({"parent": parent, "sandboxes": sandboxes}))
    sys.exit(0 if ok else 1)

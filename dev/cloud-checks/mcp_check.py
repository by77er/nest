#!/usr/bin/env python3
"""Remote MCP check, against the live Worker and a separately deployed MCP test server (README.md in
this directory).

Real Claude Code agents on AWS use tools from the MCP test server (mcp-test/, its own Worker) through
nest's MCP proxy, and the platform's guarantees are checked against the server's own call log:
  1. setup    - `POST /reset` on the server; its token stored in BrokerDO as `cap:mcp-check`; the
                capability `mcp-check` (untrusted, all five tools allowed, only note_put idempotent,
                echo, note_get and slow marked read-only, so note_put and counter_add are sinks)
                and the template `mcp-check` (nest + mcp-check, no hands, MCP_MODEL, Haiku by default).
  2. turns    - one workstream (an agent without a sandbox still needs one) and MCP_AGENTS agents, each
                given one turn: echo a phrase holding its id, note_put `<agent>/k` = a random value,
                note_get it back, counter_add `<agent>` by 1 twice, then by 100, then reply. Each sink
                call is held for approval (the session is tainted): the check approves every one but
                the n 100 call, which it denies; each answer is a turn in which the agent carries on.
  3. verify   - when every turn is done (MCP_TIMEOUT_S): the server's `GET /calls`, per agent: every
                call carries `_meta` with `nest/agent` = the agent, `nest/epoch` = an epoch its brain
                was seen with, `nest/call` starting `<agent>/<that epoch>/`, and `nest/taint` true;
                epochs never go back; no call key reaches the server twice (only note_put, the one
                idempotent tool, may be retried once under its key); the counter is exactly 2;
                note_get returned what note_put stored; the session is tainted (the turn's
                `turn_completed` event on `<agent>/events` carries the session's taint); no more sink
                calls reach the server than were approved, and the denied one never does.
  4. sleep    - until every brain has idle-exited (MCP_IDLE_S).
  5. cleanup  - stop every agent (on every exit path; SIGINT or SIGTERM), check no brain of the run is
                left on a host, then optionally (MCP_DRAIN_S > 0) watch until no host of the cell is live.
The server's state (notes, counters, call log) is left for the operator to read or reset; the
capability, its secret and the template are kept for reruns. The last line is the JSON of every id made.

Reads NEST_ADMIN_TOKEN, MCP_TEST_URL (the server's /mcp URL) and MCP_TEST_TOKEN (all required; the
tokens are never printed), NEST_BASE_URL (https://nest.bitcru.sh), NEST_CELL (use1), MCP_AGENTS (2),
MCP_MODEL (haiku), MCP_TIMEOUT_S (1200), MCP_IDLE_S (900), MCP_DRAIN_S (0: don't watch the drain),
MCP_OUT (mcp-check-<run>.jsonl). Never prints a token or any request header; it prints response
bodies, truncated.
"""
import json
import os
import secrets
import signal
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
AGENTS = int(os.environ.get("MCP_AGENTS", "2"))
MODEL = os.environ.get("MCP_MODEL", "haiku")
TIMEOUT_S = int(os.environ.get("MCP_TIMEOUT_S", "1200"))
IDLE_S = int(os.environ.get("MCP_IDLE_S", "900"))
DRAIN_S = int(os.environ.get("MCP_DRAIN_S", "0"))
RUN = time.strftime("r%m%d%H%M%S")
OUT = os.environ.get("MCP_OUT", f"mcp-check-{RUN}.jsonl")
# The server's test surface sits beside its /mcp endpoint.
SERVER = MCP_URL[: -len("/mcp")] if MCP_URL.endswith("/mcp") else MCP_URL

CAP = "mcp-check"
TEMPLATE_NAME = "mcp-check"
TOOLS = ["echo", "note_put", "note_get", "counter_add", "slow"]
# Every tool stated, so only note_put is idempotent whatever the server's annotations say (echo,
# note_get and slow are read-only there): a lost answer to any other tool is never sent again.
IDEMPOTENT = {t: t == "note_put" for t in TOOLS}
CAPABILITY = {
    # Untrusted, so the server's readOnlyHint doesn't count: the reads are marked here, and note_put and
    # counter_add are sinks, held for the operator's approval (this check answers it).
    "mcp": {"url": MCP_URL, "auth": f"cap:{CAP}", "tools": TOOLS, "idempotent": IDEMPOTENT, "read_only": ["echo", "note_get", "slow"],
            "trusted": False, "when_tainted": "approve"},
    "prompt": "The mcp-check server: echo, notes and counters (an automated check's test server).",
}
SYSTEM = ("You are an agent in an automated check of a remote MCP server. Do exactly the steps your turn gives, "
          "each tool call once and in order, with exactly the arguments given; use no other tool. Some calls need the "
          "operator's approval: when a call says so, end your turn at once. When the decision arrives, carry on from that "
          "step: if approved, make that call again with the same arguments; if denied, skip it. Reply with one line at the end.")
# The step the operator denies (its arguments are unique to it): it must never reach the server.
DENIED_N = 100
TEMPLATE = {
    # `nest` lets every mcp__nest__* tool run without asking (remote tools included): an unanswered
    # approval would end the turn.
    "capabilities": ["nest", CAP],
    "launch": {"model": MODEL, "builtin_tools": [], "system_prompt": {"mode": "append", "text": SYSTEM}},
    "hands": "forbidden", "credential": "claude_oauth_token:worker", "escalate_to": "workstream", "subscribe": [], "params": {},
}


def tool(name):
    return f"mcp__nest__{CAP}_{name}"


def turn_text(agent, value):
    return ("Do these steps in order, each tool call exactly once:\n"
            f"1. Call {tool('echo')} with text \"hello from {agent}\".\n"
            f"2. Call {tool('note_put')} with key \"{agent}/k\" and value \"{value}\".\n"
            f"3. Call {tool('note_get')} with key \"{agent}/k\".\n"
            f"4. Call {tool('counter_add')} with name \"{agent}\" and n 1.\n"
            f"5. Call {tool('counter_add')} with name \"{agent}\" and n 1 again.\n"
            f"6. Call {tool('counter_add')} with name \"{agent}\" and n {DENIED_N}.\n"
            "Then reply with one line: the echoed text, the value note_get returned, and the counter totals.")


def api(method, path, body=None, raw=False, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=data, method=method, headers={
        "authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-cloud-check/1"})
    return _send(req, raw, timeout)


def mcp_api(method, path, timeout=60):
    """The MCP test server's own test surface (`/calls`, `/reset`), with its bearer."""
    req = urllib.request.Request(f"{SERVER}{path}", data=b"" if method == "POST" else None, method=method, headers={
        "authorization": f"Bearer {MCP_TOKEN}", "user-agent": "nest-cloud-check/1"})
    return _send(req, False, timeout)


def _send(req, raw, timeout):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            t = r.read().decode()
            return r.status, (t if raw else (json.loads(t) if t else None))
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try:
            return e.code, json.loads(t)
        except ValueError:
            return e.code, t[:200]
    except (urllib.error.URLError, OSError, ValueError) as e:
        # No answer (network, timeout) or a body that isn't JSON: status 0, so callers fail cleanly.
        return 0, {"error": {"code": "no_answer", "message": type(e).__name__}}


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


def server_calls():
    """Every call in the server's log, in order (it pages at 1000); None: no answer."""
    out, since = [], 0
    while True:
        s, v = mcp_api("GET", f"/calls?since={since}")
        if s != 200 or not isinstance(v, dict) or not isinstance(v.get("calls"), list):
            log(f"GET /calls answered {s} {short(v)}")
            return None
        out += v["calls"]
        if len(v["calls"]) < 1000:
            return out
        since = v["calls"][-1]["seq"]


def agent_info(agent):
    s, v = api("GET", f"/v1/agents/{agent}")
    return v if s == 200 and isinstance(v, dict) else None


def turn_statuses(agent):
    """The status of each of the agent's turns ([None]: no answer)."""
    s, t = api("GET", f"/v1/agents/{agent}/turns")
    return [x.get("status") for x in t] if s == 200 and isinstance(t, list) else [None]


def events(agent):
    """The agent's `<agent>/events` channel (None: no answer)."""
    s, v = api("GET", f"/v1/admin/channels/{urllib.parse.quote(agent + '/events', safe='')}/messages?since=0&limit=200")
    return v.get("messages", []) if s == 200 and isinstance(v, dict) else None


def brains_on_hosts(agents):
    """This run's agents that some live host still lists as running a brain (None: no fleet view)."""
    s, f = api("GET", "/v1/admin/fleet")
    if s != 200 or not isinstance(f, dict):
        return None
    return sorted({a for h in f.get("hosts", []) if h.get("status") != "dead" for a in h.get("agents", []) if a in agents})


def live_hosts():
    s, f = api("GET", "/v1/admin/fleet")
    if s != 200 or not isinstance(f, dict):
        return None
    return [(h["host"][-6:], h.get("role"), h["status"]) for h in f.get("hosts", []) if h["status"] in ("active", "draining")]


def needs_input(ws):
    """The workstream's `needs_input` events (approvals and asks), oldest first; None: no answer."""
    s, v = api("GET", f"/v1/workstreams/{ws}/events?limit=500")
    return [e for e in reversed(v) if e.get("type") == "needs_input"] if s == 200 and isinstance(v, list) else None


def decide(ws, answered):
    """Answer every new approval: deny the call with n DENIED_N, approve the rest. Returns how many are unanswered."""
    evs = needs_input(ws)
    if evs is None:
        return 1
    left = 0
    for e in evs:
        ask, agent, q = e.get("ask"), e.get("agent"), e.get("question", "")
        if ask in answered:
            continue
        verdict = "deny: this check denies it" if f'"n":{DENIED_N}' in q.replace(" ", "") else "approve"
        s, v = api("POST", f"/v1/agents/{agent}/asks/{ask}/answer", {"answer": verdict})
        if s == 200:
            answered[ask] = {"agent": agent, "approved": verdict == "approve", "question": q}
            record("decision", ask=ask, agent=agent, approved=verdict == "approve", question=q[:300])
            log(f"  {agent[-6:]} {ask}: {verdict.split(':')[0]} ({q[:90]!r})")
        else:
            left += 1
    return left


def result_text(call):
    """A logged call's answer: (text, is_error); (None, True) for a JSON-RPC error or no answer yet."""
    roe = call.get("result_or_error") or {}
    res = roe.get("result")
    if not isinstance(res, dict):
        return None, True
    text = "".join(c.get("text", "") for c in res.get("content", []) if isinstance(c, dict) and c.get("type") == "text")
    return text, bool(res.get("isError"))


def verify(agent, value, epochs, calls, decisions):
    """The server-side checks for one agent over its calls (in log order): [(check, ok, detail)]."""
    out = []
    meta = lambda c: c.get("_meta") or {}

    def check(name, ok, detail=""):
        out.append((name, bool(ok), detail))

    bad_meta = []
    for c in calls:
        m = meta(c)
        e = m.get("nest/epoch")
        good = (m.get("nest/agent") == agent and isinstance(e, int) and not isinstance(e, bool) and e in epochs
                and isinstance(m.get("nest/call"), str) and m["nest/call"].startswith(f"{agent}/{e}/") and m.get("nest/taint") is True)
        if not good:
            bad_meta.append({"seq": c.get("seq"), "tool": c.get("tool"), "_meta": m})
    check("every call carries nest's _meta (agent, a brain's epoch, its call key, taint true)", calls and not bad_meta,
          short(bad_meta or f"{len(calls)} calls, epochs {sorted(epochs)}", 400))
    seen_epochs = [meta(c).get("nest/epoch") for c in calls]
    check("epochs never go back (no older brain's call after a newer one's)",
          all(isinstance(a, int) and isinstance(b, int) and a <= b for a, b in zip(seen_epochs, seen_epochs[1:])), short(seen_epochs))

    by_key = {}
    for c in calls:
        by_key.setdefault(meta(c).get("nest/call"), []).append(c)
    repeats = {k: [c.get("tool") for c in v] for k, v in by_key.items() if len(v) > 1}
    # A retry of an idempotent tool's lost answer goes out again under the same key, at most twice in all.
    allowed = all(len(v) <= 2 and all(IDEMPOTENT.get(t) for t in v) for v in repeats.values())
    check("no call key reached the server twice (bar one retry of an idempotent tool)", allowed, short(repeats or "none"))

    def of(t):
        return [c for c in calls if c.get("tool") == t]

    echo = [c for c in of("echo") if agent in str((c.get("arguments") or {}).get("text", ""))]
    check("echo was called with the agent's id and answered it",
          echo and all(agent in (result_text(c)[0] or "") and not result_text(c)[1] for c in echo), short([result_text(c) for c in echo]))
    key = f"{agent}/k"
    puts = [c for c in of("note_put") if (c.get("arguments") or {}).get("key") == key]
    gets = [c for c in of("note_get") if (c.get("arguments") or {}).get("key") == key]
    check("note_put stored the turn's value under <agent>/k",
          puts and all((c.get("arguments") or {}).get("value") == value and not result_text(c)[1] for c in puts),
          short([(c.get("arguments"), result_text(c)) for c in puts]))
    after_put = [c for c in gets if puts and c.get("seq", 0) > puts[0].get("seq", 0)]
    check("note_get returned what note_put stored", after_put and all(result_text(c) == (value, False) for c in after_put),
          short([result_text(c) for c in gets]))
    adds = [c for c in of("counter_add") if (c.get("arguments") or {}).get("name") == agent]
    totals = [result_text(c) for c in adds]
    ok_adds = (len(adds) == 2 and all((c.get("arguments") or {}).get("n") == 1 for c in adds)
               and [t for t, _ in totals] == ["1", "2"] and not any(e for _, e in totals))
    check("the agent's counter is exactly 2 (two counter_add calls of 1: totals 1 then 2)", ok_adds,
          short([((c.get("arguments") or {}).get("n"), t) for c, t in zip(adds, totals)]))
    # Sinks: only approved calls go out, each approval at most once; the denied one never.
    mine = [d for d in decisions.values() if d["agent"] == agent]
    approved, denied = [d for d in mine if d["approved"]], [d for d in mine if not d["approved"]]
    sent = [c for c in calls if c.get("tool") in ("note_put", "counter_add")]
    check("every sink call waited for an approval (one approval per call sent)", sent and len(sent) <= len(approved),
          f"{len(sent)} sink calls sent, {len(approved)} approvals")
    check(f"the denied call (counter_add n {DENIED_N}) was asked for and never reached the server",
          denied and not [c for c in adds if (c.get("arguments") or {}).get("n") != 1], short([d["question"][:120] for d in denied]))
    return out


def main():
    if not ADMIN:
        sys.exit("NEST_ADMIN_TOKEN is not set")
    if not MCP_URL or not MCP_TOKEN:
        sys.exit("MCP_TEST_URL and MCP_TEST_TOKEN must both be set")
    made = {"run": RUN, "capability": CAP, "template": TEMPLATE_NAME, "workstream": None, "agents": []}
    plan = {}  # agent -> {value, turn, epochs}
    ok = True

    def to_interrupt(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, to_interrupt)
    try:
        mark("start", base=BASE, cell=CELL, server=urllib.parse.urlsplit(MCP_URL).netloc, agents=AGENTS, model=MODEL, live_hosts=live_hosts())
        expect(AGENTS >= 1, "MCP_AGENTS must be at least 1", AGENTS)

        # 1. The server's state cleared; the token in BrokerDO; the capability and the template.
        s, v = mcp_api("POST", "/reset")
        expect(s in (200, 204), "POST /reset on the MCP test server", {"status": s, "body": v})
        s, v = mcp_api("GET", "/calls?since=0")
        expect(s == 200 and isinstance(v, dict) and v.get("calls") == [], "the server's call log is empty after the reset", v)
        s, v = api("PUT", f"/v1/admin/secrets/cap:{CAP}", {"value": MCP_TOKEN})
        expect(s in (200, 204), f"store the server's token as cap:{CAP}", {"status": s})
        s, v = api("PUT", f"/v1/admin/capabilities/{CAP}", CAPABILITY)
        expect(s == 200, f"PUT capability {CAP}", v)
        s, v = api("PUT", f"/v1/admin/templates/{TEMPLATE_NAME}", TEMPLATE)
        expect(s == 200, f"PUT template {TEMPLATE_NAME} (needs the nest capability)", v)
        mark("configured", capability=CAP, template=TEMPLATE_NAME, idempotent=[t for t, i in IDEMPOTENT.items() if i],
             read_only=CAPABILITY["mcp"]["read_only"])

        # 2. A workstream, the agents (not started: the turn wakes each), one turn each.
        s, v = api("POST", "/v1/workstreams", {"goal": f"remote MCP check {RUN}: {AGENTS} agents"})
        expect(s == 201, "create workstream", v)
        ws = made["workstream"] = v["workstream"]
        for _ in range(AGENTS):
            s, v = api("POST", "/v1/agents", {"template": TEMPLATE_NAME, "workstream": ws, "cell": CELL, "start": False})
            expect(s == 201, "create agent", v)
            made["agents"].append(v["agent"])
        agents = made["agents"]
        for a in agents:
            value = f"v-{secrets.token_hex(6)}"
            s, v = api("POST", f"/v1/agents/{a}/turns", {"text": turn_text(a, value), "request_id": f"{RUN}/{a}/turn"})
            expect(s == 201 and isinstance(v, dict) and v.get("turn"), f"enqueue {a}'s turn", v)
            plan[a] = {"value": value, "turn": v["turn"], "epochs": set()}
        mark("turns sent", workstream=ws, agents=agents)

        # 3. Wait for every turn, answering approvals and noting each brain's epoch while it runs. Done
        # means every turn done and no approval unanswered (each answer is a new turn).
        t0 = time.time()
        ever_live = set()
        decisions = {}

        def note_epochs():
            for a in agents:
                info = agent_info(a)
                if info and info.get("brain"):
                    ever_live.add(a)
                    plan[a]["epochs"].add(info["brain"]["epoch"])
        while True:
            note_epochs()
            decide(ws, decisions)
            st = {a: turn_statuses(a) for a in agents}
            log(f"turns {({a[-6:]: v for a, v in st.items()})}; brains seen {len(ever_live)}/{len(agents)}; decisions {len(decisions)}")
            if all(v and all(x == "done" for x in v) for v in st.values()) and decide(ws, decisions) == 0 \
                    and all(x == "done" for a in agents for x in turn_statuses(a)):
                break
            if any("interrupted" in v for v in st.values()):
                ok = False
                log("FAIL: a turn was interrupted")
                break
            if time.time() > t0 + TIMEOUT_S:
                ok = False
                log(f"FAIL: turns not all done within {TIMEOUT_S} s")
                break
            time.sleep(10)
        note_epochs()
        for a in agents:  # the latest start's epoch, whether or not a poll caught its brain
            info = agent_info(a)
            if info and isinstance(info.get("agent_epoch"), int) and (info.get("agent_epoch") or 0) > 0:
                plan[a]["epochs"].add(info["agent_epoch"])
        mark("turns ended", wall_s=round(time.time() - t0), epochs={a[-6:]: sorted(p["epochs"]) for a, p in plan.items()},
             approved=sum(d["approved"] for d in decisions.values()), denied=sum(not d["approved"] for d in decisions.values()))

        # The server's log: every call must belong to one of this run's agents (the log was reset).
        calls = server_calls()
        expect(calls is not None, "read the server's call log", None)
        for c in calls:
            record("call", seq=c.get("seq"), tool=c.get("tool"), arguments=c.get("arguments"), _meta=c.get("_meta"),
                   result_or_error=c.get("result_or_error"))
        stray = [{"seq": c.get("seq"), "tool": c.get("tool"), "_meta": c.get("_meta")} for c in calls
                 if (c.get("_meta") or {}).get("nest/agent") not in plan]
        log(f"server log: {len(calls)} calls; not from this run's agents: {len(stray)}")
        if stray:
            log(f"  FAIL: calls without one of this run's agents in _meta: {short(stray, 400)}")
            ok = False
        for a in agents:
            mine = [c for c in calls if (c.get("_meta") or {}).get("nest/agent") == a]
            results = verify(a, plan[a]["value"], plan[a]["epochs"], mine, decisions)
            # Taint as the platform records it: the turn_completed event carries the session's taint.
            evs = events(a)
            done = [m for m in (evs or []) if m.get("kind") == "turn_completed"]
            results.append(("the session is tainted (its turn_completed event says so)", bool(done) and all(m.get("taint") is True for m in done),
                            short([m.get("taint") for m in done]) if evs is not None else "events unavailable"))
            reply = done[-1].get("text", "") if done else ""
            record("agent", agent=a, value=plan[a]["value"], epochs=sorted(plan[a]["epochs"]), calls=len(mine), reply=reply,
                   checks=[{"check": n, "ok": g, "detail": d} for n, g, d in results])
            log(f"{a}: {len(mine)} calls ({', '.join(c.get('tool', '?') for c in mine)}); reply: {reply[:160]!r}")
            for n, g, d in results:
                log(f"  {'ok  ' if g else 'FAIL'} {n}{'' if g else f': {d}'}")
                ok &= g
            # Not a platform guarantee (the model's own words), so only reported.
            log(f"  info: the reply names the stored value: {plan[a]['value'] in reply}")

        # 4. Sleep: every brain that ran idle-exits, with no turn queued or active.
        t1 = time.time()
        gone_at = {}
        while time.time() < t1 + IDLE_S:
            for a in agents:
                if a in gone_at:
                    continue
                info = agent_info(a)
                live = None if info is None else bool(info.get("brain"))
                if live:
                    ever_live.add(a)
                pending = [x for x in turn_statuses(a) if x in ("queued", "active", None)]
                if live is False and not pending and a in ever_live:
                    gone_at[a] = round(time.time() - t1)
            log(f"brains exited {len(gone_at)}/{len(agents)}")
            if len(gone_at) == len(agents):
                break
            time.sleep(20)
        mark("asleep", exited_after_s={a[-6:]: s for a, s in gone_at.items()}, not_asleep=[a for a in agents if a not in gone_at],
             never_seen_with_a_brain=[a for a in agents if a not in ever_live])
        ok &= len(gone_at) == len(agents)
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
        # 5. Cleanup: not interruptible (each call has its own timeout), then the watches.
        old = signal.signal(signal.SIGINT, signal.SIG_IGN), signal.signal(signal.SIGTERM, signal.SIG_IGN)
        mark("cleanup")
        for a in made["agents"]:
            try:
                log(f"POST /v1/agents/{a}/stop: {api('POST', f'/v1/agents/{a}/stop')[0]}")
            except Exception as e:
                log(f"POST /v1/agents/{a}/stop: {type(e).__name__}")
        signal.signal(signal.SIGINT, old[0])
        signal.signal(signal.SIGTERM, old[1])
        try:
            left = None
            for _ in range(10):
                left = brains_on_hosts(set(made["agents"]))
                if left == []:
                    break
                time.sleep(15)
            mark("left after cleanup", brains="fleet unavailable" if left is None else left)
            ok &= left == []
            if DRAIN_S > 0:
                t2 = time.time()
                live = None
                while time.time() < t2 + DRAIN_S:
                    live = live_hosts()
                    log(f"draining: live hosts (id, role, status) {live}")
                    if live == []:
                        break
                    time.sleep(60)
                mark("drained", live_hosts=None if live is None else len(live), wall_s=round(time.time() - t2))
                ok &= live == []
        except KeyboardInterrupt:
            log("FAIL: interrupted while watching the cleanup")
            ok = False
    log("PASS" if ok else "FAIL")
    print(json.dumps(made))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

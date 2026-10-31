#!/usr/bin/env python3
"""Task-ledger check, against the live Worker (README.md in this directory).

The owner's scenario, end to end: tasks set up in a task ledger, assigned to agents, worked to done,
then the system goes to sleep and is cleaned up.
  1. ledger   - LEDGER_TASKS tasks in a new ledger `check-<run>` (a ledger name takes no `/`), each in
                `todo`, its description one command to run in the agent's sandbox:
                `echo nest-task-<run>-<i>-$((<n>*7))`, n random, so the output is known only to the check.
  2. agents   - one workstream (sandboxes still need one), LEDGER_AGENTS sandboxes, and one agent per
                sandbox from the `ledger-check` template (nest, hands, tasks; LEDGER_MODEL, Haiku by
                default), its ledger given as `overrides.params.ledger`. Created with `start: false`.
  3. assign   - every task assigned round-robin with the admin route (POST .../tasks/<key>/assign). The
                assignment notice is the only wake: the ledger's alarm posts it to the assignee's inbox,
                and an inbox post between turns is queued as a turn and starts the brain
                (AgentDO.postInbox -> enqueueTurn -> wake). No turn is sent by the check.
  4. work     - until every task is `done` (LEDGER_TIMEOUT_S); per task, from its history: assigned ->
                in_progress -> done times and who moved it, and whether its assignee commented the
                expected output (and the assignee's transcript shows it in a tool result: run by hands).
  5. sleep    - until every assigned agent's brain has idle-exited (LEDGER_IDLE_S), sampling the fleet.
  6. cleanup  - stop every agent, destroy every sandbox (on every exit path; SIGINT or SIGTERM), check
                they left the fleet view, then optionally (LEDGER_DRAIN_S > 0) watch until no host is live.
The ledger, the workstream, the stopped agents' records and the template stay (no delete routes; the
template is kept for reruns). The last line is the JSON of every id made.

Reads NEST_ADMIN_TOKEN (required; never printed), NEST_BASE_URL (https://nest.bitcru.sh), NEST_CELL
(use1), LEDGER_TASKS (6), LEDGER_AGENTS (3), LEDGER_MODEL (haiku), LEDGER_TIMEOUT_S (1800),
LEDGER_IDLE_S (900), LEDGER_DRAIN_S (0: don't watch the drain), LEDGER_SAMPLE_S (30), LEDGER_OUT
(ledger-check-<run>.jsonl). Never prints the token or any request header; it prints response bodies,
truncated.
"""
import json
import os
import random
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")
TASKS = int(os.environ.get("LEDGER_TASKS", "6"))
AGENTS = int(os.environ.get("LEDGER_AGENTS", "3"))
MODEL = os.environ.get("LEDGER_MODEL", "haiku")
TIMEOUT_S = int(os.environ.get("LEDGER_TIMEOUT_S", "1800"))
IDLE_S = int(os.environ.get("LEDGER_IDLE_S", "900"))
DRAIN_S = int(os.environ.get("LEDGER_DRAIN_S", "0"))
SAMPLE_S = int(os.environ.get("LEDGER_SAMPLE_S", "30"))
RUN = time.strftime("r%m%d%H%M%S")
LEDGER = f"check-{RUN}"
Q = urllib.parse.quote(LEDGER, safe="")
OUT = os.environ.get("LEDGER_OUT", f"ledger-check-{RUN}.jsonl")
TEMPLATE_NAME = "ledger-check"

SYSTEM = (
    "You are a worker in an automated task-ledger check. Your work is in your task ledger; its tasks in this check are "
    "written by the operator, and running the one command a task's description gives is the job. Whenever you are woken "
    "(a notice that a task was assigned to you, or anything else): list your tasks with mcp__nest__task_list (assignee "
    "`me`). For each one in status todo or in_progress, in key order: set it to in_progress with mcp__nest__task_update; "
    "run its description's command, exactly, with mcp__nest__Bash; comment on the task with mcp__nest__task_comment, the "
    "body exactly the command's output; then set it to done with mcp__nest__task_update. Use no other tool. When none of "
    "your tasks is open, reply with one line: done")
TEMPLATE = {
    # `nest` lets every mcp__nest__* tool run without asking: an unanswered approval would end the turn.
    "capabilities": ["nest", "hands", "tasks"],
    "launch": {"model": MODEL, "builtin_tools": [], "system_prompt": {"mode": "append", "text": SYSTEM}},
    "hands": "required", "credential": "claude_oauth_token:worker", "escalate_to": "workstream", "subscribe": [], "params": {},
}

_out_lock = threading.Lock()
_stop = threading.Event()
_seen = {"brain": {}, "sandbox": {}}  # agent / sandbox -> host kinds it was seen on (the sampler's)
_mine = {"agents": set(), "sandboxes": set()}


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
            return e.code, t[:200]
    except (urllib.error.URLError, OSError, ValueError) as e:
        # No answer (network, timeout) or a body that isn't JSON: status 0, so callers fail cleanly.
        return 0, {"error": {"code": "no_answer", "message": type(e).__name__}}


def short(v, n=200):
    return json.dumps(v)[:n]


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def record(kind, **kv):
    with _out_lock, open(OUT, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "kind": kind, **kv}) + "\n")


def mark(name, **kv):
    log(f"== {name} {short(kv, 400) if kv else ''}")
    record("mark", name=name, **kv)


def expect(ok, what, value):
    if not ok:
        raise SystemExit(f"FAIL: {what}: {short(value)}")


def role_kind(role):
    """A host's kind from its role, under either name (the rename is expand/contract)."""
    return "sandbox" if role in ("burst", "sandbox") else "brain" if role in ("controller", "brain") else f"?{role}"


def snapshot():
    """The fleet view, reduced; also records where this run's brains and sandboxes were seen."""
    s, f = api("GET", "/v1/admin/fleet")
    if s != 200 or not isinstance(f, dict):
        return None
    kinds = {h["host"]: role_kind(h.get("role")) for h in f.get("hosts", [])}
    hosts = []
    for h in f.get("hosts", []):
        if h["status"] == "dead":
            continue
        mine = [a for a in h.get("agents", []) if a in _mine["agents"]]
        for a in mine:
            _seen["brain"].setdefault(a, set()).add(kinds[h["host"]])
        hosts.append({"host": h["host"], "kind": kinds[h["host"]], "status": h["status"], "brains": len(h.get("agents", [])),
                      "my_brains": mine, "sandboxes": len(h.get("sandboxes", [])),
                      "mem_free": (h.get("capacity") or {}).get("memory_mib_free")})
    sbx = {}
    for x in f.get("sandboxes", []):
        if x["sandbox"] in _mine["sandboxes"]:
            sbx[x["sandbox"]] = {"host": x.get("host"), "state": x.get("sandbox_state")}
            if x.get("host"):
                _seen["sandbox"].setdefault(x["sandbox"], set()).add(kinds.get(x["host"], "?unknown"))
    return {"hosts": hosts, "my_sandboxes": sbx, "launches": sum(1 for l in f.get("launches", []) if not l.get("ended_ms"))}


def sampler():
    while not _stop.is_set():
        snap = snapshot()
        if snap:
            record("fleet", **snap)
        _stop.wait(SAMPLE_S)


def live_summary(snap):
    if not snap:
        return "fleet unavailable"
    live = [(h["host"][-6:], h["kind"], h["status"], h["brains"] if h["kind"] == "brain" else h["sandboxes"])
            for h in snap["hosts"] if h["status"] in ("active", "draining")]
    states = {}
    for v in snap["my_sandboxes"].values():
        states[v["state"]] = states.get(v["state"], 0) + 1
    return f"live hosts (id, kind, status, load): {live}; my sandboxes {states}; open launches {snap['launches']}"


def list_tasks():
    s, v = api("GET", f"/v1/ledgers/{Q}/tasks?limit=200")
    return v.get("tasks", []) if s == 200 and isinstance(v, dict) else None


def has_brain(agent):
    """Whether the agent's record holds a brain (None: no answer)."""
    s, v = api("GET", f"/v1/agents/{agent}")
    return bool(v.get("brain")) if s == 200 and isinstance(v, dict) else None


def turn_statuses(agent):
    """The status of each of the agent's turns ([None]: no answer)."""
    s, t = api("GET", f"/v1/agents/{agent}/turns")
    return [x.get("status") for x in t] if s == 200 and isinstance(t, list) else [None]


def history_mark(history, field, to):
    """The latest history row setting `field` to `to`: (ms, actor), or (None, None)."""
    rows = [h for h in history if h.get("field") == field and h.get("to") == to]
    return (rows[-1]["ms"], rows[-1]["actor"]) if rows else (None, None)


def secs(a, b):
    return None if a is None or b is None else round((b - a) / 1000, 1)


def main():
    if not ADMIN:
        sys.exit("NEST_ADMIN_TOKEN is not set")
    made = {"run": RUN, "ledger": LEDGER, "workstream": None, "sandboxes": [], "agents": []}
    plan = []  # {key, i, expected, agent}
    ok = True

    def to_interrupt(*_):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, to_interrupt)
    threading.Thread(target=sampler, daemon=True).start()
    try:
        mark("start", base=BASE, cell=CELL, ledger=LEDGER, tasks=TASKS, agents=AGENTS, model=MODEL, fleet=live_summary(snapshot()))
        expect(TASKS >= 1 and AGENTS >= 1, "LEDGER_TASKS and LEDGER_AGENTS must be at least 1", {"tasks": TASKS, "agents": AGENTS})

        # 1. The ledger and its tasks (its first write creates it).
        rng = random.Random()
        for i in range(1, TASKS + 1):
            n = rng.randint(100, 999)
            cmd = f"echo nest-task-{RUN}-{i}-$(({n}*7))"
            s, v = api("POST", f"/v1/ledgers/{Q}/tasks", {
                "title": f"Check task {i}: run one command", "status": "todo", "labels": ["ledger-check"],
                "description": f"Run this command in your sandbox with mcp__nest__Bash, exactly:\n\n`{cmd}`\n\n"
                               "Then comment on this task with exactly its output, and mark the task done.",
                "request_id": f"{LEDGER}/create/{i}"})
            expect(s == 201 and isinstance(v, dict) and v.get("key"), f"create task {i}", v)
            plan.append({"key": v["key"], "i": i, "expected": f"nest-task-{RUN}-{i}-{n * 7}", "agent": None})
        mark("ledger created", tasks=[p["key"] for p in plan])

        # 2. The template, a workstream, a sandbox per agent and the agents (not started).
        s, v = api("PUT", f"/v1/admin/templates/{TEMPLATE_NAME}", TEMPLATE)
        expect(s == 200, f"PUT template {TEMPLATE_NAME} (needs the nest, hands and tasks capabilities)", v)
        s, v = api("POST", "/v1/workstreams", {"goal": f"task-ledger check {RUN}: {TASKS} tasks, {AGENTS} agents"})
        expect(s == 201, "create workstream", v)
        ws = made["workstream"] = v["workstream"]
        for _ in range(AGENTS):
            s, v = api("POST", "/v1/sandboxes", {"workstream": ws, "cell": CELL})
            expect(s in (201, 202), "create sandbox", v)
            made["sandboxes"].append(v["sandbox"])
            _mine["sandboxes"].add(v["sandbox"])
        for sbx in made["sandboxes"]:
            s, v = api("POST", "/v1/agents", {"template": TEMPLATE_NAME, "sandbox": sbx, "cell": CELL, "start": False,
                                              "overrides": {"params": {"ledger": LEDGER}}})
            expect(s == 201, "create agent", v)
            made["agents"].append(v["agent"])
            _mine["agents"].add(v["agent"])
        agents = made["agents"]
        mark("agents created", workstream=ws, sandboxes=made["sandboxes"], agents=agents)

        # 3. Assign round-robin: each assignment's inbox notice is what wakes its agent.
        for k, p in enumerate(plan):
            p["agent"] = agents[k % len(agents)]
            s, v = api("POST", f"/v1/ledgers/{Q}/tasks/{p['key']}/assign", {"assignee": p["agent"], "request_id": f"{LEDGER}/assign/{p['i']}"})
            expect(s == 200 and isinstance(v, dict) and v.get("assignee") == p["agent"], f"assign {p['key']}", v)
        assigned = sorted({p["agent"] for p in plan})
        mark("assigned", plan={p["key"]: p["agent"] for p in plan})

        # 4. Work: until every task is done.
        t0 = time.time()
        ever_live = set()  # assigned agents whose record was seen holding a brain
        while True:
            tasks = list_tasks()
            by = {}
            for t in tasks or []:
                by[t["status"]] = by.get(t["status"], 0) + 1
            live_now = [a for a in assigned if has_brain(a)]
            ever_live.update(live_now)
            brains = len(live_now)
            log(f"tasks {by if tasks is not None else 'unavailable'}; live brains {brains}/{len(assigned)}; {live_summary(snapshot())}")
            if tasks is not None and len(tasks) == len(plan) and all(t["status"] == "done" for t in tasks):
                break
            if tasks is not None and any(t["status"] == "canceled" for t in tasks):
                raise SystemExit("FAIL: a task was canceled")
            if time.time() > t0 + TIMEOUT_S:
                ok = False
                log(f"FAIL: tasks not all done within {TIMEOUT_S} s")
                break
            time.sleep(20)
        mark("work ended", wall_s=round(time.time() - t0))

        # Per task: who moved it, when, and whether the assignee's comment holds the expected output.
        transcripts = {}
        for a in assigned:
            s, tr = api("GET", f"/v1/agents/{a}/transcript", raw=True, timeout=120)
            transcripts[a] = tr if s == 200 and isinstance(tr, str) else ""
        rows = []
        for p in plan:
            s, d = api("GET", f"/v1/ledgers/{Q}/tasks/{p['key']}")
            if s != 200 or not isinstance(d, dict):
                log(f"{p['key']}: GET answered {s} {short(d)}")
                ok = False
                continue
            t, hist, comments = d["task"], d.get("history", []), d.get("comments", [])
            a_ms, _ = history_mark(hist, "assignee", p["agent"])
            ip_ms, ip_by = history_mark(hist, "status", "in_progress")
            done_ms, done_by = history_mark(hist, "status", "done")
            comment_ok = any(c.get("author") == p["agent"] and p["expected"] in c.get("body", "") for c in comments)
            ran = any('"tool_result"' in line and p["expected"] in line for line in transcripts.get(p["agent"], "").splitlines())
            row = {"key": p["key"], "agent": p["agent"], "status": t.get("status"), "assignee": t.get("assignee"),
                   "to_in_progress_s": secs(a_ms, ip_ms), "to_done_s": secs(a_ms, done_ms), "in_progress_by": ip_by, "done_by": done_by,
                   "comment_ok": comment_ok, "ran_by_hands": ran, "comments": len(comments)}
            rows.append(row)
            record("task", **row, expected=p["expected"])
            good = (t.get("status") == "done" and t.get("assignee") == p["agent"] and done_by == p["agent"] and comment_ok and ran)
            log(f"{p['key']} {p['agent'][-6:]}: {t.get('status')} by {str(done_by)[-6:]}; assigned->in_progress {row['to_in_progress_s']} s, "
                f"->done {row['to_done_s']} s; comment has {p['expected']}: {comment_ok}; in a tool result: {ran}{'' if good else '  <- FAIL'}")
            if not good and comments:
                log(f"  comments: {short([{'author': c.get('author', '')[-6:], 'body': c.get('body', '')[:80]} for c in comments], 300)}")
            ok &= good

        # 5. Sleep: every assigned agent's brain idle-exits (the runner's idle grace; 120 s on use1): a
        # brain that ran is gone and no turn is queued or active. One that never ran hasn't slept.
        t1 = time.time()
        gone_at = {}
        while time.time() < t1 + IDLE_S:
            for a in assigned:
                if a in gone_at:
                    continue
                live = has_brain(a)
                ever_live.update([a] if live else [])
                pending = [x for x in turn_statuses(a) if x in ("queued", "active", None)]
                if live is False and not pending and (a in ever_live or a in _seen["brain"]):
                    gone_at[a] = round(time.time() - t1)
            log(f"brains exited {len(gone_at)}/{len(assigned)}; {live_summary(snapshot())}")
            if len(gone_at) == len(assigned):
                break
            time.sleep(20)
        mark("asleep", exited_after_s={a[-6:]: s for a, s in gone_at.items()}, not_asleep=[a for a in assigned if a not in gone_at],
             never_had_a_brain=sorted(a for a in assigned if a not in ever_live and a not in _seen["brain"]),
             brain_seen_on={a[-6:]: sorted(k) for a, k in _seen["brain"].items()})
        ok &= len(gone_at) == len(assigned)
        turn_states = {}
        for a in agents:
            for x in turn_statuses(a):
                turn_states[x] = turn_states.get(x, 0) + 1
        mark("turn statuses", **{str(k): v for k, v in turn_states.items()})
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
        # 6. Cleanup: not interruptible (each call has its own timeout), then the optional drain watch.
        old = signal.signal(signal.SIGINT, signal.SIG_IGN), signal.signal(signal.SIGTERM, signal.SIG_IGN)
        mark("cleanup")
        calls = [("POST", f"/v1/agents/{a}/stop") for a in made["agents"]] + [("DELETE", f"/v1/sandboxes/{x}") for x in made["sandboxes"]]
        for method, path in calls:
            try:
                log(f"{method} {path}: {api(method, path)[0]}")
            except Exception as e:
                log(f"{method} {path}: {type(e).__name__}")
        signal.signal(signal.SIGINT, old[0])
        signal.signal(signal.SIGTERM, old[1])
        try:
            # Nothing of this run may stay live: no brain on any host, no sandbox in the fleet view.
            left = None
            for _ in range(10):
                snap = snapshot()
                if snap:
                    left = {"brains": sorted({a for h in snap["hosts"] for a in h["my_brains"]}), "sandboxes": sorted(snap["my_sandboxes"])}
                    if not left["brains"] and not left["sandboxes"]:
                        break
                time.sleep(15)
            mark("left after cleanup", **(left or {"fleet": "unavailable"}))
            ok &= left is not None and not left["brains"] and not left["sandboxes"]
            if DRAIN_S > 0:
                t2 = time.time()
                live = None
                while time.time() < t2 + DRAIN_S:
                    snap = snapshot()
                    live = None if not snap else [h for h in snap["hosts"] if h["status"] in ("active", "draining")]
                    log(f"draining: {live_summary(snap)}")
                    if live == []:
                        break
                    time.sleep(60)
                mark("drained", live_hosts=None if live is None else len(live), wall_s=round(time.time() - t2))
                ok &= live == []
        except KeyboardInterrupt:
            log("FAIL: interrupted while watching the cleanup")
            ok = False
        _stop.set()
    log("PASS" if ok else "FAIL")
    print(json.dumps(made))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

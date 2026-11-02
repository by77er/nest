#!/usr/bin/env python3
"""Stress test of a cell, against the live Worker (README.md in this directory).

Phases, each timed:
  1. sandboxes - STRESS_AGENTS sandboxes created at once, in a cold or warm cell: how fast hosts
                launch, how many sandboxes a host takes, what a launch past the quota does.
  2. turns    - one `stress` agent per sandbox (Haiku), each given one turn: run `hostname` through
                hands and reply with it. Brains pack onto brain hosts.
  3. idle     - nothing more is sent: brains should exit at the runner's idle grace.
  4. cleanup  - agents stopped, sandboxes destroyed; then the fleet is watched until no host of
                either kind is live (or STRESS_DRAIN_S passes).
A sampler records the fleet view every STRESS_SAMPLE_S throughout (hosts, brains and sandboxes per
host, each host's free memory, launches) to STRESS_OUT (JSONL), with the phase marks, so limits can
be read afterwards. Cleanup runs on every exit path; the last line is the JSON of every id made.

Reads NEST_ADMIN_TOKEN (required; never printed), NEST_BASE_URL, NEST_CELL (use1), STRESS_AGENTS
(50), STRESS_PHASES (sandboxes,turns,idle,cleanup),
STRESS_MODEL (haiku), STRESS_TIMEOUT_S (2400 per phase), STRESS_DRAIN_S (2700), STRESS_SAMPLE_S (15),
STRESS_OUT (stress-<run>.jsonl).
"""
import concurrent.futures as cf
import json
import os
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = os.environ.get("NEST_BASE_URL", "https://nest.bitcru.sh").rstrip("/")
CELL = os.environ.get("NEST_CELL", "use1")
ADMIN = os.environ.get("NEST_ADMIN_TOKEN", "")
N = int(os.environ.get("STRESS_AGENTS", "50"))
PHASES = os.environ.get("STRESS_PHASES", "sandboxes,turns,idle,cleanup").split(",")
MODEL = os.environ.get("STRESS_MODEL", "haiku")
# STRESS_HANDS=0: agents without sandboxes (brains only).
HANDS = os.environ.get("STRESS_HANDS", "1") != "0"
TIMEOUT_S = int(os.environ.get("STRESS_TIMEOUT_S", "2400"))
DRAIN_S = int(os.environ.get("STRESS_DRAIN_S", "2700"))
SAMPLE_S = int(os.environ.get("STRESS_SAMPLE_S", "15"))
RUN = time.strftime("r%m%d%H%M")
OUT = os.environ.get("STRESS_OUT", f"stress-{RUN}.jsonl")
SYSTEM = "You are one agent in an automated load test. Keep every reply to one short line and use no tool beyond what a step names."
TEMPLATE = {
    # `nest` lets hands run without asking (the worker template's rule): an unanswered approval would end
    # every agent's turn before its first command.
    "capabilities": ["nest", "hands"] if HANDS else ["nest"],
    "launch": {"model": MODEL, "builtin_tools": [], "system_prompt": {"mode": "append", "text": SYSTEM}},
    "hands": "required" if HANDS else "forbidden", "credential": "claude_oauth_token:worker",
}

_out_lock = threading.Lock()
_stop = threading.Event()


def api(method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    sep = "&" if "?" in path else "?"
    req = urllib.request.Request(f"{BASE}{path}{sep}cell={CELL}", data=data, method=method, headers={
        "authorization": f"Bearer {ADMIN}", "content-type": "application/json", "user-agent": "nest-stress/1"})
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


def log(m):
    print(time.strftime("%H:%M:%S"), m, flush=True)


def record(kind, **kv):
    with _out_lock, open(OUT, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "kind": kind, **kv}) + "\n")


def mark(name, **kv):
    log(f"== {name} {json.dumps(kv)[:300] if kv else ''}")
    record("mark", name=name, **kv)


def role_kind(role):
    return "sandbox" if role in ("burst", "sandbox") else "brain" if role in ("controller", "brain") else role


def snapshot():
    s, f = api("GET", "/v1/admin/fleet")
    if s != 200:
        return None
    hosts = [{"host": h["host"], "kind": role_kind(h.get("role")), "status": h["status"], "brains": len(h.get("agents", [])),
              "sandboxes": len(h.get("sandboxes", [])), "mem_free": (h.get("capacity") or {}).get("memory_mib_free"),
              "max_brains": h.get("max_brains"), "connected": h.get("connected"), "instance": h.get("instance_id")}
             for h in f["hosts"] if h["status"] not in ("dead",)]
    sbx = f.get("sandboxes", [])
    return {"hosts": hosts, "launches": [l for l in f.get("launches", []) if not l.get("ended_ms")],
            "sandboxes": len(sbx), "placed": sum(1 for x in sbx if x.get("host"))}


def sampler():
    while not _stop.is_set():
        snap = snapshot()
        if snap:
            record("fleet", **snap)
        _stop.wait(SAMPLE_S)


def live_summary(snap):
    if not snap:
        return "fleet unavailable"
    by = {}
    for h in snap["hosts"]:
        if h["status"] in ("active", "draining"):
            by.setdefault(h["kind"], []).append(f"{h['brains'] if h['kind'] == 'brain' else h['sandboxes']}@{h['mem_free']}")
    return f"hosts {by}; sandboxes placed {snap['placed']}/{snap['sandboxes']}; pending launches {len(snap['launches'])}"


def pmap(fn, items, workers=25):
    with cf.ThreadPoolExecutor(workers) as ex:
        return list(ex.map(fn, items))


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p / 100 * len(xs)))] if xs else None


def main():
    if not ADMIN:
        sys.exit("NEST_ADMIN_TOKEN is not set")
    made = {"run": RUN, "sandboxes": [], "agents": []}
    ok = True
    threading.Thread(target=sampler, daemon=True).start()
    try:
        mark("start", base=BASE, cell=CELL, n=N, phases=PHASES, model=MODEL, hands=HANDS, fleet=live_summary(snapshot()))

        if HANDS and "sandboxes" in PHASES:
            mark("sandboxes create")
            t0 = time.time()
            res = pmap(lambda _: api("POST", "/v1/sandboxes", {"cell": CELL}), range(N))
            for s, v in res:
                if s in (201, 202):
                    made["sandboxes"].append(v["sandbox"])
                else:
                    log(f"sandbox create refused: {s} {json.dumps(v)[:200]}")
            mark("sandboxes created", n=len(made["sandboxes"]), wall_s=round(time.time() - t0, 1),
                 statuses={str(s): sum(1 for x, _ in res if x == s) for s in {x for x, _ in res}})
            mine = set(made["sandboxes"])
            deadline = time.time() + TIMEOUT_S
            placed_at = {}
            while time.time() < deadline:
                s, f = api("GET", "/v1/admin/fleet")
                if s == 200:
                    for x in f.get("sandboxes", []):
                        if x["sandbox"] in mine and x.get("host") and x["sandbox"] not in placed_at:
                            placed_at[x["sandbox"]] = time.time() - t0
                log(f"placed {len(placed_at)}/{len(mine)}; {live_summary(snapshot())}")
                if len(placed_at) == len(mine):
                    break
                time.sleep(20)
            ts = sorted(placed_at.values())
            mark("sandboxes placed", placed=len(ts), of=len(mine), first_s=ts and round(ts[0]), p50_s=ts and round(pct(ts, 50)),
                 last_s=ts and round(ts[-1]))

        if "turns" in PHASES:
            s, v = api("PUT", "/v1/admin/templates/stress", TEMPLATE)
            if s != 200:
                raise SystemExit(f"FAIL: catalog: {s} {v}")

            mark("agents create")
            t0 = time.time()
            spawn = [{"template": "stress", "cell": CELL, "start": False, **({"sandbox": x} if x else {})}
                     for x in (made["sandboxes"] if HANDS else [None] * N)]
            res = pmap(lambda b: api("POST", "/v1/agents", b), spawn)
            for s, v in res:
                if s == 201:
                    made["agents"].append(v["agent"])
                else:
                    log(f"agent create refused: {s} {json.dumps(v)[:200]}")
            agents = made["agents"]
            mark("agents created", n=len(agents), wall_s=round(time.time() - t0, 1))
            starts = pmap(lambda a: api("POST", f"/v1/agents/{a}/start"), agents)
            mark("starts sent", statuses={str(s): sum(1 for x, _ in starts if x == s) for s in {x for x, _ in starts}},
                 sample=[json.dumps(v)[:160] for s, v in starts if s != 200][:3])
            n = len(agents)
            text = ("Step 1: run `hostname` with mcp__nest__Bash. Step 2: reply with its output." if HANDS
                    else "Reply with the word `done`.")
            turns = pmap(lambda a: api("POST", f"/v1/agents/{a}/turns", {"text": text}), agents)
            mark("turns queued", ok=sum(1 for s, _ in turns if s in (200, 201, 202)))

            deadline = time.time() + TIMEOUT_S
            done_at = {}
            while time.time() < deadline:
                states = pmap(lambda a: api("GET", f"/v1/agents/{a}/turns"), agents)
                for a, (s, t) in zip(agents, states):
                    if a not in done_at and isinstance(t, list) and t and all(x.get("status") in ("done", "interrupted", "dropped") for x in t):
                        done_at[a] = time.time() - t0
                log(f"turns done {len(done_at)}/{n}; {live_summary(snapshot())}")
                if len(done_at) >= n:
                    break
                time.sleep(20)
            ts = sorted(done_at.values())
            mark("turns done", done=len(ts), n=n, first_s=ts and round(ts[0]), p50_s=ts and round(pct(ts, 50)), last_s=ts and round(ts[-1]))
            ok &= len(ts) >= n
            turn_states = pmap(lambda a: api("GET", f"/v1/agents/{a}/turns"), agents)
            st = {}
            for s, t in turn_states:
                for x in (t if isinstance(t, list) else []):
                    st[x.get("status")] = st.get(x.get("status"), 0) + 1
            mark("turn statuses", **{str(k): v for k, v in st.items()})

        if "idle" in PHASES and made["agents"]:
            t0 = time.time()
            deadline = t0 + 900
            while time.time() < deadline:
                infos = pmap(lambda a: api("GET", f"/v1/agents/{a}"), made["agents"])
                live = sum(1 for s, v in infos if s == 200 and v.get("brain"))
                log(f"brains still live {live}/{len(made['agents'])}; {live_summary(snapshot())}")
                if live == 0:
                    break
                time.sleep(20)
            mark("idle done", live_brains=live, wall_s=round(time.time() - t0))
    except SystemExit as e:
        log(str(e))
        ok = False
    except Exception as e:
        log(f"FAIL: {type(e).__name__}: {str(e)[:200]}")
        ok = False
    finally:
        mark("cleanup")
        r1 = pmap(lambda a: api("POST", f"/v1/agents/{a}/stop")[0], made["agents"])
        r2 = pmap(lambda x: api("DELETE", f"/v1/sandboxes/{x}")[0], made["sandboxes"])
        mark("cleanup sent", stops={str(s): r1.count(s) for s in set(r1)}, destroys={str(s): r2.count(s) for s in set(r2)})
        if "cleanup" in PHASES:
            t0 = time.time()
            while time.time() < t0 + DRAIN_S:
                snap = snapshot()
                live = [h for h in (snap or {}).get("hosts", []) if h["status"] in ("active", "draining")]
                log(f"draining: {live_summary(snap)}")
                if snap and not live:
                    break
                time.sleep(60)
            mark("drained", live_hosts=len(live), wall_s=round(time.time() - t0))
        _stop.set()
    log("PASS" if ok else "FAIL")
    print(json.dumps(made))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

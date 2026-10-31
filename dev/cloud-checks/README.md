# Cloud checks

Scripted checks against the live control plane (`https://nest.bitcru.sh`, cell `use1`), run by hand after a deploy whose behaviour only the cloud can show: real hosts, the tunnel, Cloudflare Access and real Claude Code. They aren't CI jobs: they spend EC2 time and subscription quota, and they need the admin token, which CI never holds.

**Rules:**
- **Credentials:** export `NEST_ADMIN_TOKEN` in your shell from wherever you keep it. Never pass it on a command line or print it. The scripts print response bodies only, never headers.
- **Cleanup:** a check cleans up what it creates on every exit path, and prints the ids it created so leftovers can be found.
- **Evidence:** a pass is evidence for that deploy's commit and that cell at that time (cloud tier, [practices](../practices.md#evidence-tiers)).

## `brain_hosts_check.py`

Brain hosts end to end: every brain runs on a brain host, every sandbox on a sandbox host, and each brain runs a command through hands (its transcript shows the output; the script doesn't check which sandbox ran it).

```bash
read -rs NEST_ADMIN_TOKEN && export NEST_ADMIN_TOKEN   # or load it from your env file; never echo it
python3 -I dev/cloud-checks/brain_hosts_check.py
```

| | |
|---|---|
| **Settings** | `NEST_BASE_URL` (default `https://nest.bitcru.sh`), `NEST_CELL` (`use1`), `CHECK_AGENTS` (2), `CHECK_TIMEOUT_S` (1800) |
| **Creates** | one workstream; `CHECK_AGENTS` sandboxes; one `worker` agent per sandbox, each given one turn that runs `hostname; echo nest-ok-$((6*7))` through `mcp__nest__Bash`. In a cold cell, the autoscaler launches a brain host and a sandbox host (spot EC2) |
| **Passes when** | every turn is `done`; every transcript contains `nest-ok-42`; while it polled the fleet view (every 30 s), each brain was seen only on a brain host and each sandbox only on a sandbox host (either role name counts) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the agent and sandbox ids |
| **Cleans up** | stops every agent (`POST /v1/agents/<id>/stop`) and destroys every sandbox (`DELETE /v1/sandboxes/<id>`), on every exit path |
| **Leaves** | the workstream and the stopped agents' records (there is no delete route for either yet); the hosts it caused to launch, which retire after the cell's idle grace. |
| **Costs** | a few minutes of two spot instances from a cold cell, and one short Claude Code turn per agent on the subscription |

**Leftovers after an interrupted run:** `GET /v1/admin/fleet?cell=use1` lists live sandboxes and each host's brains. Stop and destroy the ids from the last line (or the log) with the same two routes.

## `stress.py`

A stress test of a cell: the control plane alone, then many agents and sandboxes at once, timed phase by phase, with the fleet view sampled throughout so a cell's limits can be read afterwards.

```bash
STRESS_AGENTS=50 python3 -I dev/cloud-checks/stress.py      # STRESS_HANDS=0: brains and channels only
```

| | |
|---|---|
| **Phases** (`STRESS_PHASES`) | `flood`: `FLOOD_POSTERS` concurrent operator posters × `FLOOD_POSTS` to one channel (latency percentiles, errors). `sandboxes`: `STRESS_AGENTS` sandboxes at once (placement and host launches). `ring`: one `stress` agent per sandbox (Haiku; `STRESS_MODEL`), each posting a ping to `stress/<run>` that mentions the next and woken by the one that mentions it (a `once` subscription) to post a pong. `idle`: until every brain has exited. `cleanup`: stop and destroy, then watch until no host is live (`STRESS_DRAIN_S`) |
| **Creates** | one workstream; the sandboxes and agents; the `stress` template and `stress-chat` capability (kept, for reruns); channels `stress/<run>` and `stress/<run>/flood` (no delete route) |
| **Records** | `STRESS_OUT` (JSONL): every `STRESS_SAMPLE_S` the fleet (hosts by kind, brains and sandboxes per host, each host's free memory, open launches), and the phase marks with their timings |
| **Cleans up** | stops every agent and destroys every sandbox on every exit path (interrupt it with SIGINT, not SIGTERM); the last line is the JSON of the ids it made |
| **Costs** | at 50 agents on `use1`: about $0.20 of spot EC2 for a run, plus two short Haiku turns per agent on the subscription |

**First run (2026-10-31, `use1`, caps raised by #54):** the findings are in [the stress test notes](stress-2026-10-31.md).

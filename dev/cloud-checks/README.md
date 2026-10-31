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

## `ledger_check.py`

The [task ledger](../../docs/control-plane/durable-objects/tasks/) end to end: tasks set up in a ledger, assigned to agents, worked to `done` through hands, then the system goes to sleep and is cleaned up.

```bash
python3 -I dev/cloud-checks/ledger_check.py      # LEDGER_DRAIN_S=2700: also watch the cell drain to zero hosts
```

| | |
|---|---|
| **Settings** | `NEST_BASE_URL` (default `https://nest.bitcru.sh`), `NEST_CELL` (`use1`), `LEDGER_TASKS` (6), `LEDGER_AGENTS` (3), `LEDGER_MODEL` (`haiku`), `LEDGER_TIMEOUT_S` (1800, for the work), `LEDGER_IDLE_S` (900, for the brains to exit), `LEDGER_DRAIN_S` (0: not watched), `LEDGER_SAMPLE_S` (30), `LEDGER_OUT` (`ledger-check-<run>.jsonl`) |
| **Creates** | ledger `check-<run>` (a ledger name takes no `/`) with `LEDGER_TASKS` tasks in `todo`, each describing one command, `echo nest-task-<run>-<i>-$((<n>*7))` with a random `n`; the `ledger-check` template (`nest`, `hands`, `tasks`; kept, for reruns); one workstream (sandboxes still need one); `LEDGER_AGENTS` sandboxes and one agent per sandbox, created with `start: false` and `overrides.params.ledger` set to the run's ledger. In a cold cell, the autoscaler launches a brain host and a sandbox host |
| **Wakes** | only the assignments: every task is assigned round-robin with `POST /v1/ledgers/<name>/tasks/<key>/assign`. Its notice reaches the assignee's inbox from the ledger's alarm, and an inbox post between turns is queued as a turn that starts the brain (`AgentDO.postInbox`); mid-turn it joins the running turn. The check sends no turn. The template's prompt tells an agent, whenever woken, to work each of its open tasks: `in_progress`, the command through `mcp__nest__Bash`, a comment holding the output, `done` |
| **Records** | per task, from its history: assigned → `in_progress` → `done` times, who moved it, and the comment check; every `LEDGER_SAMPLE_S` the fleet (hosts by kind and load, where this run's brains and sandboxes are, the sandboxes' states), in `LEDGER_OUT` (JSONL) |
| **Passes when** | every task is `done`, still assigned to its assignee, moved to `done` by it, with a comment by it holding the expected output, which its transcript also shows in a tool result (run through hands, not computed); every assigned agent's brain ran and then idle-exited with no turn queued or active, within `LEDGER_IDLE_S`; after cleanup, no brain of the run is on any host and none of its sandboxes is in the fleet view; with `LEDGER_DRAIN_S` set, no host of the cell is live within it (any other workload's host fails it too) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, ledger, workstream, agent and sandbox ids |
| **Cleans up** | stops every agent and destroys every sandbox on every exit path, SIGINT and SIGTERM included (the stop and destroy calls themselves aren't interruptible; the watch after them is) |
| **Leaves** | the ledger and its tasks (there is no delete route for a task or a ledger), the workstream, the stopped agents' records and the template; the hosts it caused to launch, which retire after the cell's idle grace (sandbox hosts 10 min, brain hosts 30 min on `use1`) |
| **Costs** | a few minutes of two spot instances from a cold cell (25 to 32 min after the last brain to drain, as the stress test found), and one or two short Haiku turns per agent on the subscription |

**Leftovers after an interrupted run:** as for `brain_hosts_check.py`; `GET /v1/ledgers/check-<run>/tasks` shows how far the work got.

**Sanity-checked locally (2026-10-31)** against `npm run dev` with no hosts (`NEST_CELL=local`): the ledger, template, sandbox, agent and assignment calls answer as the script expects, each assignment queued one `inbox` turn on its assignee (`Message from tasks:<ledger>: assigned T-1 …`), and the timeout, SIGINT and SIGTERM paths all cleaned up and printed the ids. That is no evidence for the cloud run.

## `mcp_check.py`

[Remote MCP capabilities](../../docs/agents/capabilities/mcp/) end to end: real Claude Code agents use tools from the MCP test server ([`mcp-test/`](../../mcp-test/), its own Worker, deployed by hand) through AgentDO's MCP proxy, and the platform's guarantees are checked against the server's own call log.

```bash
# NEST_ADMIN_TOKEN as above; the server's URL and bearer (never echo the token):
export MCP_TEST_URL=https://nest-mcp-test.<account>.workers.dev/mcp
read -rs MCP_TEST_TOKEN && export MCP_TEST_TOKEN
python3 -I dev/cloud-checks/mcp_check.py      # MCP_DRAIN_S=2700: also watch the cell drain to zero hosts
```

| | |
|---|---|
| **Settings** | `NEST_ADMIN_TOKEN`, `MCP_TEST_URL` (the server's `/mcp` URL), `MCP_TEST_TOKEN` (all required; no token is printed), `NEST_BASE_URL` (default `https://nest.bitcru.sh`), `NEST_CELL` (`use1`), `MCP_AGENTS` (2), `MCP_MODEL` (`haiku`), `MCP_TIMEOUT_S` (1200, for the turns), `MCP_IDLE_S` (900, for the brains to exit), `MCP_DRAIN_S` (0: not watched), `MCP_OUT` (`mcp-check-<run>.jsonl`: the marks, every logged call and each agent's checks and reply) |
| **Creates** | `POST /reset` on the server first; the server's token in BrokerDO as `cap:mcp-check`; the capability `mcp-check` (`mcp{url: MCP_TEST_URL, auth: cap:mcp-check}`, untrusted, all five tools allowed, `idempotent` stating every tool so only `note_put` is idempotent) and the template `mcp-check` (`nest`, `mcp-check`; hands forbidden, so no sandbox; `MCP_MODEL`); one workstream (an agent without a sandbox still needs one); `MCP_AGENTS` agents created with `start: false`, each sent one turn (which wakes it): `echo` a phrase holding its id, `note_put` key `<agent>/k` = a random value, `note_get` it, `counter_add` name `<agent>` by 1 twice, then reply with what it got. In a cold cell, the autoscaler launches a brain host (spot EC2) |
| **Passes when** | every turn is `done`; every call in the server's log names one of the run's agents in `_meta`; per agent: every call's `_meta` has `nest/agent` = the agent, `nest/epoch` = an epoch its brain was seen with (polled while the turn ran, plus its last `agent_epoch`), `nest/call` starting `<agent>/<that epoch>/` and `nest/taint` true; epochs never go back in log order; no call key reaches the server twice (bar one retry of `note_put`, the idempotent tool); `echo` answered with its id; `note_get` returned the value `note_put` stored; the counter is exactly 2 (two `counter_add` of 1, totals 1 then 2); the session is tainted, as its `turn_completed` event on `<agent>/events` records (the agent's record exposes no taint field); every brain then idle-exits with no turn queued or active, within `MCP_IDLE_S`; after cleanup no brain of the run is on any host; with `MCP_DRAIN_S` set, no host of the cell is live within it. Whether the reply names the value is logged, not checked (the model's words) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, capability, template, workstream and agent ids |
| **Cleans up** | stops every agent on every exit path, SIGINT and SIGTERM included |
| **Leaves** | the server's state (notes, counters, call log: `POST /reset` clears it); the capability, its secret and the template (kept for reruns: a rerun overwrites them); the workstream and the stopped agents' records; the brain host it caused to launch, which retires after the cell's idle grace |
| **Costs** | a few minutes of one spot brain host from a cold cell, one short Haiku turn per agent on the subscription, and a handful of requests to the test server's Worker |

**Leftovers after an interrupted run:** stop the agent ids from the last line with `POST /v1/agents/<id>/stop`; `GET /calls?since=0` on the server shows what reached it.

**Sanity-checked locally (2026-10-31)** against `wrangler dev` control plane (`ALLOW_LOOPBACK_MCP=1`, no hosts, `NEST_CELL=local`) and a local `mcp-test`: the reset, secret, capability, template, workstream, agent, turn and events calls answer as the script expects, and the timeout, SIGINT and SIGTERM paths stopped the agents and printed the ids. The log checks were run over the local server's real log after calls sent with crafted `_meta`: a well-behaved agent passed every check, and a repeated non-idempotent key, an older epoch after a newer one, an untainted call and a counter of 3 each failed. No brain ran (no hosts, no Claude), so that is no evidence for the cloud run.

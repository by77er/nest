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
| **Creates** | `CHECK_AGENTS` sandboxes; one `worker` agent per sandbox, each given one turn that runs `hostname; echo nest-ok-$((6*7))` through `mcp__nest__Bash`. In a cold cell, the autoscaler launches a brain host and a sandbox host (spot EC2) |
| **Passes when** | every turn is `done`; every transcript contains `nest-ok-42`; while it polled the fleet view (every 30 s), each brain was seen only on a brain host and each sandbox only on a sandbox host (either role name counts) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the agent and sandbox ids |
| **Cleans up** | stops every agent (`POST /v1/agents/<id>/stop`) and destroys every sandbox (`DELETE /v1/sandboxes/<id>`), on every exit path |
| **Leaves** | the stopped agents' records (there is no delete route for them yet); the hosts it caused to launch, which retire after the cell's idle grace. |
| **Costs** | a few minutes of two spot instances from a cold cell, and one short Claude Code turn per agent on the subscription |

**Leftovers after an interrupted run:** `GET /v1/admin/fleet?cell=use1` lists live sandboxes and each host's brains. Stop and destroy the ids from the last line (or the log) with the same two routes.

## `new_host_check.py`

A read-only look at the hosts launched since a deploy, for a change to how hosts boot (user data, the AMI, the launch template). Run it after the first launch.

```bash
CHECK_SINCE=2026-11-03T22:03:00Z python3 -I dev/cloud-checks/new_host_check.py
```

| | |
|---|---|
| **Settings** | `NEST_BASE_URL`, `NEST_CELL`, `AWS_REGION` (`us-east-1`), `CHECK_SINCE` (ISO 8601 UTC or epoch ms; default the last 24 h). AWS credentials that may describe instances and read their consoles |
| **Reads** | `GET /v1/admin/fleet`; EC2 `DescribeInstances` and `GetConsoleOutput` for each launch in FleetDO's record since then |
| **Reports** | per launch: its EC2 state, FleetDO's word (enrolled as which host, connected, or ended and why), and what its console says: the instance-store line, a user-data failure, cloud-init finishing. Then the live hosts |
| **Passes when** | no launch ended with `enroll_timeout`, and no console shows the user data failing or unread. A launch still within its enroll window isn't judged |
| **Creates, changes** | nothing |

EC2 keeps a console's latest snapshot for a while after termination. A snapshot can lag by many minutes (`dev/measure-cut/run.sh`), so run it again when one looks empty.

## `hands_probe_check.py`

Proves a sandbox host's gateway reaches its VMs, which `new_host_check.py` can't see: on 2026-11-04 a host enrolled fine, and every hands call to it failed because its gateway couldn't open the VM's vsock socket.

```bash
uv run --with 'websockets>=13' python3 -I dev/cloud-checks/hands_probe_check.py
```

| | |
|---|---|
| **Settings** | `NEST_ADMIN_TOKEN`, `NEST_ACCESS_CLIENT_ID` and `NEST_ACCESS_CLIENT_SECRET` (Access in front of the gateways), `NEST_BASE_URL`, `NEST_CELL`, `CHECK_TIMEOUT_S` (900); `AWS_REGION` (`us-east-1`) and AWS credentials that may describe instances, for the instance type |
| **Creates** | one sandbox (label `check=hands-probe`). In a cold cell, the autoscaler launches a sandbox host. Also the template `hands-probe-check` and one agent of it on that sandbox, created with `start: false`, so no brain runs and no turn is spent: `resolve` answers only for an attached agent |
| **Passes when** | the gateway answers `bound` to a brain's `bind`. It does so only after connecting to the guest's vsock socket; `busy` is retried for 2 minutes, as a brain does |
| **Reports** | the sandbox, its host, the instance and its type |
| **Cleans up** | on every exit path, SIGTERM included (a second one, or a Ctrl-C, is ignored until cleanup ends): ends the agent (`stop` with `end: true`, which detaches it; its records go after 30 days), deletes the template, and destroys the sandbox. Each step is retried five times and runs whatever an earlier one did; the check fails unless each answers 2xx (or 404: already gone), and a leak is printed with the call to make by hand. One gap: a create whose answer is lost after the server made it isn't cleaned up. Find such a sandbox by its label `check=hands-probe`, and such an agent by its template, `hands-probe-check` (a name the check reserves: it overwrites and deletes a template of that name) |

## `stress.py`

A stress test of a cell: many sandboxes and agents at once, timed phase by phase, with the fleet view sampled throughout so a cell's limits can be read afterwards.

```bash
STRESS_AGENTS=50 python3 -I dev/cloud-checks/stress.py      # STRESS_HANDS=0: brains only
```

| | |
|---|---|
| **Phases** (`STRESS_PHASES`) | `sandboxes`: `STRESS_AGENTS` sandboxes at once (placement and host launches). `turns`: one `stress` agent per sandbox (Haiku; `STRESS_MODEL`), each given one turn that runs `hostname` through hands and replies (time to every turn done). `idle`: until every brain has exited. `cleanup`: stop and destroy, then watch until no host is live (`STRESS_DRAIN_S`). `sandboxes` and `turns` each time out after `STRESS_TIMEOUT_S` (2400), `idle` after 900 s |
| **Creates** | the sandboxes and agents; the `stress` template (kept, for reruns) |
| **Records** | `STRESS_OUT` (JSONL): every `STRESS_SAMPLE_S` the fleet (hosts by kind, brains and sandboxes per host, each host's free memory, open launches), and the phase marks with their timings |
| **Cleans up** | stops every agent and destroys every sandbox on every exit path (interrupt it with SIGINT, not SIGTERM); the last line is the JSON of the ids it made |
| **Costs** | at 50 agents on `use1`: about $0.20 of spot EC2 for a run, plus one short Haiku turn per agent on the subscription |

**First run (2026-10-31, `use1`, caps raised by #54):** the findings are in [the stress test notes](stress-2026-10-31.md), a dated record.

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
| **Creates** | `POST /reset` on the server first; the server's token in BrokerDO as `cap:mcp-check`; the capability `mcp-check` (`mcp{url: MCP_TEST_URL, auth: cap:mcp-check}`, untrusted, all five tools allowed, `idempotent` stating every tool so only `note_put` is idempotent, `read_only: [echo, note_get, slow]` so `note_put` and `counter_add` are [sinks](../../docs/agents/capabilities/mcp/#sinks)) and the template `mcp-check` (`nest`, `mcp-check`; hands forbidden, so no sandbox; `MCP_MODEL`); `MCP_AGENTS` agents created with `start: false`, each sent one turn (which wakes it): `echo` a phrase holding its id, `note_put` key `<agent>/k` = a random value, `note_get` it, `counter_add` name `<agent>` by 1 twice, then by 100, then reply with what it got. In a cold cell, the autoscaler launches a brain host (spot EC2) |
| **Passes when** | every turn is `done` with no approval unanswered (the check approves every sink call but `counter_add` with n 100, which it denies); no more of an agent's sink calls reach the server than it had approvals, and the denied one never does; every call in the server's log names one of the run's agents in `_meta`; per agent: every call's `_meta` has `nest/agent` = the agent, `nest/epoch` = an epoch its brain was seen with (polled while the turn ran, plus its last `agent_epoch`), `nest/call` starting `<agent>/<that epoch>/` and `nest/taint` true; epochs never go back in log order; no call key reaches the server twice (bar one retry of `note_put`, the idempotent tool); `echo` answered with its id; `note_get` returned the value `note_put` stored; the counter is exactly 2 (two `counter_add` of 1, totals 1 then 2); every brain then idle-exits with no turn queued or active, within `MCP_IDLE_S`; after cleanup no brain of the run is on any host; with `MCP_DRAIN_S` set, no host of the cell is live within it. Whether the reply (the last assistant text in its transcript) names the value is logged, not checked (the model's words) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, capability, template and agent ids |
| **Cleans up** | stops every agent on every exit path, SIGINT and SIGTERM included |
| **Leaves** | the server's state (notes, counters, call log: `POST /reset` clears it); the capability, its secret and the template (kept for reruns: a rerun overwrites them); the stopped agents' records; the brain host it caused to launch, which retires after the cell's idle grace |
| **Costs** | a few minutes of one spot brain host from a cold cell, one short Haiku turn per agent on the subscription, and a handful of requests to the test server's Worker |

**Leftovers after an interrupted run:** stop the agent ids from the last line with `POST /v1/agents/<id>/stop`; `GET /calls?since=0` on the server shows what reached it.

**Sanity-checked locally (2026-10-31)** against `wrangler dev` control plane (`ALLOW_LOOPBACK_MCP=1`, no hosts, `NEST_CELL=local`) and a local `mcp-test`: the reset, secret, capability, template, agent, turn and events calls answer as the script expected then (approvals, read from `GET /v1/agents/<id>/asks`, are not yet run locally), and the timeout, SIGINT and SIGTERM paths stopped the agents and printed the ids. The log checks were run over the local server's real log after calls sent with crafted `_meta`: a well-behaved agent passed every check, and a repeated non-idempotent key, an older epoch after a newer one, an untainted call and a counter of 3 each failed. No brain ran (no hosts, no Claude), so that is no evidence for the cloud run.


## `list_changed_check.py`

A tool added on the MCP test server reaches live brains without a restart ([list_changed](../../docs/agents/capabilities/mcp/#list_changed)). It needs `mcp-test/` deployed with its `/tools` route, and the `cap:mcp-check` secret that `mcp_check.py` stores.

```bash
# NEST_ADMIN_TOKEN, MCP_TEST_URL and MCP_TEST_TOKEN as for mcp_check.py
python3 -I dev/cloud-checks/list_changed_check.py      # LC_GAP_S=75: the wait between the notice and the ask
```

| | |
|---|---|
| **Does** | `POST /reset`; a trusted capability `mcplive` with no allowlist and a Haiku template `mcplive`; two agents each call `echo`; it adds `extra_live` on the server; each calls `echo` again (that call's answer carries the notice); after `LC_GAP_S` each is asked to call `extra_live` |
| **Passes when** | both agents call `extra_live` and get its answer, with the brain epoch unchanged across the three turns and on every call (no restart) |
| **Cleans up** | removes `extra_live` and stops both agents; it keeps the capability and template |

## `brokered_check.py`

[Brokered actions](../../docs/agents/capabilities/brokered/) end to end, with no external service: a real Claude Code agent calls `http_request` through two operator-defined profiles on the MCP test server's own `/tools` route (nest attaches the server's token; the agent never sees it), from a session the untrusted `mcp-check` capability taints. One profile is `allow` when tainted and goes; the other is `approve` and waits for the check's approval; a call holding a value nest stores as a secret is refused by the stored-value scan.

```bash
# NEST_ADMIN_TOKEN, MCP_TEST_URL and MCP_TEST_TOKEN as for mcp_check.py
python3 -I dev/cloud-checks/brokered_check.py
```

| | |
|---|---|
| **Settings** | `NEST_ADMIN_TOKEN`, `MCP_TEST_URL`, `MCP_TEST_TOKEN` (all required; no token is printed), `NEST_BASE_URL`, `NEST_CELL` (`use1`), `BROKERED_MODEL` (`haiku`), `BROKERED_TIMEOUT_S` (1200, for the turns), `BROKERED_IDLE_S` (900, for the brain to exit), `BROKERED_OUT` (`brokered-check-<run>.jsonl`: the marks, the decision, the journal rows and the checks). Nothing beyond the standard library |
| **Creates** | the BrokerDO secrets `cap:mcp-check` and `http:brokered-check` (both the server's token) and `http:brokered-check-scan` (a random throwaway value, replaced each run); the capability `mcp-check` (as `mcp_check.py` defines it); the capability `brokered-check` (`brokered`: profiles `check-allow` and `check-approve`, each `http.request` to the server's origin with `POST` and `DELETE` under `/tools` and `auth` `http:brokered-check`, `when_tainted` `allow` and `approve`); the template `brokered-check` (`nest`, `mcp-check`, `brokered-check`; no hands); one agent given one turn: add the server tool `extra_<run>_a` through `check-allow`, `extra_<run>_b` through `check-approve` (held: the check approves the ask whose question opens `Approve http.request on check-approve`, from the agent's open asks, `GET /v1/agents/<id>/asks`; it denies any other), and a third with the throwaway value in its query, which nest's scan of stored values refuses |
| **Passes when** | every turn is `done` with the approval answered; the journal (`GET /v1/agents/<id>/brokered`) has one done row per profile, each sent once, one refused row for the throwaway value (naming `http:brokered-check-scan`) with its arguments withheld, no row holding the value, and the `check-approve` row tainted; an approval was asked for `check-approve` only, and its row was written after it was asked (server times); removing each of the two tools from the server answers `changed: true` (the requests reached it); the brain idle-exits within `BROKERED_IDLE_S` |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, the agent and the tool names |
| **Cleans up** | on every exit path (SIGINT and SIGTERM too): the run's tools are removed from the server; the agent is stopped |
| **Leaves** | the capabilities, the template and the three secrets (kept for reruns), the stopped agent's record, and the brain host it caused to launch, which retires after the cell's idle grace |
| **Costs** | a few minutes of one spot brain host from a cold cell, and one or two short Haiku turns on the subscription |

**Leftovers after an interrupted run:** `DELETE /tools?name=extra_<run>_a` (and `_b`, `_c`) on the server with its token, and stop the agent from the last line.

**Checked offline (2026-11-15):** the journal and approval checks pass a well-formed run and fail on a missing refusal, the throwaway value in a row, an untainted approved call, an approval asked after the call went out, an extra approval (one whose arguments name the held call included), a profile call sent twice, and no approval; with nothing set it exits naming the missing settings. It has not been run against the cloud.

## `push_check.py`

**Retired** (2026-11-15): nest mints no repo tokens and builds no push allowlist ([no repo tokens](../../docs/sandbox/networking/egress/policy/#no-repo-tokens)), so the script exits 2 at once without touching the cell. Phase C6 deletes it and checks pushes through a client guard instead.

## `lifecycle_check.py`

[Agent and sandbox lifetimes](../../docs/agents/#lifetimes) end to end: a real Claude Code parent spawns children with `agent_spawn`, and their sandboxes go when they end.

```bash
python3 -I dev/cloud-checks/lifecycle_check.py
```

| | |
|---|---|
| **Creates** | the capability `lcspawn` (`agent_spawn`, `agent_stop`; spawns `lc-child`), the templates `lc-child` (`nest`, `hands`; Haiku) and `lc-parent` (`nest`, `lcspawn`; no hands); the parent; through the parent, an ephemeral child on a new sandbox that runs `echo lifetimes-check-ok`, then a second, non-ephemeral child on a new sandbox |
| **Passes when** | the first child is the parent's, ends itself (`done`, by itself) once its turn finishes, its transcript shows its output, its sandbox is `destroyed` and the GC registry's live count returns to where it was, the parent's `children` index has it ended, and a turn to it is refused (404); the parent's `agent_stop` ends the second child (by the parent), destroys its sandbox and leaves it no brain; the operator's `stop {end: true}` ends the parent and its brain goes |
| **Cleans up** | on every exit path: ends the parent (which ends its children) and destroys any sandbox of the run not yet destroyed |
| **Leaves** | the capability and templates (kept for reruns) and the ended agents' records, which prune themselves 30 days after they end |
| **Costs** | a few minutes of a spot sandbox host and brain host from a cold cell, and five short Haiku turns (three for the parent, one per child) |

**Run (2026-11-01, `use1`, after #82's deploy):** 20/20 passed in under three minutes; live sandboxes 0 before and after.

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
| **Leaves** | the workstream and the stopped agents' records (there is no delete route for either yet); the hosts it caused to launch, which retire after the cell's idle grace. A start still waiting for a brain host when the check ends isn't cancelled by the stop (`AgentDO.stop` drops an operator's start only when a brain exists): it may launch a brain host later, then fail on its destroyed sandbox |
| **Costs** | a few minutes of two spot instances from a cold cell, and one short Claude Code turn per agent on the subscription |

**Leftovers after an interrupted run:** `GET /v1/admin/fleet?cell=use1` lists live sandboxes and each host's brains. Stop and destroy the ids from the last line (or the log) with the same two routes.

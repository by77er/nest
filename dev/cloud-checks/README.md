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
| **Creates** | `POST /reset` on the server first; the server's token in BrokerDO as `cap:mcp-check`; the capability `mcp-check` (`mcp{url: MCP_TEST_URL, auth: cap:mcp-check}`, untrusted, all five tools allowed, `idempotent` stating every tool so only `note_put` is idempotent, `read_only: [echo, note_get, slow]` so `note_put` and `counter_add` are [sinks](../../docs/agents/capabilities/mcp/#sinks)) and the template `mcp-check` (`nest`, `mcp-check`; hands forbidden, so no sandbox; `MCP_MODEL`); one workstream (an agent without a sandbox still needs one); `MCP_AGENTS` agents created with `start: false`, each sent one turn (which wakes it): `echo` a phrase holding its id, `note_put` key `<agent>/k` = a random value, `note_get` it, `counter_add` name `<agent>` by 1 twice, then reply with what it got. In a cold cell, the autoscaler launches a brain host (spot EC2) |
| **Passes when** | every turn is `done` with no approval unanswered (the check approves every sink call but `counter_add` with n 100, which it denies); no more of an agent's sink calls reach the server than it had approvals, and the denied one never does; every call in the server's log names one of the run's agents in `_meta`; per agent: every call's `_meta` has `nest/agent` = the agent, `nest/epoch` = an epoch its brain was seen with (polled while the turn ran, plus its last `agent_epoch`), `nest/call` starting `<agent>/<that epoch>/` and `nest/taint` true; epochs never go back in log order; no call key reaches the server twice (bar one retry of `note_put`, the idempotent tool); `echo` answered with its id; `note_get` returned the value `note_put` stored; the counter is exactly 2 (two `counter_add` of 1, totals 1 then 2); the session is tainted, as its `turn_completed` event on `<agent>/events` records (the agent's record exposes no taint field); every brain then idle-exits with no turn queued or active, within `MCP_IDLE_S`; after cleanup no brain of the run is on any host; with `MCP_DRAIN_S` set, no host of the cell is live within it. Whether the reply names the value is logged, not checked (the model's words) |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, capability, template, workstream and agent ids |
| **Cleans up** | stops every agent on every exit path, SIGINT and SIGTERM included |
| **Leaves** | the server's state (notes, counters, call log: `POST /reset` clears it); the capability, its secret and the template (kept for reruns: a rerun overwrites them); the workstream and the stopped agents' records; the brain host it caused to launch, which retires after the cell's idle grace |
| **Costs** | a few minutes of one spot brain host from a cold cell, one short Haiku turn per agent on the subscription, and a handful of requests to the test server's Worker |

**Leftovers after an interrupted run:** stop the agent ids from the last line with `POST /v1/agents/<id>/stop`; `GET /calls?since=0` on the server shows what reached it.

**Sanity-checked locally (2026-10-31)** against `wrangler dev` control plane (`ALLOW_LOOPBACK_MCP=1`, no hosts, `NEST_CELL=local`) and a local `mcp-test`: the reset, secret, capability, template, workstream, agent, turn and events calls answer as the script expects, and the timeout, SIGINT and SIGTERM paths stopped the agents and printed the ids. The log checks were run over the local server's real log after calls sent with crafted `_meta`: a well-behaved agent passed every check, and a repeated non-idempotent key, an older epoch after a newer one, an untainted call and a counter of 3 each failed. No brain ran (no hosts, no Claude), so that is no evidence for the cloud run.


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

[Brokered actions](../../docs/agents/capabilities/brokered/) end to end, **posting on a real repo** (`REPO`, default `by77er/nest`; run it only with the owner's OK): a real Claude Code agent opens an issue, comments on it and opens a draft pull request through nest's GitHub App, from a session the untrusted `mcp-check` capability taints, and nest refuses a comment holding a fake credential.

```bash
# NEST_ADMIN_TOKEN, MCP_TEST_URL and MCP_TEST_TOKEN as for mcp_check.py; the App's id and its PEM key (never echo them):
export NEST_GITHUB_APP_ID=<app id>
read -rs NEST_GITHUB_APP_PRIVATE_KEY && export NEST_GITHUB_APP_PRIVATE_KEY   # the PEM, with `\n` escapes if on one line
python3 -I dev/cloud-checks/brokered_check.py
```

| | |
|---|---|
| **Settings** | `NEST_ADMIN_TOKEN`, `NEST_GITHUB_APP_ID`, `NEST_GITHUB_APP_PRIVATE_KEY`, `MCP_TEST_URL`, `MCP_TEST_TOKEN` (all required; no token or key is printed), `REPO` (`by77er/nest`), `NEST_BASE_URL`, `NEST_CELL` (`use1`), `BROKERED_MODEL` (`haiku`), `BROKERED_TIMEOUT_S` (1200, for the turns), `BROKERED_IDLE_S` (900, for the brain to exit), `BROKERED_OUT` (`brokered-check-<run>.jsonl`: the marks, the decision, the journal rows and the checks). Needs `openssl` (it signs the App's JWT; the key is written to a `0600` file in a private temporary directory, removed on exit) and nothing beyond the standard library |
| **Creates** | the BrokerDO secrets `github_app` (`{app_id, private_key}`, built in the script) and `cap:mcp-check`; the capability `mcp-check` (as `mcp_check.py` defines it); the capability `gh-check` (`brokered`: `github.create_issue` on `REPO` with `when_tainted: approve`, `github.comment` and `github.create_pr` on `REPO` with the default, `allow`); the template `gh-check` (`nest`, `mcp-check`, `gh-check`; no hands); on GitHub, with an installation token the script mints itself (contents, issues and pull requests write on `REPO` only), the branch `nest-check/brokered-<run>` with one commit adding `dev/cloud-checks/.scratch/<run>.md` on main's head; one workstream and one agent given one turn: create the issue `nest brokered check <run>` (held: the check approves it from the workstream's `needs_input`), comment on it, open a draft pull request from the branch to main, and comment `scan check: ghp_<36 random>` |
| **Passes when** | every turn is `done` with the approval answered; the journal (`GET /v1/agents/<id>/brokered`) has done rows for the issue, the comment and the pull request, one refused row for the fake credential with its arguments withheld, no row holding the fake value, and the issue's row tainted; an approval was asked for the issue only (none for the scoped `allow` grants), and the issue's row was written after it was asked (server times); on GitHub, the issue has the run's title, the App's bot as its author and nest's marker, the comment is the bot's with the marker, the pull request is the bot's draft from the branch, and no comment holds the fake value; the brain idle-exits within `BROKERED_IDLE_S` |
| **Exit** | 0 on PASS, 1 on FAIL. The last line is the JSON of the run, repo, branch, workstream, agent, issue and pull request numbers |
| **Cleans up** | on every exit path (SIGINT and SIGTERM too): every open issue and pull request on `REPO` by the App's bot whose title names the run gets the comment "closed by nest's brokered check" and is closed; the branch is deleted; the agent is stopped |
| **Leaves** | the closed issue and pull request (GitHub can't delete them through the API), the capabilities, the template and both secrets (kept for reruns), the workstream and the stopped agent's record, and the brain host it caused to launch, which retires after the cell's idle grace |
| **Costs** | a few minutes of one spot brain host from a cold cell, one or two short Haiku turns on the subscription, and a dozen GitHub API calls. Opening the draft pull request may start the repo's CI (its paths are under `dev/cloud-checks/.scratch/`) |

**Leftovers after an interrupted run:** search the repo's issues and pull requests for `nest brokered check <run>`, close them, delete `nest-check/brokered-<run>`, and stop the agent from the last line.

**Checked offline (2026-10-31):** the JWT the script signs with `openssl` verifies with the key's public half and has GitHub's claims; the fake credential matches nest's GitHub-token pattern; the journal and approval checks pass a well-formed run and fail on a missing refusal, the fake value in a row, an untainted issue call, an approval asked after the issue went out, and an extra approval; with nothing set it exits naming the missing settings. It has not been run against GitHub or the cloud.

## `push_check.py`

[Push allowlists](../../docs/sandbox/networking/egress/) end to end on the current guest image: a real Claude Code worker on a fresh sandbox allowed to push only to `REPO` pushes a throwaway branch there, and nest-proxy refuses push requests to any other repo. The probes to other repos carry no data and no real credential.

```bash
# NEST_ADMIN_TOKEN as above; the App's id and PEM key as for brokered_check.py (never echo them)
REPO=by77er/nest OTHER_REPO=by77er/<another repo the App is installed on> python3 -I dev/cloud-checks/push_check.py
```

| | |
|---|---|
| **Creates** | the template `push-check` (`nest`, `hands`; Haiku); one workstream, one sandbox and one agent with `overrides.repos: [REPO]`, given one turn that writes and runs a script: clone `REPO`, commit `dev/cloud-checks/.scratch/<run>.md` on `nest-check/push-<run>`, `git push`, then three `curl` probes (push discovery for `OTHER_REPO` and for a repo that doesn't exist, and a `git-receive-pack` POST to `OTHER_REPO` with a dummy Basic credential), and `gh api repos/<REPO>` |
| **Passes when** | `gh` and `git-credential-nest` are in the image and `GITHUB_TOKEN` is the placeholder; the push exits 0 and GitHub has the branch; all three probes answer 403 from the proxy; `OTHER_REPO` has no such branch; `gh api` answers through the placeholder |
| **Cleans up** | deletes the branch (with an installation token it mints itself), ends the agent and destroys the sandbox, on every exit path |
| **Costs** | a few minutes of a spot sandbox host and brain host from a cold cell, one short Haiku turn |

**Run (2026-11-01, `use1`, guest build `20261101092412`):** 9/9 passed.

## `lifecycle_check.py`

[Agent and sandbox lifetimes](../../docs/agents/#lifetimes) end to end: a real Claude Code parent spawns children with `agent_spawn`, and their sandboxes go when they end.

```bash
python3 -I dev/cloud-checks/lifecycle_check.py
```

| | |
|---|---|
| **Creates** | the capability `lcspawn` (`agent_spawn`, `agent_stop`; spawns `lc-child`), the templates `lc-child` (`nest`, `hands`; Haiku) and `lc-parent` (`nest`, `lcspawn`; no hands); one workstream and the parent; through the parent, an ephemeral child on a new sandbox that runs `echo lifetimes-check-ok`, then a second, non-ephemeral child on a new sandbox |
| **Passes when** | the first child is the parent's, ends itself (`done`, by itself) once its turn finishes, its events show its output and `exited`, its sandbox is `destroyed` and the GC registry's live count returns to where it was, the parent's `children` index has it ended, and a turn to it is refused (404); the parent's `agent_stop` ends the second child (by the parent), destroys its sandbox and leaves it no brain; the operator's `stop {end: true}` ends the parent and its brain goes |
| **Cleans up** | on every exit path: ends the parent (which ends its children) and destroys any sandbox of the run not yet destroyed |
| **Leaves** | the capability and templates (kept for reruns), the workstream, and the ended agents' records, which prune themselves 30 days after they end |
| **Costs** | a few minutes of a spot sandbox host and brain host from a cold cell, and four short Haiku turns |

**Run (2026-11-01, `use1`, after #82's deploy):** 20/20 passed in under three minutes; live sandboxes 0 before and after.

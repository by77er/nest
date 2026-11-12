Docs check of `docs/agents/` and `docs/orchestration/` against AgentDO, the runner, the hands client, the CLI and the seed catalog on `main` (merged up to bd38342). Docs only: no code, tests, config, `docs/security/`, `dev/` or `docs/README.md` changes (the map task already fixed the `docs/README.md` lines this area repeats: lines 8 and 142).

## Corrections

| Doc | It said | The code says | Evidence |
|---|---|---|---|
| agents/README.md | `agent_spawn` params without `read_repos`; `agent_stop`/`exit` without `reason` | both take them | protocol/schemas/control/platform-tools.json (agent_spawn, agent_stop, exit) |
| agents/README.md | "Built: … the grants system takes it over as `(spawner, *, child)` grants" | ownership is only the owner-chain walk; marked designed | control-plane/src/lib/lifetimes.ts:84 (`ownsVia`) |
| agents/README.md | (silent) | a graceful end not done in 15 min is killed; pending timers don't keep an ephemeral agent alive and are dropped at its end | lifetimes.ts:43 (`END_GRACE_MS`), :101; do/agent.ts:1366 |
| tools/README.md | no timer tools; only `wake_at`/`wake_cancel` | `timer_set`, `timer_cancel`, `timer_list` built; `wake_at` isn't | platform-tools.json:488-536; agent.ts:3231-3256 |
| tools/README.md | `nest expose` and `nest hold` built; CLI socket takes at most 256 connections | the CLI has `expose`, `unexpose`, `whoami`; `nest hold` and the cap are design | crates/nest-cli/src/guest_cli.rs:76-78; crates/nest-guest/src/cli.rs:27-38 |
| tools/README.md | `interrupt` "built for the operator's API only" | the inbox route is `auth: owner`: API clients too | control-plane/src/index.ts (`POST /v1/agents/:agent/inbox`) |
| tools/README.md | taint from a post relayed "under another name than `user`" | under another name than the caller's own (its id for a client) | index.ts (inbox route, `self`) |
| tools/README.md | out-of-subtree id refused with 404 | 404 from the API, `forbidden` from `agent_spawn` | index.ts:517; agent.ts:1795 |
| tools/README.md | taint sources | an untrusted `http.request` profile's answer taints too | agent.ts (`read_tainted` after a profile request) |
| capabilities/README.md | attenuation via the grants a capability expands to, as built | capabilities expand to no grants; built: `spawn` templates, narrowing overrides, attenuated grants | spec.ts (v7 `CHANNEL_FIELDS_REMOVED`); agent.ts:1712,1734; grants.ts |
| capabilities/README.md | prompt edits reach resumed brains via `--system-prompt-snapshot off` | the flag isn't passed; prompts are copied at spawn | crates/nest-protocol/src/host.rs `claude::args` |
| capabilities/README.md | only `management`'s tools `not_implemented`; built-in table reads as built | also `memory_read`/`memory_write`, `fork_sandbox`, `checkpoint`; `schedules`, `authority`, `metrics`, `web` aren't capabilities in code; only `worker` and `captain` seeded | agent.ts (default `not_implemented` branch); spec.ts seed catalog |
| capabilities/README.md | Schedules (`wake_at`) only | the built wake is `timers` (one-shot; no repeat, carried taint or turn budget) | spec.ts `TIMER_CAPABILITIES`; agent.ts timer post `tainted=false` |
| capabilities/brokered/README.md | tools list without `github_fork`; journal read by the operator | `github_fork` is listed; the route is `auth: owner`, `limit` ≤ 500 | lib/brokered.ts:89; index.ts:981; brokered.ts `list` |
| runner/README.md | `--system-prompt-snapshot off`, `--max-turns`, `--max-budget-usd` as in use; "flags under pending contract changes" | none passed, none listed there; marked designed | host.rs `claude::args`; docs/interfaces/README.md#pending-contract-changes |
| runner/README.md | pinned version + SHA-256 checked at start; `DISABLE_UPDATES=1`; baseline check among the start steps | no pin or check (only `claude --version`, reported in `agent_started`); `DISABLE_AUTOUPDATER=1` | crates/nest-runner/src/agent.rs:326,342; host.rs `claude::env` |
| backends/README.md | `Backend` interface, `backend` field, conformance test as fact; 8 canonical events incl. `usage` | none of the three built; 13 event types, usage rides on `turn_completed`, `usage` never emitted | crates/nest-protocol/src/control.rs:1141-1144; model.rs `AgentEventBody` |
| backends/claude-code/README.md | the scheduler applies priority | not built | no `priority` in spec.ts |
| sessions/README.md | acked after the SQLite commit; R2 at turn end; inotify; whole directory | `segment_ack` only after the R2 put; flush at 1 MiB, ≤5 s working / 30 s idle, before a start; 500 ms polling; main JSONL only | agent.ts:63-66, 968, 2574-2578, `flushOnce`; nest-runner tailer.rs:1-16, config.rs `tail_interval` |
| sessions/README.md | recovery-context `SessionStart` hook | not built: the hook adds nothing; the recovery turn says where the durable transcript ends | nest-runner hooks.rs `session_start`; agent.ts `recoveryNotes` |
| state-tracking/README.md | `stalled` state | the state exists, nothing sets it | nest-protocol model.rs:272 (only use) |
| hands/README.md | journal (records, stages, duplicates, `call_status` at start) as fact | only the retries are built | crates/nest-guest/src (no `call_status`); nest-hands-client lib.rs:613 |
| orchestration/README.md | budgets as a kernel limit; swarm on forks; `nest attach`; monitor polls with `wake_at`; no built status | budgets not built (depth 3 / 8 live children stand in); `fork_sandbox` not_implemented; no `nest attach`; timers; the projects app builds a variant | lifetimes.ts:45-48; agent.ts; guest_cli.rs; projects/README.md:5 |
| orchestration/README.md | owner events: turns, exits, asks, errors | also `agent.timer_fired` | lib/client-events.ts |
| orchestration/captains/README.md | workers get only grants and budget it holds; `backend`/`priority`/`budget` unmarked; read-only forks and report schemas as primitives | overrides narrow against the template (the spawn grant authorizes it); those fields don't exist; neither primitive built | spec.ts `SpawnerOverrides` (`repos` comment), `Template` |
| orchestration/repo-maintenance/README.md | read as built | designed: no `maintainer`/`reviewer`/`monitor`, no `coordination`/`authority`/`schedules`/`github_ro`/`metrics`/`web`; no `review_check`, `dispatch_workflow`, `create_pr.auto_merge`, forks, `report_schema`; the projects app builds a variant; the seeded `worker` has `WebSearch`/`WebFetch` | spec.ts seed; brokered.ts actions and create_pr schema (`additionalProperties: false`); spec.ts `WORKER_BUILTIN_TOOLS` |
| orchestration/scheduling/README.md | usage from `usage` events; a rate limit is logged | usage on `turn_completed`; only `api_retry` emits `rate_limited` (logged, traced), `StopFailure` only sets `quota_parked`; per-host `brain.max_brains_per_host` | lib/trace.ts; nest-runner stream.rs:19-27, hooks.rs `track`; agent.ts:2752; fleet.ts:1602 |

## Unconfirmed (left as written)
- agents/README.md (Fencing): restart on another host "after 30 s with `--resume`": the 30 s host expiry is in protocol/control.ts; the resume path wasn't traced end to end.
- agents/README.md (Brain placement): preference for the last host; only `warm` in fleet.ts seen.
- tools/README.md (sink gate): "a redelivery of the call it was spent on uses it again" (calls.ts not read in full).
- hands/README.md: output drains 1 s after the main process exits (no such constant found in crates/nest-guest/src).
- state-tracking/README.md: "on a gap, state is rebuilt from the session file" (only a comment in nest-protocol model.rs); `idle` "updates the sandbox's idle refcount" (not traced).
- runner/README.md: "2 s for a pause" comes from the gateway's `retry_after_ms` (nest-gateway not traced).
- mcp/README.md: "`cap:` never resolves into a host command"; AgentDO serving its list copy at any age when the connector fails.
- External links and figures (arXiv 2512.08296, Anthropic and Cognition posts, Cloudflare pricing in api-loop) were not fetched.

## Suspected code bugs (not changed)
- The model is told owners hear their children: the `agent_spawn` description ("its events … reach you", platform-tools.json:4), the spawn result ("Its events reach you.", agent.ts ~1856), the `exit` description ("Your owner hears your final text", platform-tools.json:146). The code and the `spawning` prompt say an owner agent hears nothing.
- An ephemeral agent ends with timers pending (lifetimes.ts:101), so it can't use a timer to wait.
- `StopFailure` rate limits emit no `rate_limited` (hooks.rs `track`): no log, trace or retry hint. `rate_limited` sets `quota_parked` without a staleness check (agent.ts ~2723).
- An unscoped `github.fork` grant is described as "Any repository the App is installed on" (brokered.ts ~340-345); forks use `github_user` on any public upstream.
- An agent created through the API with `owner: agt_…` starts at depth 0 (index.ts ~855), restarting the depth cap.
- Stale comments: lib/timers.ts:1 points at `docs/agents/timers/` (it's `docs/agents/capabilities/timers/`); nest-protocol model.rs:544 mentions an "api-loop captain backend" and Discord.

## Minor omissions seen (not edited)
- brokered: the refused auth headers also include hop-by-hop and `proxy-*` (brokered.ts:137-138); a profile's 5xx is a `done` result, not a lost answer; a fork result has `push_allowed`.
- mcp: the approval words also accept `approves` (sinks.ts:42); the OAuth start answer also has `capability`; "at least every 250 ms" means at most 250 ms apart.
- agents: the API spawn also takes `cell`, `start` and legacy `role`/`captain`/`launch`/`rules`; `list` defaults `limit` 100 (max 200), `state` live; `read_transcript` default `limit` 200.

## Drift outside the area (not edited)
- docs/interfaces/README.md#pending-contract-changes doesn't list the runner's unbuilt flags (the runner doc no longer points there for them).
- docs/control-plane/durable-objects/agent/ (control-plane task): the lead that `load()` drops `escalate_to` and `subscribe` concerns that doc; neither field is named in this area's docs.

## Docs with no drift
backends/api-loop/README.md (design, consistent), capabilities/timers/README.md, capabilities/mcp/README.md (minor omissions above).

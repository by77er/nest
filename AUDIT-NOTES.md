# Audit notes (scratch; becomes the PR body, deleted before the PR)

## Corrections (applied)
| Doc | Said | Code says | Evidence |
|---|---|---|---|
| orchestration/README.md | kernel keeps budgets | budgets not built; depth 3 / 8 live children stand in | control-plane/src/lib/lifetimes.ts:45-48 |
| orchestration/README.md | owner events: turns, exits, asks, errors | also `agent.timer_fired` | control-plane/src/lib/client-events.ts:14 |
| orchestration/README.md | swarm on forks; `nest attach`; monitor polls with `wake_at` | `fork_sandbox` not_implemented; no `nest attach`; timers are the built wake | agent.ts:3257; crates/nest-cli/src/guest_cli.rs:76-78; spec.ts:250 |
| orchestration/README.md | (no built status) | projects app builds the board/manager/worker/reviewer variant | projects/README.md:5 |
| captains/README.md | workers get only grants it holds | overrides narrowed against the template; spawn grant authorizes it | spec.ts:128-133 |
| captains/README.md | backend/priority/budget unmarked | no such fields | spec.ts:49-149 |
| repo-maintenance/README.md | reads as built | none of its templates/capabilities seeded; review_check, dispatch_workflow, auto_merge, report_schema, forks not built | spec.ts:322-332; brokered.ts:41-115,60-71 |
| repo-maintenance/README.md | `wake_at`; worker "without web" | timers; seeded worker has WebSearch/WebFetch built-ins | spec.ts:286 |
| scheduling/README.md | usage events; quota_parked logged | usage rides on turn_completed; only api_retry emits rate_limited (logged); StopFailure only sets state; per-host brain cap exists | trace.ts:131; stream.rs:19-27; hooks.rs:107-110; agent.ts:2752; fleet.ts:1602 |
| backends/README.md | interface/backend field as fact; 8 canonical events | interface, `backend` field, conformance test not built; 13 events, `usage` never emitted | crates/nest-protocol/src/control.rs:1141; model.rs:558-597 |
| agents/README.md | agent_spawn params; agent_stop/exit params; `(spawner,*,child)` grants built | + `read_repos`, `reason`; grants takeover designed; 15 min END_GRACE; timers don't keep ephemeral alive | platform-tools.json; lifetimes.ts:43,84,101; agent.ts:1366 |
| tools/README.md | no timer tools; `nest hold` + 256-conn CLI built; interrupt operator-only; `user` relay name; 404 at confer | timers built; CLI has expose/unexpose/whoami only, no cap; owner route (clients too); caller's own name; `forbidden` from agent_spawn; http.request profile answers taint | guest_cli.rs:76-78; nest-guest/src/cli.rs:27; index.ts:918-928; agent.ts:1795,3538 |

## To apply (capabilities)
- capabilities/README.md:22 `--system-prompt-snapshot off` not passed (grep crates: none) → designed.
- :23 not_implemented also memory_read/write, fork_sandbox, checkpoint.
- :54-65 table rows schedules/authority/web/metrics not built; memory stubs.
- :80-87 Schedules → point at timers.
- :36-44, :67-74 examples are design.
- :19 attenuation: capabilities expand to no grants; built = spawn list + narrowing overrides + attenuated grants.
- brokered:25 add `github_fork` (brokered.ts:89); journal route auth owner (index.ts:981).
- docs/README.md:8 "capability sources" → api source only.

## Unconfirmed
- agents/README.md:47 restart after 30 s with --resume (lease 30 s found, protocol/control.ts:15; --resume path not traced)
- tools/README.md:56 redelivery reuses approval (calls.ts not read)
- agents/README.md:44 warm-host preference (fleet.ts:1685 only)
- External citations in captains/orchestration (fetch not run)

## Suspected code bugs
- platform-tools.json:4 agent_spawn description and agent.ts:1856 say child events reach the owner; spawning prompt and docs say nothing does.
- platform-tools.json:146 exit description: owner hears final text (true only for a client owner).
- Ephemeral agents end with timers pending (lifetimes.ts:101; agent.ts:1366).
- StopFailure rate limits emit no rate_limited (hooks.rs:107-110).
- brokered.ts:340-345 unscoped github.fork described as "Any repository the App is installed on".
- lib/timers.ts:1 comment points to docs/agents/timers/ (doesn't exist).
- model.rs:544 comment mentions api-loop captain backend, Discord.
- API spawn with owner agt_… starts at depth 0 (index.ts:855-857).

## Outside drift
- docs/sandbox/guest-agent/README.md fine. docs/interfaces/host-internal/runner-claude/ (to check).

## Docs done
orchestration/*, backends/README.md, agents/README.md, tools/README.md (pending merge with main)
## Remaining
capabilities/* edits, runner, hands, sessions, state-tracking, claude-code backend, api-loop; merge origin/main and re-check

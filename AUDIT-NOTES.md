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

| capabilities/README.md | attenuation via grants a capability expands to | capabilities expand to no grants; spawn list + narrowing overrides + attenuated grants | spec.ts:349; agent.ts:1712,1734; grants.ts:289 |
| capabilities/README.md | `--system-prompt-snapshot off` makes edits reach resumed brains | flag not passed | crates/nest-protocol/src/host.rs:991-1031 (no match in crates/) |
| capabilities/README.md | only management tools not_implemented; table rows read as built | memory_read/write, fork_sandbox, checkpoint also not_implemented; schedules/authority/metrics/web not built | agent.ts:3257-3258; spec.ts:199-333 |
| capabilities/README.md | Schedules (wake_at) only | timers is the built mechanism | spec.ts:250; platform-tools.json:488-536 |
| brokered/README.md | tool list without github_fork; journal read by operator | github_fork listed; route auth owner, limit ≤500 | brokered.ts:89; index.ts:981; brokered.ts:542 |

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
capabilities/README, brokered; no drift: timers/README, mcp/README (minor omissions only); api-loop (design, consistent)
orchestration/*, backends/README.md, agents/README.md, tools/README.md (pending merge with main)
## Remaining
runner, hands, sessions, state-tracking, claude-code backend, api-loop; merge origin/main and re-check

## Minor (not edited, listed)
- brokered: forbidden auth headers wider (hop-by-hop, proxy-*) brokered.ts:137-138; fork takes no when_tainted; profile 5xx returned as done not lost (agent.ts:3527-3553); fork result has push_allowed (agent.ts:3418)
- mcp: approval regex also accepts `approves` (sinks.ts:42); oauth start answer also has `capability` (mcp-auth.ts:518); "at least every 250 ms" is "at most 250 ms apart" (mcp-proxy.ts:455)
- agents: API spawn also takes cell, start, legacy role/captain/launch/rules (index.ts:789-808); list defaults limit 100 max 200, state live (agent.ts:101-102); read_transcript default limit 200 (agent.ts:97)

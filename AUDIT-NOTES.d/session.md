# Audit notes: docs/interfaces/control-host/session/README.md

## Corrections
| Doc:line | Said | Code says | Evidence file:line |
|---|---|---|---|
| 47 | R2 `put sessions/<agent>/<offset>` | segments are keyed per base generation: `sessions/<agent>/b<base>/<offset>` | control-plane/src/do/agent.ts:2608 |

| Pending bullet | AgentDO returns `pending` if approval doesn't resolve within ~2 min | `askApproval` records the ask and returns `pending` at once | control-plane/src/do/agent.ts:3332-3343 |
| Timeouts bullet | nest-mcp gives up after 150 s, returns `error{rate_limited, retryable}` | the runner's `platform_call` times out at `tool_call_timeout` 150 s, returns `outcome_unknown` retryable:false and sends `cancel_call` | crates/nest-runner/src/runtime.rs:508-530, crates/nest-runner/src/config.rs:64 |
| cache_update | updates with a lower version ignored | equal versions are ignored too (`>=`) | crates/nest-runner/src/runtime.rs:490 |

## Summary lines affected
- None found: docs/interfaces/README.md, docs/interfaces/control-host/README.md, docs/README.md don't repeat the segment key.

## Unconfirmed
- "Messages are capped at about 64 KB" (session README, Stream section): the runner splits segments at 46 KiB (crates/nest-runner/src/tailer.rs:16); found no 64 KB cap constant on either side.

## Suspected code bugs
- Stale code comment crates/nest-protocol/src/control.rs:836: `Inbox` "Deliver mid-turn (stream-json stdin)"; the runner writes nothing to stdin for an inbox message (crates/nest-runner/src/agent.rs:526-527), it is handed out by hooks.

## Drift outside the area

## No drift (sections checked and fine)
- Messages tables (lines 9-38): every RunnerToAgent / AgentToRunner variant and field matches crates/nest-protocol/src/control.rs:727-886 and control-plane/src/protocol/control.ts:414-555, and fixtures protocol/fixtures/control/{runner_to_agent,agent_to_runner}/ (incl. approval_check.json, approval_checked*.json, hello_ack.rule_approvals.json, segment.base_total.json, hello.tools_changed.json, tools_changed.json). No variant missing from the doc.
- Route: GET /v1/agents/:agent/session, auth host (control-plane/src/index.ts:620) matches docs/interfaces/control-host/README.md:11 (the session doc itself doesn't state it).
- 46 KiB segment split: crates/nest-runner/src/tailer.rs:16. Epoch-0 hello stale: brain epoch = agent_epoch after `+= 1` (agent.ts:1089), isCurrent compares epoch (agent.ts:752).
- Turns/inbox/interrupts: interrupt grace 10 s then SIGKILL (crates/nest-runner/src/config.rs:62, brain.rs:360); approval_check 5 s (config.rs:68); rule key `rule/<epoch>/<request>` (agent.ts:3367); first match wins, no match ask (crates/nest-runner/src/rules.rs:2); call ids `cal_<turn>-<n>` (runtime.rs:504).
- Stream section (40-62): flush 5 s working / 30 s idle (agent.ts:63-64); gap -> invalid_message (agent.ts:2563); new-lineage drop / whole-rewrite flush at hello (agent.ts:2440-2488); stale hello_ack durable_bytes=local_bytes then error stale_epoch (agent.ts:2460-2465); orphan key (agent.ts:2544); signed blob URL 15 min HMAC (agent.ts:67, index.ts:599, lib/tokens.ts:59); index row (base, offset, len) (agent.ts:2618).
STATUS: DONE

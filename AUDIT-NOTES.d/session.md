# Audit notes: docs/interfaces/control-host/session/README.md

## Corrections
| Doc:line | Said | Code says | Evidence file:line |
|---|---|---|---|
| 47 | R2 `put sessions/<agent>/<offset>` | segments are keyed per base generation: `sessions/<agent>/b<base>/<offset>` | control-plane/src/do/agent.ts:2608 |

## Summary lines affected
- None found: docs/interfaces/README.md, docs/interfaces/control-host/README.md, docs/README.md don't repeat the segment key.

## Unconfirmed

## Suspected code bugs

## Drift outside the area

## No drift (sections checked and fine)
- Messages tables (lines 9-38): every RunnerToAgent / AgentToRunner variant and field matches crates/nest-protocol/src/control.rs:727-886 and control-plane/src/protocol/control.ts:414-555, and fixtures protocol/fixtures/control/{runner_to_agent,agent_to_runner}/ (incl. approval_check.json, approval_checked*.json, hello_ack.rule_approvals.json, segment.base_total.json, hello.tools_changed.json, tools_changed.json). No variant missing from the doc.
- Route: GET /v1/agents/:agent/session, auth host (control-plane/src/index.ts:620) matches docs/interfaces/control-host/README.md:11 (the session doc itself doesn't state it).
- 46 KiB segment split: crates/nest-runner/src/tailer.rs:16. Epoch-0 hello stale: brain epoch = agent_epoch after `+= 1` (agent.ts:1089), isCurrent compares epoch (agent.ts:752).
- Stream section (40-62): flush 5 s working / 30 s idle (agent.ts:63-64); gap -> invalid_message (agent.ts:2563); new-lineage drop / whole-rewrite flush at hello (agent.ts:2440-2488); stale hello_ack durable_bytes=local_bytes then error stale_epoch (agent.ts:2460-2465); orphan key (agent.ts:2544); signed blob URL 15 min HMAC (agent.ts:67, index.ts:599, lib/tokens.ts:59); index row (base, offset, len) (agent.ts:2618).

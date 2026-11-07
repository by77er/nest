# Session channel (agent runner ↔ AgentDO)

> **Implemented contract.** In the design, `segment_ack` follows the SQLite commit; see [pending contract changes](../../README.md#pending-contract-changes).

One WebSocket per **active** agent, opened by the agent runner after `agent_start`. It carries the native session file, canonical events, turn control, synchronous-hook caches and platform tool calls. The runner's hello carries the agent epoch AgentDO issued for this brain start (`agent_start.epoch`), for every agent; the sandbox epoch travels only inside the agent's binding ([gateway](../../gateway/)). A hello with epoch `0` (a runner that predates the agent epoch) is stale.

## Messages

**Runner → AgentDO (`RunnerToAgent`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello` | first frame | agent, host, `instance_id` (random per brain process), epoch (the agent epoch), `session?`, `local_bytes?`, `last_seq?`, `tools_changed?` (true: the runner acts on `tools_changed`; absent from runners of the previous release, which are never sent it and list again only at their next start. A capability flag, kept until every runner sends it) |
| `segment` | by offset | Raw JSONL bytes `[offset, offset+len)` of the native session file, base64. `base: true` means the file was rewritten (it shrank or its inode changed): discard earlier segments; this one starts at offset 0 |
| `events` | seq | A batch of `model::AgentEvent` (each with its own per-agent `seq`), coalesced. Each event's `epoch` is the one this connection's hello presented; AgentDO drops any other |
| `tool_call` | seq | A platform tool call relayed from nest-mcp: `call`, `turn?`, `name`, `arguments` |
| `tools_list_request` | no | nest-mcp `tools/list` |
| `cancel_call` | seq | `call`, `reason`. The runner abandoned a platform call (it timed out locally and the model was told `outcome_unknown`). An unacked `tool_call` is replaced in place by a `cancel_call` with the same seq, and a fresh one is always sent too. AgentDO marks the call done with `outcome_unknown` without running it (a later `tool_call` with that id gets that outcome), withdraws a pending approval wait (the decision then arrives as a turn), and sends no `tool_result`. Idempotent. |
| `hands_resolve` | no (`request`) | Ask for the sandbox's current gateway URL, a fresh binding and the guest's version: lazily before the first hands call after a brain start, and again after a refused connection, `moved`, `stale_epoch` or `unknown_key`. AgentDO calls SandboxDO's `resolve` and answers only the current runner's socket ([gateway](../../gateway/)) |
| `ack` | — | Cumulative ack of reliable `AgentToRunner` messages |

**AgentDO → runner (`AgentToRunner`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello_ack` | first frame | `durable_bytes` for the stream currently being received (the committed base, or a new base or session in progress); the runner resends session bytes from here. `last_seq`. |
| `segment_ack` | no | `durable_bytes`, sent after the bytes are durable in R2 |
| `run_turn` | seq | `turn`, `input{kind, text}`, written to Claude Code's stdin as a user message |
| `inbox` | seq | `InboxMessage`, delivered through the inbox mirror at a tool boundary (`PostToolUse`) or at `Stop`, never through stdin. `interrupt: true` interrupts the turn instead, and no hook hands the message out: AgentDO queues it as the next turn |
| `interrupt` | seq | The stream-json interrupt control message |
| `cache_update` | seq | `AgentCache{version, rules, inbox, max_stop_continuations}` for answering hooks locally |
| `tool_result` | seq | `outcome: ok{content} \| error{error} \| pending{ask, message}` |
| `tools_list` | no | `ToolDef[]` (MCP `tools/list` plus nest metadata) |
| `tools_changed` | no | The agent's tool list changed (a remote MCP server's did: [list_changed](../../../agents/capabilities/mcp/#list_changed)): the runner has `nest mcp` send Claude Code `notifications/tools/list_changed`, and Claude Code lists again. Only to a runner whose hello had `tools_changed: true`. Not reliable: AgentDO sends it again at the next hello when the brain's last `tools_list_request` came before the last change, and after a `tools_list` made while one landed. An older runner would log and skip it (it skips a message it can't read that has no seq) |
| `hands_resolved` | no (`request`) | `outcome`: `{status: ok, hands{url, binding, guest, edge?}}` or `{status: error, error, retry_after_ms?}`: `not_bound` (no hands, or not attached), `sandbox_not_ready` with `retry_after_ms` (no host, placing, the slot not confirmed, no gateway advertised), `stale_epoch` (not the current runner process or epoch). The binding travels only here, never in a command. For one release AgentDO also sends the previous shape (exactly one of `hands` and `error`, and `retry_after_ms`); runners read only `outcome`, and one without it is an `invalid_message` error; `hands` still carries unsigned `sandbox` and `epoch` copies for those runners |
| `ack` / `error` | — | |

## Session stream and acks

```
runner                                      AgentDO                          R2
 │ hello{local_bytes=280455} ──────────────►│
 │◄── hello_ack{durable_bytes=262144}        │
 │ segment{offset=262144, len 18311} ──────►│ buffer (5 s working / 30 s idle)
 │ segment{offset=280455, …} ──────────────►│ flush ──────────────────────────►│ put sessions/<agent>/<offset>
 │◄── segment_ack{durable_bytes=298766}      │ index row (offset, len, base)
 │ (runner may now forget bytes < durable_bytes; it never needs to, since the file is local)
 │ claude compacts → file trimmed (TRANSCRIPT_LOCAL_GC)
 │ segment{offset=0, base:true, whole file} ►│ new base: earlier segments superseded
```

- **Offsets are the ordering and deduplication key.** AgentDO ignores bytes it already has and rejects a gap (`invalid_message`). The runner then resends from `durable_bytes`.
- **A base goes again until acknowledged.** After a reconnect the runner resends from `durable_bytes`, unless it sent a base (a rewritten file) and no `segment_ack` has come since: `durable_bytes` may then still describe the old file, so the base goes again (AgentDO takes a repeated base as a fresh one). Residual: an ack for the old file crossing the base on the wire counts as confirming it.
- **Brain lineage:** `hello.instance_id` is random per brain process. When it differs from the previous connection's, AgentDO resets the channel's seq lineage and event dedup, and re-queues an interrupted turn as a **recovery** turn. A reconnect of the same process resumes as usual.
- **In-order delivery, both ways:** a reliable message must carry `seq == last + 1`. AgentDO closes the socket on a gap or a processing failure, and the runner resends everything unacked after reconnecting. The runner, receiving, takes the lineage's first message as its baseline, and on a gap closes the connection without acking past it (its hello then asks for everything past the last it took). A later batch's ack never covers an earlier one that wasn't processed.
- **A reliable message the runner can't read stalls the channel.** It is never skipped (the next seq's ack would cover it): the runner closes the connection, reports it to nestd, and reconnects with a growing backoff, and the same message comes back. So a new reliable message type, or a new value of an enum inside one (`TurnInput`, `InboxMessage`, `ToolOutcome`, `AgentCache`), must be gated on the runner saying it reads it (a hello capability), since hosts lag the Worker by a release. A non-reliable message it can't read is skipped.
- **Stale connections:** a runner whose `hello.epoch` is stale gets `hello_ack` (with `durable_bytes` = its own `local_bytes`) followed by `error{stale_epoch}`. Its segments are stored under `sessions/<agent>/orphan/e<epoch>/<offset>` and acknowledged, never written to the live session. Nothing else (turns, tool calls, events) flows on that connection.
- **Resume URLs:** `agent_start.resume.segments[].url` are **Worker-signed** URLs (`/v1/blobs/<key>?exp=…&sig=…`, HMAC, valid 15 minutes), not R2 presigned URLs, so R2 S3 credentials exist nowhere. Hosts just `GET` them.
- **Never store lines in DO SQLite;** only the segment index goes there. Messages are capped at about 64 KB; the runner splits larger appends.

## Turns, inbox and caches

- **One turn at a time.** AgentDO queues `run_turn`s and sends the next one after `turn_completed`.
- **Inbox during a turn:** the runner hands it to the model at the next tool boundary, as `PostToolUse` `additionalContext` (the model sees it within the turn, verified on 2.1.316; a subagent's tool call hands out nothing, so the message waits for the main loop: [runner-hooks](../../host-internal/runner-hooks/)). When the turn ends, the `Stop` hook returns messages still pending as `decision: "block"`, up to `max_stop_continuations` times per stop chain. A message no hook handed out stays in the mirror and AgentDO queues it as the next turn. stdin carries only `run_turn` text, one message per turn.
- **Interrupts:** `interrupt` or `inbox{interrupt: true}` sends the stream-json interrupt control message. If the process has been unresponsive for 10 s, the runner falls back to SIGINT, then `cgroup.kill`.
- **`cache_update`** replaces the rules and inbox mirror used by `PreToolUse`, `PermissionRequest` and `Stop`. The first matching rule wins; no match means `ask`: the runner emits an `escalation{call, tool, input}` event and denies the call with "pending approval (request `call`)". AgentDO holds it as an ask the operator lists (`GET /v1/agents/<id>/asks`) and answers; the decision arrives as an `ask_answer` turn. Updates with a lower `version` are ignored.

## Platform tool relay

nest-mcp (on the host) gets `tools/call`, and the runner sends `tool_call{seq, call, turn, name, arguments}`. AgentDO checks grants and runs the call (see [../tools/](../tools/)), then replies `tool_result{call, outcome}`.

- **Idempotency key:** `(agent, epoch, call)`. A redelivered `tool_call` returns the stored outcome.
- **Call ids:** `call = cal_<turn>-<n>`, generated by the runner.
- **Pending:** if a call needs the operator's approval and doesn't resolve within about 2 minutes, AgentDO returns `pending{ask, message}`, and nest-mcp returns `message` as the tool's text. The model ends its turn, and the answer later arrives as `run_turn{input.kind: ask_answer}`.
- **Timeouts:** nest-mcp gives up after 150 s and returns `error{rate_limited, retryable}`. A late `tool_result` is acknowledged and discarded.

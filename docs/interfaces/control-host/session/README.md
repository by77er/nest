# Session channel (agent runner ↔ AgentDO)

> **Implemented contract.** In the design, `segment_ack` follows the SQLite commit; see [pending contract changes](../../README.md#pending-contract-changes).

One WebSocket per **active** agent, opened by the agent runner after `agent_start`. It carries the native session file, canonical events, turn control, synchronous-hook caches and platform tool calls. The runner's hello carries the agent epoch AgentDO issued for this brain start (`agent_start.epoch`), for every agent; the sandbox epoch travels only inside the agent's binding ([gateway](../../gateway/)). A hello with epoch `0` (a runner that predates the agent epoch) is stale.

## Messages

**Runner → AgentDO (`RunnerToAgent`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello` | first frame | agent, host, `instance_id` (random per brain process), epoch (the agent epoch), `session?`, `local_bytes?`, `last_seq?`, `tools_changed?` (true: the runner acts on `tools_changed`; absent from runners of the previous release, which are never sent it and list again only at their next start. A capability flag, kept until every runner sends it) |
| `segment` | by offset | Raw JSONL bytes `[offset, offset+len)` of the native session file, base64. `base: true` means the file was rewritten (it shrank or its inode changed): discard earlier segments; this one starts at offset 0. A base segment carries `total_bytes` (optional): how many bytes of the rewritten file it and the segments right after it carry (a rewrite over 46 KiB goes in several). AgentDO makes the rewrite the resumable base only once that many are durable, so one cut off part-way never replaces the complete base before it. Fixture: `segment.base_total.json`; a runner of the previous release sends none (`segment.base.json`) and is committed at its first durable segment, as before |
| `events` | seq | A batch of `model::AgentEvent` (each with its own per-agent `seq`), coalesced. Each event's `epoch` is the one this connection's hello presented; AgentDO drops any other |
| `tool_call` | seq | A platform tool call relayed from nest-mcp: `call`, `turn?`, `name`, `arguments` |
| `tools_list_request` | no | nest-mcp `tools/list` |
| `cancel_call` | seq | `call`, `reason`. The runner abandoned a platform call (it timed out locally and the model was told `outcome_unknown`). An unacked `tool_call` is replaced in place by a `cancel_call` with the same seq, and a fresh one is always sent too. AgentDO marks the call done with `outcome_unknown` without running it (a later `tool_call` with that id gets that outcome), withdraws a pending approval wait (the decision then arrives as a turn), and sends no `tool_result`. Idempotent. |
| `hands_resolve` | no (`request`) | Ask for the sandbox's current gateway URL, a fresh binding and the guest's version: lazily before the first hands call after a brain start, and again after a refused connection, `moved`, `stale_epoch` or `unknown_key`. AgentDO calls SandboxDO's `resolve` and answers only the current runner's socket ([gateway](../../gateway/)) |
| `approval_check` | no (`request`) | `call`, `tool`, `input`, `cache_version` (the `AgentCache` whose rules held it): a call a tool rule in `ask` mode holds, its `PreToolUse` hook waiting on the answer (up to 5 s). AgentDO spends an approval of exactly this call (the Claude Code tool name and SHA-256 of the input's canonical JSON) on it, or holds it as an ask. Sent only on a connection whose `hello_ack` said `rule_approvals`; a check made while disconnected waits for the next `hello_ack` and is sent only if that one says so too (otherwise the runner escalates the call, below). Fixture: `approval_check.json` |
| `ack` | — | Cumulative ack of reliable `AgentToRunner` messages |

**AgentDO → runner (`AgentToRunner`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello_ack` | first frame | `durable_bytes` for the stream currently being received (the committed base, or a new base or session in progress); the runner resends session bytes from here. `last_seq`. `rule_approvals?` (true: this AgentDO answers `approval_check`; absent from the previous release's. A capability flag, kept until every runner checks approvals and no rollback reaches an AgentDO without it) |
| `segment_ack` | no | `durable_bytes`, sent after the bytes are durable in R2 |
| `run_turn` | seq | `turn`, `input{kind, text}`, written to Claude Code's stdin as a user message |
| `inbox` | seq | `InboxMessage`, delivered through the inbox mirror at a tool boundary (`PostToolUse`) or at `Stop`, never through stdin. `interrupt: true` interrupts the turn instead, and no hook hands the message out: AgentDO queues it as the next turn |
| `interrupt` | seq | The stream-json interrupt control message |
| `cache_update` | seq | `AgentCache{version, rules, inbox, max_stop_continuations}` for answering hooks locally |
| `tool_result` | seq | `outcome: ok{content} \| error{error} \| pending{ask, message}` |
| `tools_list` | no | `ToolDef[]` (MCP `tools/list` plus nest metadata) |
| `tools_changed` | no | The agent's tool list changed (a remote MCP server's did: [list_changed](../../../agents/capabilities/mcp/#list_changed)): the runner has `nest mcp` send Claude Code `notifications/tools/list_changed`, and Claude Code lists again. Only to a runner whose hello had `tools_changed: true`. Not reliable: AgentDO sends it again at the next hello when the brain's last `tools_list_request` came before the last change, and after a `tools_list` made while one landed. A runner that can't read it logs and skips it (it has no seq) |
| `hands_resolved` | no (`request`) | `outcome`: `{status: ok, hands{url, binding, guest, edge?}}` or `{status: error, error, retry_after_ms?}`: `not_bound` (no hands, or not attached), `sandbox_not_ready` with `retry_after_ms` (no host, placing, the slot not confirmed, no gateway advertised), `stale_epoch` (not the current runner process or epoch). The binding travels only here, never in a command. For one release AgentDO also sends the previous shape (exactly one of `hands` and `error`, and `retry_after_ms`); runners read only `outcome`, and one without it is an `invalid_message` error; `hands` still carries unsigned `sandbox` and `epoch` copies for those runners |
| `approval_checked` | no (`request`) | `outcome`: `{status: approved, ask}` (an approval of exactly this call, now spent on it: the hook allows it), `{status: pending, ask}` (held for the operator, the open ask for this call reused: the hook denies it), or `{status: error, error}` (`stale_epoch`: not the current runner process or epoch; `conflict`: the agent's rules changed after `cache_version`, so a rule set since, say a `deny`, wins; nothing spent or asked either way). Answers only the current runner's socket, checked in the same synchronous step as the spend. A runner of the previous release never sends `approval_check`, so never gets this |
| `ack` / `error` | — | |

## Session stream and acks

```
runner                                      AgentDO                          R2
 │ hello{local_bytes=280455} ──────────────►│
 │◄── hello_ack{durable_bytes=262144}        │
 │ segment{offset=262144, len 18311} ──────►│ buffer (5 s working / 30 s idle)
 │ segment{offset=280455, …} ──────────────►│ flush ──────────────────────────►│ put sessions/<agent>/b<base>/<offset>
 │◄── segment_ack{durable_bytes=298766}      │ index row (offset, len, base)
 │ (runner may now forget bytes < durable_bytes; it never needs to, since the file is local)
 │ claude compacts → file trimmed (TRANSCRIPT_LOCAL_GC)
 │ segment{offset=0, base:true, whole file} ►│ new base: earlier segments superseded
```

- **Offsets are the ordering and deduplication key.** AgentDO ignores bytes it already has and rejects a gap (`invalid_message`). The runner then resends from `durable_bytes`.
- **`hello_ack.durable_bytes` after a new runner process** is the committed base's: a rewrite the previous process left half-received is dropped at that hello (AgentDO), so the new tailer rewinds into the file the base describes. A rewrite that had arrived whole (`total_bytes`) is made durable and committed first, so then it's the rewrite's length.
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
- **Interrupts:** `interrupt` or `inbox{interrupt: true}` sends the stream-json interrupt control message. If the turn hasn't ended 10 s later, the runner sends Claude Code SIGINT, and 10 s after that SIGKILLs its process group.
- **`cache_update`** replaces the rules and inbox mirror used by `PreToolUse`, `PermissionRequest` and `Stop`. Updates with a lower `version` are ignored. The first matching rule wins; no match means `ask`.
- **A rule's `ask`** is AgentDO's to decide, since only AgentDO can spend an approval durably before the call runs (a brain can die between letting a call through and saying so): the hook sends `approval_check` and waits. An approval of exactly this call is spent on it (`approved`: allowed); otherwise the call is held as an ask (an approval the operator lists, `GET /v1/agents/<id>/asks`, and answers), and the hook denies it, quoting the ask. The decision arrives as an `ask_answer` turn: approved, the model makes the same call again, which runs once; denied, it is told the call won't run. A rule's approval never expires and survives a brain restart, a new epoch and `--resume`; it is spent on one check's key (`rule/<epoch>/<request>`), which never gets a second call through (a rule's check is never redelivered), so two identical calls at once let one through and ask again for the other. No answer within 5 s denies the call, telling the model not to retry now but to go on or end its turn and try later (no escalation: a slow control plane must not bring back the plain questions), and a check still queued for a reconnect is then dropped, never sent; if AgentDO had spent an approval on one already sent, that approval is lost (the call never ran) and the operator is asked again.
- **An AgentDO without `rule_approvals`** (the previous release's): the runner emits an `escalation{call, tool, input}` event and denies the call with "pending approval (request `call`)"; AgentDO holds it as a plain question, whose answer can't let the call through. A runner of the previous release always does this, and today's AgentDO still records it as that plain question.

## Platform tool relay

nest-mcp (on the host) gets `tools/call`, and the runner sends `tool_call{seq, call, turn, name, arguments}`. AgentDO checks grants and runs the call (see [../tools/](../tools/)), then replies `tool_result{call, outcome}`.

- **Idempotency key:** `(agent, epoch, call)`. A redelivered `tool_call` returns the stored outcome.
- **Call ids:** `call = cal_<turn>-<n>`, generated by the runner.
- **Pending:** if a call needs the operator's approval and doesn't resolve within about 2 minutes, AgentDO returns `pending{ask, message}`, and nest-mcp returns `message` as the tool's text. The model ends its turn, and the answer later arrives as `run_turn{input.kind: ask_answer}`.
- **Timeouts:** nest-mcp gives up after 150 s and returns `error{rate_limited, retryable}`. A late `tool_result` is acknowledged and discarded.

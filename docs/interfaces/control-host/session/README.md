# Session channel (agent runner ↔ AgentDO)

One WebSocket per **active** agent, opened by the agent runner after `agent_start`. It carries the native session file, canonical events, turn control, synchronous-hook caches and platform tool calls. The runner's hello includes the agent's epoch: the bound sandbox's epoch for workers, `0` for captains.

## Messages

**Runner → AgentDO (`RunnerToAgent`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello` | first frame | agent, host, `instance_id` (random per brain process), epoch, `session?`, `local_bytes?`, `last_seq?` |
| `segment` | by offset | Raw JSONL bytes `[offset, offset+len)` of the native session file, base64. `base: true` means the file was rewritten (it shrank or its inode changed): discard earlier segments; this one starts at offset 0 |
| `events` | seq | A batch of `model::AgentEvent` (each with its own per-agent `seq`), coalesced |
| `tool_call` | seq | A platform tool call relayed from nest-mcp: `call`, `turn?`, `name`, `arguments` |
| `tools_list_request` | no | nest-mcp `tools/list` |
| `cancel_call` | seq | `call`, `reason`. The runner abandoned a platform call (it timed out locally and the model was told `outcome_unknown`). An unacked `tool_call` is replaced in place by a `cancel_call` with the same seq, and a fresh one is always sent too. AgentDO marks the call done with `outcome_unknown` without running it (a later `tool_call` with that id gets that outcome), stops a pending `ask`'s sync wait (its answer then arrives as a turn), and sends no `tool_result`. Idempotent. |
| `ack` | — | Cumulative ack of reliable `AgentToRunner` messages |

**AgentDO → runner (`AgentToRunner`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello_ack` | first frame | `durable_bytes` for the stream currently being received (the committed base, or a new base or session in progress); the runner resends session bytes from here. `last_seq`. |
| `segment_ack` | no | `durable_bytes`, sent after the bytes are durable in R2 |
| `run_turn` | seq | `turn`, `input{kind, text}`, written to Claude Code's stdin as a user message |
| `inbox` | seq | `InboxMessage`, delivered mid-turn through stdin or at `Stop` through the inbox mirror. `interrupt: true` interrupts first |
| `interrupt` | seq | The stream-json interrupt control message |
| `cache_update` | seq | `AgentCache{version, rules, inbox, max_stop_continuations}` for answering hooks locally |
| `tool_result` | seq | `outcome: ok{content} \| error{error} \| pending{ask, message}` |
| `tools_list` | no | `ToolDef[]` (MCP `tools/list` plus nest metadata) |
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
- **Brain lineage:** `hello.instance_id` is random per brain process. When it differs from the previous connection's, AgentDO resets the channel's seq lineage and event dedup, and re-queues an interrupted turn as a **recovery** turn. A reconnect of the same process resumes as usual.
- **In-order delivery:** a reliable message must carry `seq == last + 1`. A gap or a processing failure **closes the socket**, and the runner resends everything unacked after reconnecting. A later batch's ack never covers an earlier failed one.
- **Stale connections:** a runner whose `hello.epoch` is stale gets `hello_ack` (with `durable_bytes` = its own `local_bytes`) followed by `error{stale_epoch}`. Its segments are stored under `sessions/<agent>/orphan/e<epoch>/<offset>` and acknowledged, never written to the live session. Nothing else (turns, tool calls, events) flows on that connection.
- **Resume URLs:** `agent_start.resume.segments[].url` are **Worker-signed** URLs (`/v1/blobs/<key>?exp=…&sig=…`, HMAC, valid 15 minutes), not R2 presigned URLs, so R2 S3 credentials exist nowhere. Hosts just `GET` them.
- **Never store lines in DO SQLite;** only the segment index goes there. Messages are capped at about 64 KB; the runner splits larger appends.

## Turns, inbox and caches

- **One turn at a time.** AgentDO queues `run_turn`s and sends the next one after `turn_completed`.
- **Inbox during a turn:** the runner writes it to stdin, where Claude Code queues it. When the turn ends, the `Stop` hook returns the pending mirror messages as `decision: "block"`, up to `max_stop_continuations` times.
- **Interrupts:** `interrupt` or `inbox{interrupt: true}` sends the stream-json interrupt control message. If the process has been unresponsive for 10 s, the runner falls back to SIGINT, then `cgroup.kill`.
- **`cache_update`** replaces the rules and inbox mirror used by `PreToolUse`, `PermissionRequest` and `Stop`. The first matching rule wins; no match means `ask`: the runner emits an `escalation{call, tool, input}` event and denies the call with "pending approval (request `call`)". AgentDO records an async ask (captain's `needs_input`); the answer arrives as an `ask_answer` turn. Updates with a lower `version` are ignored.

## Platform tool relay

nest-mcp (on the host) gets `tools/call`, and the runner sends `tool_call{seq, call, turn, name, arguments}`. AgentDO checks grants and runs the call (see [../tools/](../tools/)), then replies `tool_result{call, outcome}`.

- **Idempotency key:** `(agent, epoch, call)`. A redelivered `tool_call` returns the stored outcome.
- **Call ids:** `call = cal_<turn>-<n>`, generated by the runner.
- **Pending:** if a call needs a human or captain and doesn't resolve within about 2 minutes, AgentDO returns `pending{ask, message}`, and nest-mcp returns `message` as the tool's text. The model ends its turn, and the answer later arrives as `run_turn{input.kind: ask_answer}`.
- **Timeouts:** nest-mcp gives up after 150 s and returns `error{rate_limited, retryable}`. A late `tool_result` is acknowledged and discarded.

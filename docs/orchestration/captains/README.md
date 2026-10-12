# Captains

A captain is a long-lived assistant that manages workstreams, receives their events and escalates to me. **It has no machine:** all of its state, tools and policy live in the control plane. The model inference behind it is a pluggable **backend**.

```
                 ┌──────────────── control plane (authoritative) ─────────────────┐
 events/inbox ──►│ AgentDO (role: captain)                                        │
                 │   turn queue · inbox · memory · grants · state · transcript    │
                 │   tool registry (schemas + handlers) · prompt · input format   │
                 │                 │ CaptainBackend.runTurn()                      │
                 └─────────────────┼──────────────────────────────────────────────┘
                     ┌─────────────┴──────────────┐
          claude-code backend (now)        api-loop backend (later, pure Cloudflare)
          controller host, subscription    Messages API loop inside the DO, API key
```

## Design rules (keep the captain re-implementable on Cloudflare)

1. **Captain logic lives only in the control plane:** tool schemas and handlers, the system prompt, how event batches become turn input, memory, grants. The controller host has **no captain logic**. It's a dumb runner plus an MCP bridge.
2. **One tool registry.** Tools are defined once in TypeScript. The `claude-code` backend exposes them through a generic MCP bridge that fetches `tools/list` from the DO and forwards `tools/call` to it. The `api-loop` backend passes the same schemas to the Messages API. Either way, the handlers run in the DO.
3. **One prompt, kept in the control plane.** AgentDO sends the captain prompt in `AgentStart.launch`. The runner writes it to `<config_dir>/nest-system-prompt.md` for `--system-prompt-file`; the api-loop backend would use it as `system`.
4. **Continuity comes from memory, not the backend's conversation history.** Each wake's input includes a DO-generated digest (workstream states, open questions, notes). A backend's own session (a Claude Code JSONL file or Messages API history) is only a cache. Switching backends starts a fresh session from the digest; we never translate one history format into the other.
5. **Canonical events.** Each backend maps its output to one event schema: `turn_started`, `assistant_text`, `tool_call`, `tool_result`, `turn_completed`, `rate_limited`, `error`, `usage`. Transcripts, state tracking, Discord and the scheduler only consume canonical events.
6. **Backend concerns stay inside backends:** context management (Claude Code autocompact vs API compaction), thinking and effort, credentials, quota vs budget. These surface only as canonical events.

## Tools

```
spawn_workstream(spec, budget)  send(ws, msg)  list_workstreams()  get_status(ws)
read_transcript(ws, since)  wait_events(filter)  approve/deny(req)  merge(ws)/kill(ws)
delegate(task, ws?)  memory_read/memory_write(key)  notify_user(msg, urgency)
```

**`delegate`** replaces any need for captains to read code or attach to sandboxes. It spawns a worker (a brain with hands) bound to an **ephemeral read-only fork**. The worker does the reading and reports back. **Captains never attach to sandboxes.**

## Waking

WorkstreamDO batches events. **Only decision events wake a captain:** `needs_input`, `blocked`, `completed`, `failed`, `pr_opened`, `budget_exceeded`, `orphaned_work`, `egress_alert`. Progress events go into the digest it reads on its next wake. Workstream output is untrusted, so it goes into user-role content and never into system instructions.

## Safeguards

- A captain's only actions are `nest` tool calls, gated by grants and approvals.
- Captains can use a separate setup token from workers (a per-role override in BrokerDO: `claude_oauth_token:captain`), so the two can be revoked independently.
- The scheduler reserves subscription headroom for captains.

## Backends

- [backends/](backends/): the interface, plus `claude-code` (current) and `api-loop` (future)

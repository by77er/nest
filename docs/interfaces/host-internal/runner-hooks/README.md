# runner ↔ `nest hook`

Every Claude Code hook runs `/usr/lib/nest/nest hook [--sync]` (wired in managed settings, see [../runner-claude/](../runner-claude/)). It reads the hook input JSON on stdin and `NEST_AGENT_ID`, `NEST_HOOK_DGRAM`, `NEST_HOOK_SOCK` and `NEST_HOOK_SPOOL` from its environment. **It always exits 0.**

## Async tracking hooks

`UserPromptSubmit, PostToolUseFailure, Notification, Elicitation, SubagentStart, SubagentStop, PreCompact, PostCompact, StopFailure, SessionEnd` (`async: true`; Claude Code doesn't wait). `Elicitation` is tracking-only: with `--permission-prompts none` an unanswered elicitation is cancelled.

- One `HookDatagram{v, agent, ts_ms, input, truncated}` to `hook.dgram`, sent non-blocking. `input` is the raw hook input. Large `tool_input`/`tool_response` strings are truncated to fit 60 KiB (`truncated: true`).
- If the send fails, append the same JSON as one line to `NEST_HOOK_SPOOL` (`<config_dir>/nest-hook-spool.jsonl`). The runner drains the spool at agent start and every few seconds.

## Sync decision hooks

`SessionStart` (20 s, fail open), `PreToolUse` and `PermissionRequest` (10 s, `onFailure: block`), `PostToolUse` and `Stop` (10 s, fail open).

- One `HookDecisionRequest{v, agent, input}` frame on `hook.sock`, then one `HookDecisionResponse{output}` frame. `output` is printed verbatim to stdout.
- **The runner answers from local state only** (the `AgentCache` from AgentDO, the inbox mirror, the hands connection). It never waits on the network. Target ~1 ms. `SessionStart` may read the repo's CLAUDE.md through hands.
- **If the runner is unreachable or doesn't answer within 8 s** (18 s for `SessionStart`, which reads CLAUDE.md through hands with an 8 s budget), `nest hook` prints `hook::fallback_output(event)`: deny for `PreToolUse`/`PermissionRequest`, nothing (allow) for `PostToolUse`/`Stop`/`SessionStart`.
- **Peer binding:** the runner checks the connecting process (`SO_PEERCRED`) descends from the declared agent's Claude Code process; otherwise it answers with the same fallback. The async datagram socket isn't peer-checked (tracking only; a forged datagram can only mislabel state).

| Event | Runner logic | Output |
|---|---|---|
| `PreToolUse` | First matching `AgentCache.rules` pattern (permission-rule syntax). `allow`/`deny`; `ask` → deny with "pending approval (request `call`)", plus an `escalation{call, tool, input}` agent event (AgentDO holds it for the operator; the decision arrives as a turn) | `hookSpecificOutput{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}` |
| `PermissionRequest` | Same rules | `hookSpecificOutput{hookEventName:"PermissionRequest", decision:{behavior:"allow"} \| {behavior:"deny", message}}` |
| `PostToolUse` | Undelivered inbox items, and the main loop's call (no `agent_id` in the input: a subagent's would get them instead)? → hand them to the model with the tool's result (the model sees it within the turn: verified on 2.1.316, [runner-claude](../runner-claude/#hooks-checked-on-21316); [state tracking](../../../agents/state-tracking/#synchronous-hooks-answered-locally-1-ms)). **Open:** a subagent's call (input has `agent_id`) hands it to the subagent, not the main loop; on 2.1.316 the haiku subagent called it an injected instruction and ignored it. Handing out nothing when `agent_id` is set would keep the message for the main loop's next boundary or `Stop` | `hookSpecificOutput{hookEventName:"PostToolUse", additionalContext}` or `{}` |
| `Stop` | Undelivered inbox items? → block with them as `reason`. Continuations count toward `max_stop_continuations` per stop chain: `stop_hook_active: false` (a stop we didn't cause) resets the count | `{"decision":"block","reason":"…"}` or `{}` |
| `SessionStart` | Follow `transcript_path` if it is under `<config_dir>/projects/` (absolute, no `..`, `.jsonl`; anything else is ignored); read `CLAUDE.md` at the agent's sandbox cwd via hands (an agent with hands) | `hookSpecificOutput{hookEventName:"SessionStart", additionalContext}` |

Every sync hook input is also recorded as a tracking event. Neither hands out an `interrupt` message (AgentDO queues it as the next turn). When the `PostToolUse` or `Stop` hook returns inbox messages, the runner emits `inbox_delivered` for each once the answer is written (if it isn't, they are pending again), so AgentDO prunes the mirror. Tracked states: `SessionStart` → ready, `UserPromptSubmit`/`PreToolUse`/`PostToolUse*`/`PostCompact` → working, `SubagentStart`/`SubagentStop` → working (detail names the subagent), `PermissionRequest` → waiting_permission, `Notification` → needs_attention, `PreCompact` → compacting, `Stop` → idle (only a `Stop` the hook lets end the turn: one that returns `block` stays working), `StopFailure` → errored or quota_parked (rate limit), `SessionEnd` → detached, `Elicitation` → waiting_input.

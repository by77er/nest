# runner ↔ `nest hook`

Every Claude Code hook runs `/usr/lib/nest/nest hook [--sync --event <event>]` (wired in managed settings, see [../runner-claude/](../runner-claude/)). It reads the hook input JSON on stdin and `NEST_AGENT_ID`, `NEST_HOOK_DGRAM`, `NEST_HOOK_SOCK` and `NEST_HOOK_SPOOL` from its environment. **It always exits 0.**

## Async tracking hooks

`UserPromptSubmit, PostToolUseFailure, Notification, Elicitation, SubagentStart, SubagentStop, PreCompact, PostCompact, StopFailure, SessionEnd` (`async: true`; Claude Code doesn't wait). `Elicitation` is tracking-only: with `--permission-prompts none` an unanswered elicitation is cancelled.

- One `HookDatagram{v, agent, ts_ms, input, truncated}` to `hook.dgram`, sent non-blocking. `input` is the raw hook input. Large `tool_input`/`tool_response` strings are truncated to fit 60 KiB (`truncated: true`).
- If the send fails, append the same JSON as one line to `NEST_HOOK_SPOOL` (`<config_dir>/nest-hook-spool.jsonl`). The runner drains the spool at agent start and every few seconds.

## Sync decision hooks

`SessionStart` (10 s, fail open), `PreToolUse` and `PermissionRequest` (10 s, `onFailure: block`), `PostToolUse` and `Stop` (10 s, fail open).

- One `HookDecisionRequest{v, agent, input}` frame on `hook.sock`, then one `HookDecisionResponse{output}` frame. `output` is printed verbatim to stdout.
- **The runner answers from local state** (the `AgentCache` from AgentDO and the inbox mirror), in ~1 ms, with one exception: a call a rule in `ask` mode holds waits up to 5 s for AgentDO's `approval_check` ([session](../../control-host/session/#turns-inbox-and-caches)), because only AgentDO can spend an approval durably before the call runs.
- **If the runner is unreachable or doesn't answer within 8 s**, `nest hook` prints `hook::fallback_output(event)`: deny for `PreToolUse`/`PermissionRequest`, nothing (allow) for `PostToolUse`/`Stop`/`SessionStart`.
- **Input it can't parse** (serde_json refuses a lone surrogate such as `\ud800`, and nesting deeper than 128): never sent to the runner; `nest hook` prints the fallback for the event `--event` names, so a `PreToolUse` or `PermissionRequest` is denied. Before `--event` (2026-11-11) it sent `null`, the runner answered nothing, and Claude Code, which runs with the web built-ins in `--allowedTools`, let the call run: a fail-open for `ask` and `deny` rules on them.
- **Peer binding:** the runner checks the connecting process (`SO_PEERCRED`) descends from the declared agent's Claude Code process; otherwise it answers with the same fallback. The async datagram socket isn't peer-checked (tracking only; a forged datagram can only mislabel state).

| Event | Runner logic | Output |
|---|---|---|
| `PreToolUse` | First matching `AgentCache.rules` pattern (permission-rule syntax). `allow`/`deny`; `ask` → `approval_check{call, tool, input}` to AgentDO: allow if it spent an operator's approval of exactly this call on it; else deny, quoting the ask that holds it (the decision arrives as a turn; once approved, the same call runs once), or saying it couldn't be checked (no answer in 5 s, or a stale runner). With an AgentDO that doesn't check approvals (no `rule_approvals` in its `hello_ack`): deny with "pending approval (request `call`)", plus an `escalation{call, tool, input}` agent event (a plain question) | `hookSpecificOutput{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}` |
| `PermissionRequest` | Same rules | `hookSpecificOutput{hookEventName:"PermissionRequest", decision:{behavior:"allow"} \| {behavior:"deny", message}}` |
| `PostToolUse` | Undelivered inbox items, and a main-loop call (no `agent_id` in the input)? → hand them to the model with the tool's result (it sees them within the turn: verified on 2.1.316, [runner-claude](../runner-claude/#hooks-checked-on-21316); [state tracking](../../../agents/state-tracking/#synchronous-hooks-answered-locally-1-ms)). A subagent's call gets nothing: its context would reach the subagent, which on 2.1.316 ignored it as an injected instruction; the message waits for the main loop's next boundary or `Stop` | `hookSpecificOutput{hookEventName:"PostToolUse", additionalContext}` or `{}` |
| `Stop` | Undelivered inbox items? → block with them as `reason`. Continuations count toward `max_stop_continuations` per stop chain: `stop_hook_active: false` (a stop we didn't cause) resets the count | `{"decision":"block","reason":"…"}` or `{}` |
| `SessionStart` | Follow `transcript_path` if it is under `<config_dir>/projects/` (absolute, no `..`, `.jsonl`; anything else is ignored). No repo file is read: a repo's guidance is the client's ([runner](../../../agents/runner/)) | `{}` |

Every sync hook input is also recorded as a tracking event. Neither hands out an `interrupt` message (AgentDO queues it as the next turn). When the `PostToolUse` or `Stop` hook returns inbox messages, the runner emits `inbox_delivered` for each once the answer is written (if it isn't, they are pending again), so AgentDO prunes the mirror. Tracked states: `SessionStart` → ready, `UserPromptSubmit`/`PreToolUse`/`PostToolUse*`/`PostCompact` → working, `SubagentStart`/`SubagentStop` → working (detail names the subagent), `PermissionRequest` → waiting_permission, `Notification` → needs_attention, `PreCompact` → compacting, `Stop` → idle (only a `Stop` the hook lets end the turn: one that returns `block` stays working), `StopFailure` → errored or quota_parked (rate limit), `SessionEnd` → detached, `Elicitation` → waiting_input.

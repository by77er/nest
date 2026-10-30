# runner ↔ `nest hook`

Every Claude Code hook runs `/usr/lib/nest/nest hook [--sync]` (wired in managed settings, see [../runner-claude/](../runner-claude/)). It reads the hook input JSON on stdin and `NEST_AGENT_ID`, `NEST_HOOK_DGRAM`, `NEST_HOOK_SOCK` and `NEST_HOOK_SPOOL` from its environment. **It always exits 0.**

## Async tracking hooks

`UserPromptSubmit, PostToolUse, PostToolUseFailure, Notification, Elicitation, SubagentStart, SubagentStop, PreCompact, PostCompact, StopFailure, SessionEnd` (`async: true`; Claude Code doesn't wait). `Elicitation` is tracking-only: with `--permission-prompts none` an unanswered elicitation is cancelled.

- One `HookDatagram{v, agent, ts_ms, input, truncated}` to `hook.dgram`, sent non-blocking. `input` is the raw hook input. Large `tool_input`/`tool_response` strings are truncated to fit 60 KiB (`truncated: true`).
- If the send fails, append the same JSON as one line to `NEST_HOOK_SPOOL` (`<config_dir>/nest-hook-spool.jsonl`). The runner drains the spool at agent start and every few seconds.

## Sync decision hooks

`SessionStart` (20 s, fail open), `PreToolUse` and `PermissionRequest` (10 s, `onFailure: block`), `Stop` (10 s, fail open).

- One `HookDecisionRequest{v, agent, input}` frame on `hook.sock`, then one `HookDecisionResponse{output}` frame. `output` is printed verbatim to stdout.
- **The runner answers from local state only** (the `AgentCache` from AgentDO, the inbox mirror, the hands connection). It never waits on the network. Target ~1 ms. `SessionStart` may read the repo's CLAUDE.md through hands.
- **If the runner is unreachable or doesn't answer within 8 s** (18 s for `SessionStart`, which reads CLAUDE.md through hands with an 8 s budget), `nest hook` prints `hook::fallback_output(event)`: deny for `PreToolUse`/`PermissionRequest`, nothing (allow) for `Stop`/`SessionStart`.
- **Peer binding:** the runner checks the connecting process (`SO_PEERCRED`) descends from the declared agent's Claude Code process; otherwise it answers with the same fallback. The async datagram socket isn't peer-checked (tracking only; a forged datagram can only mislabel state).

| Event | Runner logic | Output |
|---|---|---|
| `PreToolUse` | First matching `AgentCache.rules` pattern (permission-rule syntax). `allow`/`deny`; `ask` → deny with "pending approval (request `call`)", plus an `escalation{call, tool, input}` agent event (AgentDO handles it like an async `ask`) | `hookSpecificOutput{hookEventName:"PreToolUse", permissionDecision, permissionDecisionReason}` |
| `PermissionRequest` | Same rules | `hookSpecificOutput{hookEventName:"PermissionRequest", decision:{behavior:"allow"} \| {behavior:"deny", message}}` |
| `Stop` | Undelivered inbox items? → block with them as `reason`. Continuations count toward `max_stop_continuations` per stop chain: `stop_hook_active: false` (a stop we didn't cause) resets the count | `{"decision":"block","reason":"…"}` or `{}` |
| `SessionStart` | Follow `transcript_path` if it is under `<config_dir>/projects/` (absolute, no `..`, `.jsonl`; anything else is ignored); read `CLAUDE.md` at the agent's sandbox cwd via hands (an agent with hands) | `hookSpecificOutput{hookEventName:"SessionStart", additionalContext}` |

Every sync hook input is also recorded as a tracking event. When the `Stop` hook returns inbox messages, the runner emits `inbox_delivered` for each (as it does for messages written to stdin), so AgentDO prunes the mirror. Tracked states: `SessionStart` → ready, `UserPromptSubmit`/`PreToolUse`/`PostToolUse*`/`PostCompact` → working, `SubagentStart`/`SubagentStop` → working (detail names the subagent), `PermissionRequest` → waiting_permission, `Notification` → needs_attention, `PreCompact` → compacting, `Stop` → idle, `StopFailure` → errored or quota_parked (rate limit), `SessionEnd` → detached, `Elicitation` → waiting_input.

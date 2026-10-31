# nestd ↔ agent runner

**Lifecycle only.** Turns, inbox, interrupts, hook caches, platform tool calls and the session stream go over the runner's own session channel to AgentDO (`control::RunnerToAgent` / `AgentToRunner`, see `docs/interfaces/control-host/session/`).

## Messages

**nestd → runner (`RunnerCommand`)**

| `type` | Purpose |
|---|---|
| `hello_ack` | `host_id`, `host_role` (`controller`, a brain host's, this release: the runner runs only on brain hosts, and on sandbox hosts while they keep it for one release; nestd and the runner ship in one release, and the runner only logs it). The runner starts with no agents; nestd sends only starts it received while no runner was connected, and never replays one sent on an earlier connection |
| `host_token` | Bearer for session-channel upgrades; sent after `hello_ack` and on rotation. Memory only |
| `lease_update` | Every heartbeat. If it lapses, **or the socket closes**, the runner kills every brain (SIGKILL to its process group) |
| `agent_start` | `{start: control::AgentStart, config_dir}`. `start.epoch` is the agent epoch; `start.hands`, when present, names the sandbox only; the runner fetches the gateway target from AgentDO. A start for a brain already running adopts a newer epoch and the new hands (the brain keeps running). Refused without a valid lease mirror (`error{no_lease}` + `agent_exited{fenced}`) or when `launch.builtin_tools` names a host-side tool (`error{forbidden_tool}` + `agent_exited{crashed}`); a refused start supersedes any older brain of the agent (killed under its epoch) and its exit is reported only once that brain has gone |
| `agent_stop` | `mode: graceful` (close stdin, finish turn; a brain still starting is killed) \| `kill`. Either names the agent `epoch` it is for; a stop never reaches a newer brain. A kill carries the agent `epoch` it is for (absent from nestd of the previous release: whatever runs): the runner raises the agent's tombstone to it, kills a brain at or below it, spares a newer one, and refuses to register any start at or below it (`agent_exited{fenced}` at the start's epoch, once no older brain of the agent is registered) |
| `fence` | Kill listed brains (empty = all) now, including ones still starting. An empty fence (like a lease lapse or a lost socket) also drops every start that arrived before it and hasn't registered yet (`agent_exited{fenced}` at its epoch) |
| `ping` | Health |

**runner → nestd (`RunnerEvent`)**: `hello`, `agent_started{pid, session, claude_version, capabilities, epoch?}` (the epoch of the start it registered under), `agent_capabilities{agent, capabilities}` (whenever `system/init` reports new capabilities, which may be after `agent_started`; the same list goes to AgentDO as a `capabilities` agent event), `auth_check{auth_method, api_key_source, ok}`, `agent_exited{code?, signal?, reason: idle|stopped|fenced|auth_failed|crashed}` (nestd forwards as `HostEventBody::AgentExited`, the reason mapped member for member onto `control::AgentExitReason`, never as free text), `pong`, `error`.

## Rules

- **Undecodable commands** (version skew) are skipped with `error{invalid_message}`; the link stays up.
- **Start registers first.** `agent_start` registers the agent before the slow steps (session rebuild ≤120 s, `claude auth status` ≤20 s, `claude --version` ≤10 s, each with a timeout), so `fence`/`agent_stop`/lease lapse reach it; a cancelled start reports `agent_exited` with the kill's reason and never spawns Claude Code.
- **No re-issue:** AgentDO starts an agent on a host only once its previous brain was released, so a start that finds an older brain of the agent still registered (one on its way out: of an earlier connection, or killed) ends it and registers once it is gone; it never adopts it or runs beside it. A start older than the registered brain is refused at its own epoch and never ends it; the same start again is a no-op. A killed brain that hasn't exited after 60 s makes nestd drop the connection (every brain on the host is then killed). An exit without an epoch (a runner of the previous release) is taken by nestd for the agent's oldest entry. A start for an agent whose previous brain is on its way out (told to stop, or of an **earlier nestd connection**) kills it and registers once it is gone, never alongside it.
- **Connection generations:** lifecycle events are tagged with the nestd connection a brain was started under; a new connection never receives events about brains of the previous one (they were killed when it dropped). nestd keeps the same rule on its side: it accepts events only for a brain whose start went out on the current connection, and drops an `agent_exited{fenced}` that arrives before that brain's `agent_started`.
- **A lost connection loses its brains.** When the socket closes, nestd reports each brain started on it to the control plane as `agent_exited{crashed}` (`fenced` if it was already fenced), and forgets it. AgentDO restarts a `crashed` or `fenced` brain that has work with a fresh `agent_start` (current session, resume URLs and token); nestd keeps no copy of a start to replay.
- **One brain table** in nestd, keyed by (agent, agent epoch), holds each start's state and connection. `agent_started` marks its epoch's entry; an exit removes the agent's entries at or below its epoch, never a newer one (events without an epoch, from a runner of the previous release, are taken for the newest entry). A fence takes its brains out of the fleet hello at once; they leave the table when the runner reports the exit (forwarded to the control plane) or the connection drops. A fenced start that was never sent is reported `fenced` by nestd itself.
- **An exit means nothing older runs.** An `agent_exited` at epoch `e`, from the runner or from nestd, means no brain of the agent at or below `e` runs on the host: AgentDO releases its brain record on it. nestd answers a kill with an exit itself only when no start at or below its epoch went out to the runner, and holds a refused start's exit until the older starts that went out have exited.
- **Kills don't wait:** `fence`, `agent_stop{kill}` and lease lapse SIGKILL the brain's process group directly; stdin is written by a separate task, so a brain that stopped reading stdin is still killed.

- **Session IDs:** `SessionId` = `ses_<Claude session UUID>` (`host::claude::session_id`). New sessions: the runner picks the UUID and passes `--session-id`. Resumes: the runner downloads `start.resume.segments` (Worker-signed URLs, `base` resets) into `claude::transcript_path(config_dir, cwd, uuid)` and passes `--resume <path>` (`--fork-session` if `fork`).
- **Prompt and MCP config** are written into `config_dir` (`nest-system-prompt.md`, `nest-mcp.json`) before spawning.
- **Hands never cross this socket.** nestd relays `control::AgentStart` unchanged; the guest's agent slots are configured by the control plane's `agent_attach` command on the sandbox's host, not by anything here. The runner's hands client opens one WebSocket per call to the sandbox's gateway with a binding it fetched from AgentDO over its session channel (`hands_resolve`), stamps the bound guest's version on every `HandsRequest`, and resolves again when a gateway refuses the binding ([gateway](../../gateway/), [runner](../../../agents/runner/)).

**Designed** ([pending contract changes](../../README.md#pending-contract-changes)):
- **Start steps:** the `claude --version` step becomes the [baseline check](../runner-claude/#version) (version and SHA-256). A new step looks up the hands calls AgentDO lists as in flight (`call_status` through the gateway, ≤10 s) and reports their outcomes to AgentDO as canonical events before Claude Code starts ([hands journal](../../../agents/hands/#journal)).

## Error codes

Reported in `RunnerEvent::Error` (to nestd) or in an `AgentEventBody::Error` (on the session channel). Codes outside `model::error_codes` are runner-local:

| Code | Where | Meaning |
|---|---|---|
| `no_lease` | `RunnerEvent::Error` | `agent_start` refused: no valid host lease (none received yet, or it lapsed). Retryable once a `lease_update` arrives. |
| `already_running` | `RunnerEvent::Error` | A duplicate `agent_start` for a live brain. The running brain is untouched. |
| `forbidden_tool` | `RunnerEvent::Error` | `launch.builtin_tools`, or `system/init.tools`, includes a built-in outside the runner's host-safe allowlist ([runner-claude](../runner-claude/)). The start is refused, or the brain is killed. |
| `invalid_message` | `RunnerEvent::Error` | An undecodable `RunnerCommand` from nestd. It's skipped; the connection stays up. |
| `agent_start_failed` | `RunnerEvent::Error` | A startup step failed or timed out (materialize, auth check, spawn). Retryable. |
| `claude_version` (designed) | `RunnerEvent::Error` | Claude Code isn't the pinned baseline (version or SHA-256). The start is refused (`agent_exited{crashed}`). Not retryable. |
| `agent_stopping` | `AgentEventBody::Error` | A turn or inbox message arrived after a stop; it isn't delivered. |
| `stdin` | `AgentEventBody::Error` | Writing to Claude Code's stdin failed. Retryable. |
| `outcome_unknown` | MCP tool result | A platform call timed out in the runner (the runner sends `cancel_call`), a hands call's gateway connection closed with 4409 (the sandbox left mid-call), or (designed) a hands call went silent. The model is told the call may or may not have taken effect. |

## Agent start → turn → sync hook → idle exit

Ordering as implemented: the `claude auth status` pre-check runs **before** spawning (failure →
`auth_check{ok:false}` + `agent_exited{auth_failed}`, no spawn); `agent_started` is sent once the
session channel opened (or after `session_open_timeout`, 10 s, even if it didn't);
`auth_check{ok:true}` follows `system/init` (`apiKeySource: none`), which Claude Code may emit only
after the first user message.

```
nestd            runner                         claude (stdio)          nest hook       AgentDO (session ch.)
 │ agent_start ──►│ register; write prompt, mcp cfg, transcript
 │                │ `claude auth status` → oauth_token (else auth_check{false} + exit)
 │                │ spawn (clean env) ────────────►│
 │                │ open session channel (Bearer host_token) ───────────────────────────────►│ hello
 │◄ agent_started │◄──────────────────────────────────────────────────────────── run_turn ──│
 │                │◄──────────── system/init ──────│ (may come after the first user message)
 │◄─ auth_check ──│ apiKeySource == none
 │                │ user msg ─────────────────────►│
 │                │                                │ PreToolUse ──► nest hook --sync
 │                │◄──────────────── HookDecisionRequest ───────────────────│
 │                │ match AgentCache.rules (~1 ms) ─ HookDecisionResponse ─►│ prints JSON
 │                │                                │ mcp__nest__Bash → nest mcp → runner → hands client → gateway → guest
 │                │◄── result ─────────────────────│ Stop ──► nest hook --sync (inbox mirror)
 │                │ tail transcript → segment ──────────────────────────────────────────────►│
 │                │ idle grace → close stdin → exit │
 │◄ agent_exited{idle}
```

## Interrupt

```
AgentDO ── interrupt{seq} ──► runner ── {"type":"control_request","request_id":"r7","request":{"subtype":"interrupt"}} ──► claude
runner ◄── {"type":"control_response","response":{"subtype":"success","request_id":"r7","response":{"still_queued":[]}}}
in-flight hands calls: nest mcp gets notifications/cancelled → bridge `cancel{id}` → runner sends `cancel` on the call's WebSocket, waits 5 s for a final frame, then closes it → the gateway closes the vsock side → guest cgroup.kill
fallback (no interrupt capability, or not honored within interrupt_grace): SIGINT to the Claude Code pid only
  (its process group also holds `nest mcp` and hooks), then SIGKILL of the group after another grace
hard kill (wedged): AgentStop{kill} or Fence → SIGKILL of the process group (no per-agent cgroup yet)
```

## Late input after an idle close

A `run_turn` that arrives after the runner closed stdin for idleness (Claude Code still exiting) is
held, and once the process exits the runner starts Claude Code again with
`--resume <current session file>` and runs it there — no `agent_exited` is reported for that exit.
After a stop or kill, such a turn is reported as an `error{agent_stopping}` agent event (tagged with
the turn) instead of being dropped, and the exit carries the stop or kill's reason. Inbox messages
never restart a brain: with no turn running they stay in the mirror for AgentDO to queue.

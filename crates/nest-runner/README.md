# nest-runner

The agent runner: runs unmodified Claude Code brains on a host, outside every VM; the design places it on brain hosts only (`docs/compute/brain-hosts/`). Design:
`docs/agents/runner/`. Contracts: `docs/interfaces/host-internal/` (nestd-runner, runner-hooks,
runner-mcp, runner-claude) and `docs/interfaces/control-host/session/`.

| Module | What |
|---|---|
| `supervisor` | nestd socket client: `agent_start/bind/stop`, `fence`, host token, lease mirror; connection generations (events about brains of an earlier connection are dropped); undecodable commands skipped. nestd gone or lease lapsed ⇒ kill every brain |
| `agent` | Per brain: register first, then (cancellable, with timeouts) write prompt + MCP config, rebuild a resumed session file from R2 segments, `claude auth status` (must be `oauth_token`), spawn with the exact argv and a clean env; refuse host-side built-ins; drive stream-json through a separate stdin writer (turns, inbox, interrupt → SIGINT to the pid → SIGKILL to the group), count user messages against `result`s, check `system/init.apiKeySource == "none"`, idle grace → close stdin; input arriving during an idle exit resumes Claude Code and is replayed |
| `session` | One WebSocket per agent to AgentDO: hello/resume (per-brain `instance_id`), reliable seq/acks with resend, event batching with state coalescing, session-file segments, platform tool relay (timed-out calls abandoned); on close keeps flushing up to 30 s until everything is acked and durable |
| `tailer` | Native session JSONL → whole-line segments by byte offset; base reset on shrink/inode change; same-length secret redaction |
| `hooks` | `hook.dgram` (tracking → state events), `hook.sock` (peer-bound to the brain's process tree; PreToolUse/PermissionRequest rules, Stop inbox mirror with a per-chain loop guard, SessionStart transcript rebase limited to `<config_dir>/projects/` + CLAUDE.md via hands), spool drain |
| `mcp` | `mcp.sock` bridge for `nest mcp` (peer-bound): hands tools (when bound) + AgentDO's platform tools; hands → guest RPC, rest → session relay; cancellation |
| `hands` | Guest hands RPC client (vsock UDS `CONNECT 1025`, one connection per call, `cancel` then hangup). The designed hands client speaks the [gateway contract](../../docs/interfaces/gateway/) (one WebSocket per call to the sandbox's gateway, binding first) and isn't built |
| `rules` | Permission-rule matching (`Tool`, `Tool(glob)`, `mcp__nest__*`) |
| `stream` | stream-json → canonical `AgentEvent`s |

Run: `nest-runner` (paths from `nest_protocol::host::paths`; override with `NEST_RUNNER_*`, see
`config.rs`).

## Behavior worth knowing

- **Inbox delivery** is reported to AgentDO (`inbox_delivered`) whether the message went in over stdin
  or through the `Stop` hook, so the mirror is pruned and a restarted brain doesn't see it again.
- **Timed-out platform calls** return `outcome_unknown` to the model and send `cancel_call`: an
  unacked `tool_call` is replaced in place (same seq, so the in-order lineage has no gap) and a fresh
  cancel follows, so AgentDO never runs it late.
- Error codes: [`docs/interfaces/host-internal/nestd-runner/`](../../docs/interfaces/host-internal/nestd-runner/).

## Tests

`cargo test -p nest-runner` (units, plus `tests/lifecycle.rs`: duplicate start, fence during startup,
kill with a full stdin, lease/forbidden-tool refusal, abandoned platform calls) and
`cargo test -p nest-cli` (end-to-end: runner + real `nest` binary + `crates/nest-cli/tests/fake_claude.py`
+ fake nestd + mock AgentDO + fake guest). The real `claude` binary is never invoked.

## Known gaps

- **Brain isolation:** brains run as the runner's user in their own process group (killed with
  `killpg`), not as per-agent systemd `DynamicUser` units with `cgroup.kill`; brains on one host can
  read each other's environment through `/proc`. Socket group ownership (`nest-agents`) is left to
  the unit files.
- **Hook datagrams aren't peer-checked** (tracking only); sync hooks and the MCP bridge are.
- **`rate_limit_event`** from the stream is parsed but not mapped to events (rate limits are still
  reported from `system/api_retry` and `StopFailure`).
- **Hands reach the guest over local vsock only** (`agent_start.hands.vsock_uds_path`), which ties the brain to the sandbox's host. The gateway client, bindings and `hands_resolve` from `docs/agents/runner/` aren't built.
- **Permission rules** are accident prevention: Bash prefix globs are easy to sidestep.
- The guest hands `call_id` uses Claude Code's `tool_use` id from MCP `_meta` when present
  (unverified that Claude Code sends it), else a generated `hc_…`.

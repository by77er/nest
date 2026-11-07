# nest-runner

The agent runner: runs unmodified Claude Code brains on a brain host (`docs/compute/brain-hosts/`), outside every VM. Sandbox hosts keep it enabled for one release only, for a Worker rolled back to the previous release (`dev/deploy.md`). Design:
`docs/agents/runner/`. Contracts: `docs/interfaces/host-internal/` (nestd-runner, runner-hooks,
runner-mcp, runner-claude) and `docs/interfaces/control-host/session/`.

| Module | What |
|---|---|
| `supervisor` | nestd socket client: `agent_start`, `agent_stop`, `fence`, host token, lease mirror; connection generations (events about brains of an earlier connection are dropped); undecodable commands skipped. nestd gone or lease lapsed ⇒ kill every brain |
| `agent` | Per brain: register first, then (cancellable, with timeouts) write prompt + MCP config, rebuild a resumed session file from R2 segments, `claude auth status` (must be `oauth_token`), spawn with the exact argv and a clean env; refuse any built-in outside `HOST_SAFE_BUILTINS` (at start, and in `system/init.tools`); drive stream-json through a separate stdin writer (turns, inbox, interrupt → SIGINT to the pid → SIGKILL to the group), count user messages against `result`s and report `turn_completed` + `idle` once, when none is outstanding (or after the 10 s settle), with the turn's id and usage summed over its results; check `system/init.apiKeySource == "none"`, idle grace → close stdin, then SIGKILL to the group if it hasn't exited after the exit grace (30 s; from a graceful stop's running turn's end); input arriving during an idle exit resumes Claude Code and is replayed |
| `session` | One WebSocket per agent to AgentDO: hello/resume (per-brain `instance_id`), reliable seq/acks with resend, event batching with state coalescing, session-file segments, platform tool relay (timed-out calls abandoned); on close keeps flushing up to 30 s until everything is acked and durable |
| `tailer` | Native session JSONL → whole-line segments by byte offset; base reset on shrink/inode change; same-length secret redaction |
| `hooks` | `hook.dgram` (tracking → state events), `hook.sock` (peer-bound to the brain's process tree; PreToolUse/PermissionRequest rules, Stop inbox mirror with a per-chain loop guard, SessionStart transcript rebase limited to `<config_dir>/projects/` + CLAUDE.md via hands), spool drain |
| `mcp` | `mcp.sock` bridge for `nest mcp` (peer-bound): hands tools (for any agent with a bound sandbox, whatever its template) + AgentDO's platform tools; hands → the sandbox's gateway, rest → session relay; cancellation |
| `hands` | Hands over the [gateway contract](../../docs/interfaces/gateway/) through `nest-hands-client`: one WebSocket per call to the sandbox's gateway, binding first. The target (gateway URL, binding, guest version) comes from AgentDO over the session channel (`hands_resolve`), prefetched at `agent_start`, resolved again 60 s before the binding's `exp_ms` (read from its claims), and again when a gateway refuses it, per `nest_hands_client::Next`: `stale_epoch`, `moved`, `unknown_key`, `unauthorized` (an expired or revoked binding), `unsupported_version` (a target minted with an older guest version), a refused or reset connect, a hostname that no longer resolves, an HTTP 5xx or 401/403 from in front of the gateway (Cloudflare's edge with no connector behind the hostname, or Access refusing the credential; a 5xx waits 2 s first, since a reconnecting tunnel answers 530 for a few seconds), or a connect timeout (a dead host) get one re-resolve in the same call, and any refused target is dropped for the next; `busy`, the gateway's or the guest's own (not configured yet, refused before anything runs), and a bind that timed out are retried within one 30 s budget, or 120 s once the gateway answered `busy` with reason `paused` (a checkpoint's pause fits), and `sandbox_not_ready` for up to 60 s, every sleep capped at 10 s and at what is left of the budget; N parallel first calls share one resolve; a request made while the session channel is down is sent after the next `hello_ack`; `cancel` then hangup; a 4409 close mid-call is an unknown outcome and a 4401 a refusal, both drop the target |
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
- **The runner holds no vsock path and no binding of its own:** `agent_start.hands` names the sandbox only (the brain's own epoch is `agent_start.epoch`; the sandbox epoch comes from each binding's claims), and every target is fetched from AgentDO. The edge credential (`HandsTarget.edge`, the Access service token from BrokerDO, present only for a host with a tunnel) rides along to the client untouched.
- **Permission rules** are accident prevention: Bash prefix globs are easy to sidestep.
- The guest hands `call_id` uses Claude Code's `tool_use` id from MCP `_meta` when present
  (unverified that Claude Code sends it), else a generated `hc_…`.

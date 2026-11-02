# nest-cli (`nest`)

One binary, installed at `/usr/lib/nest/nest` on hosts and in guest images.

| Command | Where | What |
|---|---|---|
| `nest hook [--sync]` | host (Claude Code hooks) | async: one datagram to the runner (spool on failure); `--sync`: one decision request (8 s, 18 s for `SessionStart`), prints the hook JSON; runner unreachable ⇒ spec'd fallback. **Always exits 0.** Spec: `docs/interfaces/host-internal/runner-hooks/` |
| `nest mcp` | host (spawned by Claude Code) | stdio MCP server (newline-delimited JSON-RPC) forwarding `tools/list`, `tools/call`, cancellations to the runner, reconnecting lazily if the runner connection drops; `notifications/tools/list_changed` on rebind. Spec: `runner-mcp/` |
| `nest expose\|unexpose\|whoami` | guest | One `CliRequest` to the guest agent (`NEST_GUEST_SOCK`, default `/run/nest/guest.sock`); attributed by `NEST_AGENT_ID`. Spec: `docs/interfaces/host-guest/` |

`tests/e2e.rs` drives the real runner end to end with `tests/fake_claude.py` standing in for
Claude Code (including a turn arriving during an idle exit, and hooks from processes outside the
brain getting the fallback).

**Known gaps:** `nest mcp` relies on the runner for everything, so with no runner reachable every
tool call fails (it reconnects lazily). `nest hook --sync` falls back to deny for `PreToolUse` /
`PermissionRequest` and to allow (no output) for `SessionStart` / `Stop` when the runner is down.

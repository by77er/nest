# runner ↔ Claude Code

Unmodified Claude Code, documented flags only. Reference artifacts in `protocol/claude-code/`; builders in `nest_protocol::host::claude` (golden-tested).

## Command line

```bash
cd /var/lib/nest/empty && exec claude -p --input-format stream-json --output-format stream-json --verbose \
  --restricted --tools "<launch.builtin_tools, comma-joined; empty for captains>" \
  --strict-mcp-config --mcp-config <config_dir>/nest-mcp.json \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "mcp__nest__*,<builtin_tools…>" \
  --disable-slash-commands \
  --append-system-prompt-file <config_dir>/nest-system-prompt.md   # workers (launch.system_prompt.mode=append)
  # --system-prompt-file <config_dir>/nest-system-prompt.md        # captains (mode=replace)
  [--model <m>] [--effort <e>] \
  (--session-id <uuid> | --resume <transcript path> [--fork-session])
```

Never `--bare` (ignores OAuth) or `--safe-mode` (drops MCP servers). Recommended worker built-ins: `Agent, TaskCreate, TaskGet, TaskUpdate, TaskList, TodoWrite, WebSearch, WebFetch` (**unverified** under `--restricted`; the runner logs `system/init.tools`).

**Host-side built-ins are refused:** a `launch.builtin_tools` naming `Bash`, `BashOutput`, `KillShell`, `KillBash`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `LS`, `PowerShell` or `Monitor` fails the start, and if `system/init.tools` reports one the brain is killed (`--restricted` re-enables tools named individually in `--tools`).

**Process:** Claude Code runs in its own process group (with `nest mcp` and hooks). SIGINT goes to the Claude Code pid only; SIGKILL to the group. Startup subprocesses (`auth status`, `--version`) run in the empty cwd with timeouts and are killed if abandoned.

## Environment (complete; nothing inherited)

`PATH`, `HOME=<config_dir>`, `LANG=C.UTF-8`, `TZ=UTC`, `TMPDIR=/tmp` (private), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (hooks and MCP never see the token), `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, `DISABLE_AUTOUPDATER=1`, `NEST_AGENT_ID`, `NEST_HOOK_DGRAM`, `NEST_HOOK_SOCK`, `NEST_HOOK_SPOOL`. Built by `claude::env(agent, config_dir, oauth_token, &RunnerSockets)`; the MCP config by `claude::mcp_config(agent, &RunnerSockets)` and the transcript path by `claude::transcript_path(config_dir, cwd, uuid)`. `paths::RunnerSockets::default()` is the production layout; tests and dev runs override it. **No `ANTHROPIC_*`, no proxy variables** (brains aren't proxied).

**Unverified:** that the scrub keeps `NEST_*` variables (their names don't look like credentials).

## Managed settings

`/etc/claude-code/managed-settings.json` (`protocol/claude-code/managed-settings.json`):

```json
{ "forceLoginMethod": "claudeai", "allowedProviders": ["anthropic"], "allowManagedHooksOnly": true,
  "autoMemoryEnabled": false, "permissions": {"disableBypassPermissionsMode": "disable"},
  "hooks": { "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/lib/nest/nest hook --sync", "timeout": 10, "onFailure": "block"}]}], "…": "see file" } }
```

`onFailure` requires Claude Code ≥ 2.1.295. **Unverified:** that `CLAUDE_CODE_OAUTH_TOKEN` is accepted under `forceLoginMethod: "claudeai"` (spike).

## Auth check (before any turn)

1. `system/init.apiKeySource` must be `"none"`.
2. `claude auth status` (same env) must report `authMethod: "oauth_token"`.

Otherwise the runner kills the agent and reports `auth_check{ok:false}`. This also catches `--bare` becoming the default for `-p`.

## stream-json subset

**stdin** (`host::claude::StreamIn`):
- `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]},"parent_tool_use_id":null}`
- `{"type":"control_request","request_id":…,"request":{"subtype":"interrupt"[,"cancel_queued":true]}}`

**stdout** (`host::claude::StreamOut`; everything else parses as `Other`):

| Line | Used for |
|---|---|
| `system/init` | `session_id`, `claude_code_version`, `apiKeySource`, `tools`, `capabilities` (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`) |
| `assistant` / `user` | `AgentEvent` tool calls, results, text |
| `system/api_retry` | `error: "rate_limit"` → `AgentEventBody::RateLimited` |
| `rate_limit_event` | quota signals (`status`, `rateLimitType`, `utilization`, `resetsAt`) |
| `result` | turn end: `subtype`, `is_error`, `stop_reason`, `usage`, `total_cost_usd` |
| `control_response` | interrupt receipt (`still_queued`) |

Shapes checked against `@anthropic-ai/claude-agent-sdk` 0.3.296 type definitions. The `user` input shape omits `session_id` (**unverified**).

## Sources

Every flag and variable used here is documented by Anthropic. Anything not confirmed against the real binary is marked **unverified** above.

| What | Source |
|---|---|
| `-p`, `--input-format`/`--output-format stream-json`, `--verbose`, `--restricted`, `--tools`, `--strict-mcp-config`, `--mcp-config`, `--permission-mode`, `--permission-prompts`, `--allowedTools`, `--disable-slash-commands`, `--system-prompt-file`, `--append-system-prompt-file`, `--model`, `--effort`, `--session-id`, `--resume`, `--fork-session`, `--bare`, `--safe-mode` | [CLI reference](https://code.claude.com/docs/en/cli-reference) |
| Headless mode, interrupt (SIGINT / control request), `system/init` capabilities, `system/api_retry` | [Headless](https://code.claude.com/docs/en/headless) |
| `CLAUDE_CODE_OAUTH_TOKEN`, `claude setup-token`, credential precedence, `forceLoginMethod`, `allowedProviders` | [Authentication](https://code.claude.com/docs/en/authentication) |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, `CLAUDE_CODE_SHELL_PREFIX` | [Environment variables](https://code.claude.com/docs/en/env-vars) |
| Hook events, `async`, `timeout`, `onFailure`, decision output | [Hooks](https://code.claude.com/docs/en/hooks) |
| Personal-use terms for subscription OAuth | [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) |

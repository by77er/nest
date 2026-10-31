# runner ↔ Claude Code

> **Implemented contract.** `--tools` is the template's `launch.builtin_tools` as given; the seeded `worker` template leaves out `Agent` and `TodoWrite`, as the design does ([CatalogDO](../../../control-plane/durable-objects/catalog/)). The design adds `--system-prompt-snapshot off`, the budget flags and `DISABLE_UPDATES=1`, and checks a [pinned version](#version); see [pending contract changes](../../README.md#pending-contract-changes).


Unmodified Claude Code, documented flags only. Reference artifacts in `protocol/claude-code/`; builders in `nest_protocol::host::claude` (golden-tested).

## Command line

```bash
cd /var/lib/nest/empty && exec claude -p --input-format stream-json --output-format stream-json --verbose \
  --restricted --tools "<launch.builtin_tools, comma-joined; empty in the captain template>" \
  --strict-mcp-config --mcp-config <config_dir>/nest-mcp.json \
  --permission-mode dontAsk --permission-prompts none \
  --allowedTools "mcp__nest__*,<builtin_tools…>" \
  --disable-slash-commands \
  --append-system-prompt-file <config_dir>/nest-system-prompt.md   # launch.system_prompt.mode=append (the worker template)
  # --system-prompt-file <config_dir>/nest-system-prompt.md        # mode=replace (the captain template)
  [--model <m>] [--effort <e>] \
  (--session-id <uuid> | --resume <transcript path> [--fork-session])
```

Never `--bare` (ignores OAuth) or `--safe-mode` (drops MCP servers). The seeded worker's built-ins: `TaskCreate, TaskGet, TaskUpdate, TaskList, WebSearch, WebFetch`; the probes below also name `Agent` and `TodoWrite`. **Observed on 2.1.301** (`e2e/claude-verify`, with a real turn): `system/init.tools` lists `Task` (for `Agent`), the four task tools, `WebSearch` and `WebFetch`; `TodoWrite` is missing even when named, which is why the designed invocation leaves it out. A captain's `--tools ""` gives no built-ins. The runner logs `system/init.tools`.

**Built-ins are an allowlist** (`nest_runner::agent::HOST_SAFE_BUILTINS`): `Agent`, `Task`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TodoWrite`, `WebSearch`, `WebFetch`, `ListMcpResourcesTool`, `ReadMcpResourceTool`. A `launch.builtin_tools` naming anything else fails the start, and if `system/init.tools` reports anything else besides `mcp__*` tools the brain is killed (`--restricted` re-enables tools named individually in `--tools`), so a built-in Claude Code adds later is refused until reviewed.

**Process:** Claude Code runs in its own process group (with `nest mcp` and hooks). SIGINT goes to the Claude Code pid only; SIGKILL to the group. Startup subprocesses (`auth status`, `--version`) run in the empty cwd with timeouts and are killed if abandoned.

## Version

**Designed:** the host release pins one Claude Code version and the SHA-256 of its binary. Before spawning, the runner checks `claude --version` against the version and hashes the binary it will exec; a mismatch refuses the start with `claude_version` ([nestd-runner](../nestd-runner/)). `DISABLE_UPDATES=1` and `DISABLE_AUTOUPDATER=1` keep the binary from changing underneath. A new pin needs the `e2e/claude-verify` probes, the hands fidelity eval and resuming the previous baseline's sessions to pass ([runner](../../../agents/runner/)). Observations below name the version they were made on.

## Environment (complete; nothing inherited)

`PATH`, `HOME=<config_dir>`, `LANG=C.UTF-8`, `TZ=UTC`, `TMPDIR=/tmp` (private), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` (hooks and MCP never see the token), `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, `DISABLE_AUTOUPDATER=1`, `NEST_AGENT_ID`, `NEST_HOOK_DGRAM`, `NEST_HOOK_SOCK`, `NEST_HOOK_SPOOL`. Built by `claude::env(agent, config_dir, oauth_token, &RunnerSockets)`; the MCP config by `claude::mcp_config(agent, &RunnerSockets)` and the transcript path by `claude::transcript_path(config_dir, cwd, uuid)`. `paths::RunnerSockets::default()` is the production layout; tests and dev runs override it. **No `ANTHROPIC_*`, no proxy variables** (brains aren't proxied).

**Observed on 2.1.300:**
- The scrub keeps `NEST_*` for hooks and the MCP server; it strips the token and `CLAUDE_CONFIG_DIR` from hooks.
- **The scrub needs bubblewrap on Linux:** with `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and no `bwrap`, Claude Code won't start, not even `claude auth status`. Hosts install `bubblewrap`, or managed settings set `sandbox.bwrapPath`.
- **The scrub forces `--permission-mode default`** (instead of `dontAsk`, with a warning on stderr). Whether nest's allow rules and hooks still behave the same is to be verified with a real token.
- **`system/init` arrives only after the first user message.** Before it, stdout carries only the `SessionStart` hook lines, so the runner never waits for `system/init` before writing the first turn.
- **Transcript path:** every character that isn't an ASCII letter or digit becomes `-`, and a name over 200 characters is cut and suffixed with a hash (`claude::project_dir`).

## Managed settings

`/etc/claude-code/managed-settings.json` (`protocol/claude-code/managed-settings.json`):

```json
{ "forceLoginMethod": "claudeai", "allowedProviders": ["anthropic"], "allowManagedHooksOnly": true,
  "autoMemoryEnabled": false, "permissions": {"disableBypassPermissionsMode": "disable"},
  "hooks": { "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "/usr/lib/nest/nest hook --sync", "timeout": 10, "onFailure": "block"}]}], "…": "see file" } }
```

`onFailure` requires Claude Code ≥ 2.1.295. **Checked on 2.1.301:** `CLAUDE_CODE_OAUTH_TOKEN` is accepted under `forceLoginMethod: "claudeai"`, `claude auth status` reports `authMethod: "oauth_token"` and the `configDirectory`, and `system/init.apiKeySource` is `"none"`.

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

Shapes checked against `@anthropic-ai/claude-agent-sdk` 0.3.296 type definitions. The `user` input shape omits `session_id`; a turn sent that way completes (checked on 2.1.301).

**Also checked on 2.1.301** (`e2e/claude-verify`):
- **Permissions:** under the `default` permission mode the env scrub forces, nest's allow rules and `PreToolUse` hooks let `mcp__nest__*` calls run without prompts.
- **Resume:** with `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, `--resume` after a SIGKILL mid tool call continues the turn without input.
- **`defer`:** a `defer` answer ends the run with `stop_reason: "tool_deferred"`, and `--resume` fires `PreToolUse` again for the same `tool_use_id`.
- **Compaction:** `SessionStart` fires with `source: "compact"` after `/compact`, which needs slash commands enabled.

### Hooks (checked on 2.1.316)

`e2e/claude-verify` items 11 and 12, haiku, 2026-10-31, one user message per turn on stdin; evidence in [`e2e/claude-verify/observed/2.1.316-hooks.json`](../../../../e2e/claude-verify/observed/2.1.316-hooks.json).

- **`PostToolUse` `additionalContext` reaches the model mid-turn** (sync hook, as managed settings wire it). The context after a call carried a random token and an order to pass it to `mcp__nest__echo`. After `mcp__nest__echo` and after the built-in `TaskList`, the main loop made that call with the token in the same turn (one `result` per turn). A control turn without context made one echo call and never produced its token. The context isn't on stdout: the transcript holds it as a `hook_additional_context` attachment.
- **In a subagent,** `PostToolUse` fires for the subagent's own call (input has `agent_id` and `agent_type`) and its context goes to the subagent, not the main loop: the subagent's transcript holds the attachment, and the haiku subagent replied that the tool result "included an instruction to call the echo tool … so I ignored it" (twice in two runs). The main loop never saw it. The runner therefore hands out nothing to a `PostToolUse` whose input has `agent_id`.
- **`Stop` `block`:** a `{"decision":"block","reason":…}` answer gives **no intermediate `result`**. The reason arrives as a `user` line (`Stop hook feedback:` plus the reason); the model acted on it (called echo with the token, then replied with the word it asked for); `Stop` fired again at the continuation's end with `stop_hook_active: true`, and the turn's one `result` came after that. The next turn had one `Stop` and one `result`.
- **`system/init` comes once per turn,** before the turn's first assistant line (three turns, three `init` lines), not once per process. The runner treats a repeat as a no-op (the auth check reports once).

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

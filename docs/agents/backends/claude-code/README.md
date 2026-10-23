# claude-code backend

The agent's brain is an [agent runner](../../runner/) Claude Code process on a [brain host](../../../compute/brain-hosts/). The runner's pinned Claude Code baseline and its auth, environment, lifecycle and hygiene rules all apply. The command line comes from the spawn spec's launch config; nothing about it depends on what the agent is for.

- **With hands:** hands calls go through the runner's hands client to the sandbox's [gateway](../../../sandbox/gateway/), wherever that sandbox runs. Built-in tools are limited to ones that don't touch the host, and Claude Code's coding prompt is kept (`--append-system-prompt-file`). See the [runner](../../runner/).
- **Without hands** (e.g. the `captain` template): the same brain host kind, usually with no built-in tools and a replaced prompt:

```bash
cd /var/lib/nest/empty && CLAUDE_CONFIG_DIR=/var/lib/nest/agents/<agent-id> \
claude -p --input-format stream-json --output-format stream-json --verbose \
  --restricted --tools "" \
  --strict-mcp-config --mcp-config <config_dir>/nest-mcp.json \
  --permission-mode dontAsk --permission-prompts none --allowedTools "mcp__nest__*" \
  --disable-slash-commands \
  --system-prompt-file <config_dir>/nest-system-prompt.md \
  (--session-id <uuid> | --resume <session file>)
```

The prompt file holds the spawn spec's prompt; the MCP config points `nest mcp` at the agent's AgentDO.

- **`--tools ""`** removes every built-in. `--tools "WebSearch"` brings back only web search.
- **`--system-prompt-file`** (`system_prompt.mode: replace`) swaps the coding prompt for the template's prompt, which is the same text an `api-loop` backend would use as `system`.
- **The MCP bridge is generic:** `tools/list` and `tools/call` are forwarded to the agent's AgentDO, and it contains no tool logic.
- **Mapping to canonical events:** the runner maps stream-json output to canonical events. Rate limits become `rate_limited`, and the scheduler applies the agent's priority.

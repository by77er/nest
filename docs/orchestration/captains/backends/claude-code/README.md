# claude-code backend

A captain is an [agent runner](../../../../agents/runner/) brain with **no hands and no built-in tools**, running on the controller host. The runner's auth, environment, lifecycle and hygiene rules all apply.

```bash
CLAUDE_CONFIG_DIR=/var/lib/nest/agents/<captain-id> \
claude -p --input-format stream-json --output-format stream-json --verbose \
  --restricted --tools "" \
  --strict-mcp-config --mcp-config <runner-generated: nest platform tools, proxied to the captain's AgentDO> \
  --permission-mode dontAsk --allowedTools "mcp__nest__*" \
  --disable-slash-commands \
  --system-prompt-file <config_dir>/nest-system-prompt.md   # prompt delivered by AgentDO \
  --resume <session>
```

- **`--tools ""`** removes every built-in. `--tools "WebSearch"` brings back only web search.
- **`--system-prompt-file`** replaces the coding prompt with the captain prompt, which comes from the control plane (`AgentStart.launch`) and is the same prompt the `api-loop` backend would use.
- **The MCP bridge is generic:** `tools/list` and `tools/call` are forwarded to the captain's AgentDO, and it contains no tool logic.
- **Mapping to canonical events:** the runner maps stream-json output to canonical events. Rate limits become `rate_limited`, and the scheduler gives captains priority.

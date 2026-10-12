# Claude Code reference artifacts

Used by `nest_protocol::host` tests and the agent runner. Spec: `docs/interfaces/host-internal/runner-claude/`.

| File | What |
|---|---|
| `managed-settings.json` | Installed at `/etc/claude-code/managed-settings.json` on every host |
| `mcp-config.json` | Generated per agent (`host::claude::mcp_config`); `agt_EXAMPLE` stands in for the agent ID |
| `stream-in.jsonl` | stdin lines the runner writes |
| `stream-out.jsonl` | Representative stdout lines (shapes from the Agent SDK 0.3.296 `.d.ts`) |

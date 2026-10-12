# runner ↔ `nest mcp`

`nest mcp` is the stdio MCP server Claude Code spawns from the generated config (server name `nest`, so tools appear as `mcp__nest__<Name>`). It speaks MCP JSON-RPC on stdio and forwards to the runner over `/run/nest/runner/mcp.sock` (framed). **It has no tool logic and no credentials.** Its env is the MCP config `env` only (`CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`): `NEST_AGENT_ID`, `NEST_MCP_SOCK`.

| MCP (Claude Code ↔ `nest mcp`) | Bridge (`nest mcp` → runner) | Reply |
|---|---|---|
| `initialize` | `hello{v, agent}` (and again lazily on the next request after the runner connection dropped) | `hello_ack` |
| `tools/list` | `tools_list{id}` | `tools_list{id, tools: McpToolDef[]}` |
| `tools/call` | `tools_call{id, name, arguments, tool_use_id?}` | `tools_call{id, result: {content, isError}}` |
| `notifications/cancelled` | `cancel{id}` | (the call's `tools_call` arrives as an error, or never) |
| — | — | `tools_changed{}` → `notifications/tools/list_changed` |

**Peer binding:** the runner accepts `hello{agent}` only from a process (`SO_PEERCRED`) descending from that agent's Claude Code process; otherwise `error{unknown_agent}`.

**Runner routing:**
- **Hands tools** (`Bash`, `TaskOutput`, `TaskStop`, `Read`, `Write`, `Edit`, `Glob`, `Grep`; schemas in `protocol/schemas/guest/`) become a `guest::HandsRequest` over the agent's vsock binding. Unbound agents get `error{not_bound}`. The guest `call_id` is `tool_use_id` — Claude Code's `tool_use` id, which `nest mcp` takes from the request's `_meta` (`claudecode/toolUseId`, `toolUseId` or `tool_use_id`; **unverified** that Claude Code sends it) — or a generated `hc_<random>`.
- **Platform tools** (`control::ToolDef` from AgentDO, converted with `From<&ToolDef> for McpToolDef`) become a `RunnerToAgent::ToolCall` on the session channel. The result is `From<&ToolOutcome> for ToolCallResult`; `pending` is *not* `isError` (the model is told to end the turn).
- **Platform call timeout (150 s):** the call is abandoned — removed from the session channel's resend queue so it can't execute later — and the model gets a non-retryable `outcome_unknown` error ("may or may not have taken effect; check before retrying"). The call may still have run if AgentDO already received it; there is no cancel message on the session channel yet.
- **Tool timeout:** 15 min in the MCP config. Long work uses background hands tasks.

# runner ↔ `nest mcp`

`nest mcp` is the stdio MCP server Claude Code spawns from the generated config (server name `nest`, so tools appear as `mcp__nest__<Name>`). It speaks MCP JSON-RPC on stdio and forwards to the runner over `/run/nest/runner/mcp.sock` (framed). **It has no tool logic and no credentials.** Its env is the MCP config `env` only (`CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`): `NEST_AGENT_ID`, `NEST_MCP_SOCK`.

| MCP (Claude Code ↔ `nest mcp`) | Bridge (`nest mcp` → runner) | Reply |
|---|---|---|
| `initialize` | `hello{v, agent}` (and again lazily on the next request after the runner connection dropped) | `hello_ack` |
| `tools/list` | `tools_list{id}` | `tools_list{id, tools: McpToolDef[]}` |
| `tools/call` | `tools_call{id, name, arguments, tool_use_id?}`, with `tool_use_id` from the request's `_meta["claudecode/toolUseId"]` (undocumented; observed on 2.1.301, matching `PreToolUse.tool_use_id`) | `tools_call{id, result: {content, isError}}` |
| `notifications/cancelled` | `cancel{id}` | (the call's `tools_call` arrives as an error, or never). On interrupt it reaches the MCP server within milliseconds (observed on 2.1.301) |
| — | — | `tools_changed{}` → `notifications/tools/list_changed` (the runner never sends it: a brain's tools are fixed at its start) |

**Peer binding:** the runner accepts `hello{agent}` only from a process (`SO_PEERCRED`) descending from that agent's Claude Code process; otherwise `error{unknown_agent}`.

**Runner routing:**
- **Hands tools** (`Bash`, `TaskOutput`, `TaskStop`, `Read`, `Write`, `Edit`, `Glob`, `Grep`; schemas in `protocol/schemas/guest/`) become a `guest::HandsRequest` on one connection per call: a WebSocket from the runner's hands client to the sandbox's gateway, carrying the agent's binding ([gateway](../../gateway/)). Unbound agents get `error{not_bound}`. The guest `call_id` is `tool_use_id` — Claude Code's `tool_use` id, which `nest mcp` takes from the request's `_meta` (`claudecode/toolUseId`, `toolUseId` or `tool_use_id`; **unverified** that Claude Code sends it) — or a generated `hc_<random>`.
- **Hands, designed** ([host-guest](../../host-guest/#refusals-and-call-records-v2)):
  - **Refusals:** an `error` frame with `executed: false` and `retryable` is retried on a new connection with the same `call_id`, for up to 30 s, waiting `retry_after_ms` (default 1 s) between tries. Other errors reach the model as MCP errors with their code. A frame without `executed` (v1 guests) is never retried.
  - **Silence:** with a guest that has `heartbeat`, 30 s without a frame fails the call; with any guest, so does the tool's own deadline plus 15 s. The runner closes the connection, which cancels the call, and returns `outcome_unknown`.
  - **Input drift:** arguments pass through verbatim and the guest ignores fields it doesn't know, but a field `hands-tools.json` lists as rejected for that tool gets an `unsupported` error naming it, before any connection.
- **Platform tools** (`control::ToolDef` from AgentDO, converted with `From<&ToolDef> for McpToolDef`) become a `RunnerToAgent::ToolCall` on the session channel. The result is `From<&ToolOutcome> for ToolCallResult`; `pending` is *not* `isError` (the model is told to end the turn).
- **Platform call timeout (150 s):** the call is abandoned. An unacked copy is replaced in place by a `cancel_call` with the same seq, and a fresh `cancel_call` is sent too, so AgentDO never runs it late (see [session](../../control-host/session/)). The model gets a non-retryable `outcome_unknown` error ("may or may not have taken effect; check before retrying"); the call may still have run if AgentDO executed it before the cancel arrived.
- **Runner connection lost:** every `tools/call` sent on that connection is answered `outcome_unknown` (the runner may still run it), every `tools/list` with an error; requests sent on the next connection (opened lazily by the next request) are not touched.
- **Tool timeout:** 15 min in the MCP config. Long work uses background hands tasks.

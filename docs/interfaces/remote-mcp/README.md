# Control plane → remote MCP server

What nest sends a remote MCP server named by an [mcp capability](../../agents/capabilities/mcp/). The server is any MCP server; nothing here is required of it beyond the spec. No Rust types: only the control plane speaks it.

- **Transport:** MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), protocol `2025-11-25` (the server may answer `2025-06-18` or `2025-03-26`). `POST <url>` with one JSON-RPC message; `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <token>` (the capability's `cap:<name>` secret), and after `initialize` the `Mcp-Session-Id` it returned and `MCP-Protocol-Version`. A JSON or SSE answer is read up to 1 MiB; redirects aren't followed. Methods used: `initialize`, `notifications/initialized`, `tools/list` (with `cursor`, at most 10 pages), `tools/call`.
- **Request `_meta` on `tools/call`** (a plain server ignores it):

| Key | Value |
|---|---|
| `nest/agent` | The calling agent's id (`agt_…`) |
| `nest/epoch` | The agent epoch of the brain that made the call (an integer) |
| `nest/call` | The call key `<agent>/<epoch>/<call>`: the same on a retry of the same call, so a server may deduplicate on it |
| `nest/taint` | Whether the calling session is tainted (a boolean), read as the request leaves |

- **What a server may rely on:** a call key reaches it twice only for a tool it (or the operator) declares idempotent, after the first answer was lost; calls of one agent from two brains never overlap (a new epoch's first call leaves only after the older epoch's calls were answered or timed out); every call carries the same bearer.
- **What nest reads back:** a `CallToolResult` (`content`: `text`, `image`, `resource_link`, `resource`; `structuredContent` when there is no content; `isError`), a JSON-RPC error, or an HTTP status (404 to a request naming a session: the session ended). Tool annotations `readOnlyHint` and `idempotentHint` decide retries unless the capability overrides them.

# Control plane → remote MCP server

What nest sends a remote MCP server named by an [mcp capability](../../agents/capabilities/mcp/). The server is any MCP server; nothing here is required of it beyond the spec. No Rust types: only the control plane speaks it.

- **Transport:** MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), protocol `2025-11-25` (the server may answer `2025-06-18` or `2025-03-26`). `POST <url>` with one JSON-RPC message; `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer <token>` (the capability's `cap:<name>` secret, or its [OAuth](#oauth) access token), and after `initialize` the `Mcp-Session-Id` it returned and `MCP-Protocol-Version`. A JSON or SSE answer is read up to 1 MiB; redirects aren't followed. Methods used: `initialize`, `notifications/initialized`, `tools/list` (with `cursor`, at most 10 pages), `tools/call`. Each agent calls over a session of its own (`clientInfo.name` `nest`); nest's connector lists over one more per server and credential (`nest-connector`), again every 60 s while brains use the list. A `notifications/tools/list_changed` on any SSE answer makes nest list again; nest opens no GET stream.
- **`Nest-Identity` header** (being built, [API clients](../../control-plane/api/clients/#caller-identity-for-mcp-servers)): a 5-minute EdDSA JWT naming the calling agent, its owner, client and labels, verifiable against `GET /.well-known/jwks.json`. The `_meta` keys below are informational; the header is the proof.
- **Request `_meta` on `tools/call`** (a plain server ignores it):

| Key | Value |
|---|---|
| `nest/agent` | The calling agent's id (`agt_…`) |
| `nest/epoch` | The agent epoch of the brain that made the call (an integer) |
| `nest/call` | The call key `<agent>/<epoch>/<call>`: the same on a retry of the same call, so a server may deduplicate on it |
| `nest/taint` | Whether the calling session is tainted (a boolean), read as the request leaves |

- **What a server may rely on:** a call key reaches it twice only for a tool it (or the operator) declares idempotent, after the first answer was lost; calls of one agent from two brains never overlap (a new epoch's first call leaves only after the older epoch's calls were answered or timed out); every call carries the capability's bearer (a static one, or an OAuth access token that changes on refresh).
- **What nest reads back:** a `CallToolResult` (`content`: `text`, `image`, `resource_link`, `resource`; `structuredContent` when there is no content; `isError`), a JSON-RPC error, or an HTTP status (404 to a request naming a session: the session ended). Tool annotations `readOnlyHint` and `idempotentHint` decide retries unless the capability overrides them.

## OAuth

What nest sends when a capability's `auth` is the oauth form ([decisions](../../agents/capabilities/mcp/#oauth); the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) 2025-11-25 is the contract):

- **Discovery:** `POST <url>` `initialize` without `Authorization`, to read the 401's `WWW-Authenticate: Bearer resource_metadata=…, scope=…`; `GET` of that URL or the well-known ones; `GET` of the authorization server's metadata. All `Accept: application/json`, redirects not followed.
- **Registration** (only without a pre-registered client or metadata document support): `POST <registration_endpoint>` with `{client_name: "nest", redirect_uris: [<base>/v1/oauth/callback], grant_types: [authorization_code, refresh_token], response_types: [code], token_endpoint_auth_method: none}`.
- **Authorization request** (the operator's browser): `response_type=code`, `client_id`, `redirect_uri=<base>/v1/oauth/callback`, `code_challenge` (S256), `code_challenge_method=S256`, `state`, `resource`, and `scope` when there is one.
- **Token requests** (`application/x-www-form-urlencoded`): `grant_type=authorization_code` with `code`, `redirect_uri`, `code_verifier`, `resource`; `grant_type=refresh_token` with `refresh_token`, `resource`. A public client sends `client_id`; a confidential one authenticates with HTTP Basic (or `client_secret_post` when that's all the server lists).
- **nest's client ID metadata document** at `<base>/v1/oauth/client.json`: `{client_id: <its URL>, client_name: "nest", redirect_uris: [<base>/v1/oauth/callback], grant_types: [authorization_code, refresh_token], response_types: [code], token_endpoint_auth_method: none}`.
- **What a server may rely on:** after a 401, a request is sent again at most once, with a new token; a refresh token is used by one request at a time.

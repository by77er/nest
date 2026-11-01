# nest-mcp-test

A rudimentary remote MCP server for nest's end-to-end tests: a separate Worker (`nest-mcp-test`)
that nest agents reach as an external `mcp{url}` capability. It is plain MCP; it shares no code with
`control-plane/` and nothing in the platform depends on it. Dev tooling, not platform design.

**Spec:** MCP [2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25) (the version
`docs/agents/capabilities/` cites), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
with JSON responses only (no SSE). `initialize` also negotiates `2025-06-18`; any other requested
version gets `2025-11-25`, per [version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation).

## Routes

Every route needs `Authorization: Bearer <MCP_TEST_TOKEN>` (else 401). A request with an `Origin`
header not listed in the optional var `ALLOWED_ORIGINS` gets 403 (DNS-rebinding rule).

| Route | What |
|---|---|
| `POST /mcp` | One JSON-RPC message. `initialize` (returns `Mcp-Session-Id`), `notifications/initialized` (202), `ping`, `tools/list`, `tools/call`. Every later request must carry the session id (400 without, 404 if unknown or ended). Needs `Content-Type: application/json` (415) and `Accept` listing `application/json` and `text/event-stream` (406). An unsupported `MCP-Protocol-Version` is 400. Batches, malformed JSON and non-JSON-RPC bodies are HTTP 400 with an id-less error; unknown methods are `-32601`. |
| `DELETE /mcp` | Ends the session (204; 404 if unknown). `GET /mcp` is 405: no SSE stream. |
| `GET /calls?since=<seq>` | `{calls: [{seq, ts_ms, session, tool, arguments, _meta, result_or_error}]}`, every `tools/call` after `seq`, in arrival order, at most 1000 per page. Logged on arrival: `result_or_error` is `null` while the call runs, then `{result}` (the `CallToolResult`) or `{error}` (the JSON-RPC error). `seq` never repeats, across resets too. |
| `POST /reset` | Clears notes, counters and the call log. Sessions survive. |

## OAuth mode (off by default)

With the var `MCP_TEST_OAUTH=1` the Worker is also its own authorization server ([MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)), so nest's e2e can run the flow headlessly (`src/oauth.ts`). Off, nothing below exists and every route stays as above, which is what the cloud check uses.

| Route | What |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` | [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) metadata: `resource` `<origin>/mcp`, `authorization_servers` `[<origin>/oauth]`. No bearer needed |
| `GET /.well-known/oauth-authorization-server/oauth` | [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) metadata, path-inserted (the issuer has a path): S256 only, client ID metadata documents and registration supported, public clients only. No bearer needed |
| `GET /oauth/authorize` | Needs `Authorization: Bearer <MCP_TEST_TOKEN>`, the stand-in for the user's login and consent, so turning the mode on lets nobody else get a token. Checks the client (registered, or a client ID metadata document it fetches: `client_id` must be its URL, and it must list the `redirect_uri`), `response_type=code`, S256 PKCE and `resource` = `<origin>/mcp`, then answers 302 to the redirect URI with `code` and `state` |
| `POST /oauth/token` | `authorization_code` (the code once, within 60 s, its client, redirect URI, verifier and `resource`) and `refresh_token` (always rotated: a spent one is `invalid_grant`). Access tokens last `MCP_TEST_OAUTH_TTL_S` (default 3600) |
| `POST /oauth/register` | [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591): https (or loopback http) redirect URIs; a public client |
| `POST /oauth/expire`, `POST /oauth/revoke`, `GET /oauth/log` | Static bearer only: expire every access token; revoke every token; the token requests seen (`grant_type`, `client_id`, outcome) and how often a metadata document was fetched |

`POST /mcp` then also admits a live access token for `<origin>/mcp` (`/calls` and `/reset` still need the static bearer), and its 401 is `Bearer resource_metadata="…", scope="mcp"` (with `error="invalid_token"` when a token was sent).

## Tools

All take exactly the listed arguments (`additionalProperties: false`) and state all three hints.

| Tool | Args | `readOnlyHint` / `idempotentHint` / `destructiveHint` | Answers |
|---|---|---|---|
| `echo` | `text` | true / true / false | the text |
| `note_put` | `key`, `value` | false / true / true | `stored <key>` |
| `note_get` | `key` | true / true / false | the value, or `isError` if there is none |
| `counter_add` | `name`, `n` (integer, \|n\| ≤ 10⁹) | false / false / false | the new total |
| `slow` | `ms` (integer, 0–30 000) | true / true / false | `waited <ms> ms`, after `ms` |

Unknown tools and a malformed `tools/call` (no `name`, non-object `arguments` or `_meta`) are
`-32602` protocol errors; bad arguments are tool execution errors (`isError: true`), as the
[tools spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling) says.
`_meta` (nest's proxy sends `nest/agent`, `nest/epoch`, `nest/call`, `nest/taint`) is ignored by the
tools and recorded in the call log. State lives in one SQLite-backed Durable Object (`McpState`).

## Develop and deploy

```bash
npm install
npm run typecheck && npm test                   # vitest in workerd (@cloudflare/vitest-plugin)
echo 'MCP_TEST_TOKEN=dev-token' > .dev.vars && npm run dev   # local, http://localhost:8787/mcp

npx wrangler deploy                             # to nest-mcp-test.<account>.workers.dev
npx wrangler secret put MCP_TEST_TOKEN          # the bearer; nest keeps the same token in BrokerDO
```

No custom domain or DNS: the `workers.dev` hostname is the URL a capability names
(`mcp{url: https://nest-mcp-test.<account>.workers.dev/mcp, auth: cap:<name>}`). There is no CI
workflow; deploys are by hand.

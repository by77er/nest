# Tool credentials are an app's own (2026-11-28)

**What:** a client's capabilities may no longer name an operator's tool credential (`cap:`, `{oauth}`), and a grant's `credentials` takes only model credentials (`claude_oauth_token[:<name>]`). The `mcp_urls` bound is no longer applied: a client's capabilities may name any https MCP server.

**Not a one-way deploy:** no Durable Object class changes.

**Order:** the Worker only. Before deploying, check that no client capability names an operator credential, no client template lists an operator MCP capability, no grant lists a credential beyond the model's, and no live client agent's spec names one (`GET /v1/admin/clients`, `GET /v1/admin/catalog`, the client agents' specs); 2026-11-28: none do (the two clients' templates list only `nest`, `hands`, `timers`, `subagents` of the operator's).

**Operator MCP servers that admit by identity alone:** a client can now point its own capability at any URL, so nest signs `Nest-Identity` tokens carrying that client for the operator's servers too. Before deploying, list the operator's mcp capabilities with no `auth` and confirm each server refuses a token that carries `client` ([remote MCP](../../docs/interfaces/remote-mcp/#no-bearer)). 2026-11-28: there are none; the operator's two mcp capabilities (`mcp-check`, `mcplive`) send a bearer (`cap:mcp-check`), which a client's capability can't name.

**`mcp_urls`, expand/contract:**
1. **This release:** taken, stored and shown, never checked. Apps keep listing the servers they rely on, because:
2. **`wrangler rollback`:** the previous release bounds client capabilities by `mcp_urls` again. A capability written meanwhile to a server not listed is refused at its next spawn (403), its OAuth start, a rewrite of it and any template write listing it, until the roll-forward. It also lets a client's template list an operator MCP capability again, when its URL is in `mcp_urls` (and, for one with a credential, the grant lists that credential) (the two clients' grants list none: projects' prefix `https://projects-nest.bitcru.sh/mcp/` covers no operator capability). Grants written meanwhile are read as written (a grant the previous release could write, as no field is new).
3. **The next release:** refuses a non-empty `mcp_urls` on a write (or drops it with a warning) and stops showing it; apps' setup scripts stop sending it first.

**Grants naming a tool credential:** refused on a write (400). One stored before reads as written and grants nothing; the previous release, after a rollback, honours it again.

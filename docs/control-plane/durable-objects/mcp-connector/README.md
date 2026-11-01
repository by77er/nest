# McpConnectorDO

One per remote MCP server and credential (`connectorName(grant)`: `["mcp", url, auth]`), in `control-plane/src/do/mcp-connector.ts`. The design and its rationale are in [mcp capabilities](../../../agents/capabilities/mcp/#the-connector); this is what the object holds and does.

- **RPCs (from AgentDO only):**
  - `list(grant, subscriber)`: the shared tool list (fetched again when older than 5 minutes or reported changed); a non-null `subscriber` (an agent whose brain is handed it) is told of later changes.
  - `changed(grant)`: an AgentDO read `notifications/tools/list_changed`: list again now.
  - `acquire(grant, agent, hold_ms)` / `release(lease)`: admission, by the calling grant's `max_concurrent` and `per_minute`.
- **Never:** forwards a call, sees its arguments, or decides an epoch. It reads the server's bearer through `mcpToken` (over `mcpBearer`: the one place nest obtains an MCP credential), for listing only, and on a 401 renews it once (an OAuth refresh) and lists again, as the proxy does for calls.
- **Alarm** (`Deadlines`, two keys): `relist` every `MCP_RELIST_MS` (60 s) while it has subscribers (also probes those quiet for 6 h); `notices` delivers `AgentDO.mcpToolsChanged` to each subscriber whose digest isn't the current list's, retried every 5 s, dropping one unreachable for 24 h or that answers it no longer wants them. Notices go out only from the alarm, never while an AgentDO is mid-call into this object.
- **Tables:** `kv` (grant, session, tools, digest, `listed_ms`, `stale`), `subscribers`, `leases`, `admits`, `deadlines`. Retention: [data](../../../data/).
- **Migration:** tag `mcp-connectors` (a one-way deploy: [dev/deploy.md](../../../../dev/deploy.md)).

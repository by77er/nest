# MCP capabilities

A capability with an `mcp` source gives an agent a remote MCP server's tools. The control plane is the MCP client: AgentDO lists the server's tools, hands them to the brain as `mcp__nest__<capability>_<tool>`, and forwards each call through its **MCP proxy** (`control-plane/src/lib/mcp-proxy.ts`, over `lib/mcp.ts`). The server stays plain MCP; what nest adds rides in `_meta`, which a server may ignore ([contract](../../../interfaces/remote-mcp/)).

## Catalog

```yaml
capability: notes
mcp: {url: https://mcp.example.com/mcp, auth: cap:notes, tools: [echo, note_get, note_put], idempotent: {echo: false}, trusted: false}
prompt: The notes server.
```

- **`url`:** `https` only, no credentials or fragment. A loopback host (`127.0.0.1`, `localhost`, `[::1]`, `http` or `https`) only where the Worker has `ALLOW_LOOPBACK_MCP=1` (tests and local dev, as in e2e). Checked when the capability is written and again at each use.
- **`auth`:** the BrokerDO secret holding the bearer token, `cap:<name>`, stored with `PUT /v1/admin/secrets/cap:<name>`. Only AgentDO reads it (`BrokerDO.capabilityToken`); `cap:` never resolves into a host command.
- **`tools`:** the allowlist. Absent: whatever the server lists (at most 128 per capability).
- **`idempotent`:** the operator's override of the server's annotations: a list of tools that are idempotent, or a map of tool to whether it is. Otherwise a tool is idempotent when the server marks it `readOnlyHint` or `idempotentHint` ([annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)), else not.
- **`trusted`** (default `false`): see [taint](#taint).
- **Names:** a capability's name has no `_`, so `<capability>_<tool>` splits back unambiguously. A capability whose name a platform tool starts with (`task_…`, `channel_…`) is refused; a later platform tool with a clashing name wins, and the remote one is left out of the list. A remote tool name is letters, digits, `_` and `-`, and `mcp__nest__<capability>_<tool>` at most 64 characters (the Messages API's tool name limit; unverified for Claude Code's MCP names, so conservative); others aren't listed.
- **Spawn:** the expanded spec copies each mcp capability's source (`AgentSpec.mcp`), like everything else in it: editing the capability changes later spawns only. `overrides.tools` narrows remote tools too, by their `<capability>_<tool>` names: a given list keeps only the remote tools it names (and drops a capability it names none of), and never widens an allowlist.

## The proxy is AgentDO's, not a Durable Object per server

**Decided (2026-10-31):** each AgentDO is the MCP client of its own capabilities' servers, with one MCP session per (agent, capability). A connector DO per server was the alternative.

**Why:** every guarantee is per agent and is exact only where the agent's epoch and call ledger live. AgentDO checks the epoch in the same synchronous step as the request leaves; a connector DO would need the epoch pushed to it (a window) or a callback into the AgentDO awaiting it (the cross-DO pattern the repo avoids). Calls already run one at a time per AgentDO (its serial queue), and `tool_calls` already keeps each call's outcome. No new class, so no one-way deploy. **Cost:** a session and a `tools/list` per agent rather than per server, and no place yet for a per-server rate limit or a shared session ([open question](#open-questions)).

## Listing

- **`tools_list`** answers with the platform tools and each capability's allowed tools, with the server's description (clipped to 2,000 characters) and `inputSchema`.
- **Cache:** a server's list is kept in AgentDO (`mcp_servers`) and reused for 5 minutes; an older one is fetched again, and if that fails the old list is served. A server that can't be listed contributes nothing to this list (the brain keeps the rest). Listing, `initialize` included, has 4 s (`MCP_LIST_TIMEOUT_MS`); the runner waits 10 s for a list. Tool lists change for a brain only at its next start (as for platform tools); `notifications/tools/list_changed` isn't listened for.

## Calls

- **Authority:** only a capability in the agent's spec, and only a tool on its allowlist (`forbidden` otherwise; `unknown_tool` for a capability it doesn't have). Not reachable from a sandbox's `nest` CLI. Arguments must be an object; the server validates them.
- **Session:** `initialize` (protocol `2025-11-25`; `2025-06-18` and `2025-03-26` accepted back), then `notifications/initialized`, then every request carries `Mcp-Session-Id` and `MCP-Protocol-Version`. A 404 to a request with a session means the session ended and nothing was processed: initialize again and resend, once, whatever the tool ([transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). JSON and SSE answers are both read (up to 1 MiB); redirects aren't followed, so the token never goes to another origin.
- **Timeouts:** each forward has 45 s (`MCP_CALL_TIMEOUT_MS`), under the runner's 150 s platform call timeout, so an idempotent retry fits.
- **Fencing:**
  - A request leaves only while the calling brain's epoch is current: the check and the write-ahead row (`mcp_forwards`) are one synchronous step with the request's start, after every await.
  - A call waits until every forward of an older epoch of this agent has settled, so the server never sees two brains' calls interleaved. Within one AgentDO incarnation calls run one at a time, so an unsettled older forward is one an incarnation that died mid-call left behind: it counts as settled once its deadline (sent + timeout) passes, and is then recorded as unknown.
- **Retries:**
  - A repeated call key gets the stored outcome, never a second request (`tool_calls`, then `mcp_forwards`).
  - A call an earlier incarnation forwarded and never heard back from is `outcome_unknown` on redelivery unless the tool is idempotent, in which case it is sent again under the same key.
  - A lost answer (timeout, network, HTTP 5xx, an unparseable body) is `outcome_unknown`, retried once only when the tool is idempotent. At most two forwards per call in all.
- **Errors:** a tool's `isError: true` is a tool error to the model with its text (code `tool_error`). Everything else is a platform error from the existing table: a JSON-RPC error `invalid_message`, HTTP 401 `unauthorized`, 403 `forbidden`, 429 `rate_limited` (retryable), other 4xx and a too-large answer `invalid_message`, no credential stored `forbidden`, a failed `initialize` `internal` (retryable: nothing was sent) or `unsupported_version`.
- **`_meta`** on every `tools/call`: `nest/agent`, `nest/epoch`, `nest/call` (the call key `<agent>/<epoch>/<call>`, the same on a retry) and `nest/taint` (the session's taint as the request leaves).
- **Sinks:** a remote tool is a sink unless the server marks it `readOnlyHint`, as the [sources table](../#sources) says; like every other sink rule, nothing enforces it yet ([taint and sinks](../../tools/#taint-and-sinks)).

## Taint

- **Untrusted by default (owner's decision):** a result from an untrusted server taints the session, as web results do, and so do its tool errors and JSON-RPC error messages (its text either way).
- **Its tool list taints too:** an untrusted server's descriptions and schemas are its text in the model's context ([tool poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks), 2025-04), so a `tools_list` that hands out any of its tools taints the session. In practice an agent with an untrusted mcp capability is tainted from its brain's start, like one with a web built-in.
- **`trusted: true`** (an operator's choice in the catalog): neither its list nor its results taint.

## Data

AgentDO's `mcp_servers` (per capability: URL, session id, negotiated version, cached tool list and when it was fetched) and `mcp_forwards` (per call key: epoch, tool, `forwarded` or `settled`, attempts, deadline, outcome); settled forwards are pruned after 7 days with the call ledger.

## Open questions

- **A shared connector per server:** one session, a shared tool cache and a per-server rate limit or concurrency cap would need a DO per server, with the epoch fence still decided in AgentDO.
- **Sink enforcement** for remote tools (approval from a tainted session) waits for sinks generally.
- **OAuth** for servers that need it (the design's "OAuth or a bearer token"): only a static bearer is built.
- **`list_changed`:** a server's changed tool list reaches a brain only after the cache expires and the brain restarts.

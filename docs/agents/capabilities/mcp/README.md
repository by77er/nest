# MCP capabilities

A capability with an `mcp` source gives an agent a remote MCP server's tools. The control plane is the MCP client: AgentDO hands the server's tools to the brain as `mcp__nest__<capability>_<tool>` and forwards each call through its **MCP proxy** (`control-plane/src/lib/mcp-proxy.ts`, over `lib/mcp.ts`); a **connector** per server (`src/do/mcp-connector.ts`) keeps the shared tool list and admits calls. The server stays plain MCP; what nest adds rides in `_meta`, which a server may ignore ([contract](../../../interfaces/remote-mcp/)).

## Catalog

```yaml
capability: notes
mcp: {url: https://mcp.example.com/mcp, auth: cap:notes, tools: [echo, note_get, note_put], idempotent: {echo: false}, read_only: [echo, note_get], trusted: false, when_tainted: approve, max_concurrent: 8, per_minute: 120}
prompt: The notes server.
```

- **`url`:** `https` only, no credentials or fragment. A loopback host (`127.0.0.1`, `localhost`, `[::1]`, `http` or `https`) only where the Worker has `ALLOW_LOOPBACK_MCP=1` (tests and local dev, as in e2e). Checked when the capability is written and again at each use.
- **`auth`:** the BrokerDO secret holding the bearer token, `cap:<name>`, stored with `PUT /v1/admin/secrets/cap:<name>`. Only AgentDO (for calls) and the server's connector (for listing) read it, both through `mcpToken` (`mcpBearer`: the secret, or the OAuth access token); `cap:` never resolves into a host command. Or the [oauth form](#oauth), `{oauth: cap:<name>, client?: cap:<name>, scopes?: [...]}`.
- **`tools`:** the allowlist. Absent: whatever the server lists (at most 128 per capability).
- **`idempotent`:** the operator's override of the server's annotations: a list of tools that are idempotent, or a map of tool to whether it is. Otherwise a tool is idempotent when the server marks it `readOnlyHint` or `idempotentHint` ([annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)), else not.
- **`read_only`:** the tools that aren't [sinks](#sinks), as a list or a map like `idempotent`.
- **`trusted`** (default `false`): see [taint](#taint).
- **`when_tainted`** (`approve`, the default, or `allow`): what a sink call from a tainted session needs.
- **`max_concurrent`** (1–64, default 8) and **`per_minute`** (1–6,000, default 120): the server's admission ([calls](#calls)), across every agent. The defaults are a guess: GitHub's MCP server, for one, sits under a per-token REST limit of 5,000 an hour ([GitHub](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- **Names:** a capability's name has no `_`, so `<capability>_<tool>` splits back unambiguously. A capability whose name a platform tool starts with (`agent_…`, `channel_…`) is refused; a later platform tool with a clashing name wins, and the remote one is left out of the list. A remote tool name is letters, digits, `_` and `-`, and `mcp__nest__<capability>_<tool>` at most 64 characters (the Messages API's tool name limit; unverified for Claude Code's MCP names, so conservative); others aren't listed.
- **Spawn:** the expanded spec copies each mcp capability's source (`AgentSpec.mcp`), like everything else in it: editing the capability changes later spawns only. `overrides.tools` narrows remote tools too, by their `<capability>_<tool>` names: a given list keeps only the remote tools it names (and drops a capability it names none of), and never widens an allowlist.

## The connector

**Decided (2026-10-31), revising the proxy-only decision of the same day:** a Durable Object per server, `McpConnectorDO`, keyed by the server's URL and the credential's name (`connectorName`: `["mcp", url, auth]`), owns what is genuinely per server: the tool list, noticing it change, and admission. **AgentDO still forwards every call** and keeps every per-agent guarantee (the epoch fence, the write-ahead `mcp_forwards` row, call-key dedup, retries, taint, sinks) exactly as before.

- **Why not forward through the connector:** a forward's guarantees are exact only where the agent's epoch and call ledger live. AgentDO checks the epoch in the same synchronous step as the request leaves; a connector that forwarded would need the epoch pushed to it (a window) or a callback into the AgentDO awaiting it (the cross-DO pattern the repo avoids). So the connector only grants a lease and serves the list; it never sees a call's arguments.
- **Keyed by credential too:** a server may list different tools for different tokens (scopes), and its own rate limits are usually per token. Two capabilities naming the same URL and `auth` share one connector; each call is admitted by its own grant's caps.
- **The MCP session stays per agent** (one per AgentDO and capability, as before); the connector opens a session of its own, for listing only, with the same bearer (`mcpToken`), renewed once after a 401 like a call's. A session is "logically related interactions", and a server **MAY** keep state per session and end it at any time ([session management](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management)). Shared, one agent's calls could change what another's session sees, a 404 would end every agent's session at once, and the session id (a capability to act in it) would have to leave AgentDO. Per agent, a session's state is one agent's, and a server sees one agent per session.
- **Assumed:** a server's tool list depends on the credential, not the session. A server that lists per session (tools unlocked by an earlier call in it) gets the connector's view; such a server would need per-agent listing ([open question](#open-questions)).
- **Cost:** a new class (a one-way deploy, [dev/deploy.md](../../../../dev/deploy.md)); two connector round trips per call (acquire, and a release after the answer, not awaited); one `tools/list` per server instead of per agent.

## Listing

- **`tools_list`** answers with the platform tools and each capability's allowed tools, with the server's description (clipped to 2,000 characters) and `inputSchema`.
- **Cache:** the connector keeps the server's list and serves it to every agent for 5 minutes; an older one, or one reported changed, is fetched again, and if that fails the old list is served. AgentDO keeps a copy (`mcp_servers.tools`), which a call reads for its tool's annotations, and serves it at any age when the connector can't answer. A server that can't be listed contributes nothing to this list (the brain keeps the rest). Listing, `initialize` included, has 4 s (`MCP_LIST_TIMEOUT_MS`); the runner waits 10 s for a list.

## list_changed

A server's changed list reaches a live brain without a restart:
1. **The connector learns of it** from `notifications/tools/list_changed` on any SSE stream it or an AgentDO reads (a server **MAY** send notifications on a request's stream before its response: [transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#sending-messages-to-the-server); AgentDO reports one to the connector), and otherwise by listing again every 60 s (`MCP_RELIST_MS`) while any brain uses the list. **No GET stream:** a DO holding one open would be billed for its whole wall time, and the spec lets the server send the notification on a POST stream instead. A server that sends it only on a GET stream is seen within the interval.
2. **The connector tells each subscribed AgentDO** (an agent subscribes when its brain lists), from its alarm only, never while an AgentDO is mid-call into it. Only a list whose digest (SHA-256 of its canonical JSON) differs owes a notice, and only to agents not already handed it. AgentDO answers whether it still wants notices (it has a brain and the server is in its spec); an agent quiet for 6 h is asked, and one unreachable for 24 h is dropped (its next list subscribes it again).
3. **AgentDO sends `tools_changed`** on the session channel to a runner whose hello says `tools_changed: true` ([session](../../../interfaces/control-host/session/)); an older runner is sent nothing and lists again at its next start. A runner disconnected meanwhile is told at its next hello, and a change that lands while a list is being made is told again after it.
4. **The runner** has every `nest mcp` connection of that agent send Claude Code `notifications/tools/list_changed` (`nest mcp` already declares `listChanged: true`), and **Claude Code lists again**. Its docs say that under `-p` (how the runner runs it) a `list_changed` refreshes the tool list ([Dynamic tool updates](https://code.claude.com/docs/en/mcp)), and **2.1.316 does** (`claude-verify` item 13, 2026-11-01, [evidence](../../../../e2e/claude-verify/observed/2.1.316-list-changed.json)): from a stdio server under `-p` stream-json it sends `tools/list` within 10 ms of the notification, the next turn's `system/init` names the new tool, and the model calls it; one arriving mid-turn (after a call's answer) is listed before the model's next request, which can call the new tool in the same turn. No brain restart is needed.

**End to end in production (2026-11-01, `dev/cloud-checks/list_changed_check.py`, two Haiku agents on `use1`):** a tool added on the server reached both live brains (same epoch, no restart), which called it, when asked 75 s after a call had carried the notice; asked in the same turn as that call, seconds later, neither had it yet. So the chain (the notice to AgentDO, the connector's alarm and re-list, `tools_changed`, the runner, Claude Code's re-list) takes seconds to a minute, not one model step. The exact latency isn't measured.

## Calls

- **Authority:** only a capability in the agent's spec, and only a tool on its allowlist (`forbidden` otherwise; `unknown_tool` for a capability it doesn't have). Not reachable from a sandbox's `nest` CLI. Arguments must be an object; the server validates them.
- **Session:** `initialize` (protocol `2025-11-25`; `2025-06-18` and `2025-03-26` accepted back), then `notifications/initialized`, then every request carries `Mcp-Session-Id` and `MCP-Protocol-Version`. A 404 to a request with a session means the session ended and nothing was processed: initialize again and resend, once, whatever the tool ([transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)). JSON and SSE answers are both read (up to 1 MiB); redirects aren't followed, so the token never goes to another origin.
- **Timeouts:** each forward has 45 s (`MCP_CALL_TIMEOUT_MS`), under the runner's 150 s platform call timeout, so admission and an idempotent retry fit.
- **Admission:** after the fence wait and before the session and epoch check, a call takes a lease on one of the server's slots from its connector: at most `max_concurrent` leases held and `per_minute` granted in the last minute, across every agent. It asks again (at least every 250 ms) for up to 10 s (`MCP_ADMIT_WAIT_MS`), then is `rate_limited` (retryable) with nothing sent; a connector that doesn't answer is `internal` (retryable), nothing sent. The lease covers the whole call (its retry and a re-initialize included) and is released after the answer; one an incarnation that died mid-call never released expires after 4 call timeouts. Not fair: a waiting call may lose a freed slot to a newer one.
- **Fencing:**
  - A request leaves only while the calling brain's epoch is current: the check and the write-ahead row (`mcp_forwards`) are one synchronous step with the request's start, after every await (admission's included).
  - A call waits until every forward of an older epoch of this agent has settled, so the server never sees two brains' calls interleaved. Within one AgentDO incarnation calls run one at a time, so an unsettled older forward is one an incarnation that died mid-call left behind: it counts as settled once its deadline (sent + timeout) passes, and is then recorded as unknown.
- **Retries:**
  - A repeated call key gets the stored outcome, never a second request (`tool_calls`, then `mcp_forwards`).
  - A call an earlier incarnation forwarded and never heard back from is `outcome_unknown` on redelivery unless the tool is idempotent, in which case it is sent again under the same key.
  - A lost answer (timeout, network, HTTP 5xx, an unparseable body) is `outcome_unknown`, retried once only when the tool is idempotent. At most two forwards per call in all.
- **Errors:** a tool's `isError: true` is a tool error to the model with its text (code `tool_error`). Everything else is a platform error from the existing table: a JSON-RPC error `invalid_message`, HTTP 401 `unauthorized`, 403 `forbidden`, 429 `rate_limited` (retryable), other 4xx and a too-large answer `invalid_message`, no credential stored `forbidden`, a failed `initialize` `internal` (retryable: nothing was sent) or `unsupported_version`.
- **`_meta`** on every `tools/call`: `nest/agent`, `nest/epoch`, `nest/call` (the call key `<agent>/<epoch>/<call>`, the same on a retry) and `nest/taint` (the session's taint as the request leaves).

## Sinks

The gate below is the one every sink uses (`lib/sinks.ts`; brokered actions and `egress_policy` go through it too: [taint and sinks](../../tools/#taint-and-sinks)).

- **A remote tool is a sink unless it's read-only:** the operator's `read_only` mark, else, for a `trusted` server only, its `readOnlyHint`. An untrusted server's annotations don't count: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers" ([tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)). A read-only call still carries its arguments to the server; marking a tool `read_only` accepts that.
- **A sink call from a tainted session isn't sent** under `when_tainted: approve`: the call answers `pending` with an ask id, and the operator is asked on the agent's escalation route with the tool, the server's host and the arguments (the first 2,000 characters). The same tool with the same arguments asked again before a decision gets the same ask.
- **The decision is a turn.** An answer whose first word is `approve(d)`, `allow(ed)`, `yes`, `y`, `ok` or `okay` approves; anything else denies, and the agent is told the answer. An approval lets through **one** call of that tool with exactly those arguments (SHA-256 of their canonical JSON, keys sorted) within an hour; the model calls again. A redelivery of the call it was spent on uses it again; nothing else does.
- **Always:** a call from an untainted session, `when_tainted: allow`, a read-only tool, and a call key already forwarded (its redelivery) aren't gated.
- **Who approves:** only the operator (`POST /v1/agents/:agent/asks/:ask/answer`, admin); no agent can answer an ask.
- **Why async, not held:** an approval inside the call would have to fit the operator's answer and the forward under the runner's 150 s call timeout, and a late answer would have to run the call outside its brain's epoch fence. Asking again keeps every forward on a current brain's call.

## Taint

- **Untrusted by default (owner's decision):** a result from an untrusted server taints the session, as web results do, and so do its tool errors and JSON-RPC error messages (its text either way).
- **Its tool list taints too:** an untrusted server's descriptions and schemas are its text in the model's context ([tool poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks), 2025-04), so a `tools_list` that hands out any of its tools taints the session. In practice an agent with an untrusted mcp capability is tainted from its brain's start, like one with a web built-in.
- **`trusted: true`** (an operator's choice in the catalog): neither its list nor its results taint.

## OAuth

For a server that follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) (2025-11-25). Code: `control-plane/src/lib/mcp-auth.ts`; the tokens live in BrokerDO.

```yaml
mcp: {url: https://mcp.example.com/mcp, auth: {oauth: cap:notes, client: cap:notes-client, scopes: [notes.read]}}
```

- **`oauth`** (required) names the BrokerDO record that holds this capability's tokens; nest writes it, the operator doesn't. It is not in BrokerDO's `secrets`, so a previous release, reading `auth` as a static secret, finds nothing and sends nothing.
- **`client`** (optional) names a BrokerDO secret holding a pre-registered client, `{"client_id", "client_secret"?, "token_endpoint_auth_method"?}`. It must differ from `oauth`.
- **`scopes`** (optional) is what to ask for. Without it, nest asks for the 401 challenge's `scope`, then the resource metadata's `scopes_supported`, then nothing, as the spec's scope selection says. The start route's `{"scopes": [...]}` overrides both, for a step-up.
- **Authorizing (the operator, once):**
  1. `POST /v1/admin/capabilities/<name>/oauth` discovers the server and answers `{authorize_url, expires_ms, client, resource, issuer, scopes}`.
  2. The operator opens `authorize_url` and approves.
  3. The authorization server redirects the browser to `<PUBLIC_BASE_URL>/v1/oauth/callback`, which exchanges the code and answers a page that holds no token.
  4. `GET /v1/admin/capabilities/<name>/oauth` shows the state (`authorized` or `reauthorize`, expiry, scope, issuer, client kind), never a token.
- **Discovery:**
  - An unauthenticated `initialize` reads the 401's `WWW-Authenticate` `resource_metadata` and `scope`; without them nest tries the path-inserted well-known URL, then the root one ([RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) §3.1, §5.1).
  - The metadata's `resource` must be the server URL or a path prefix of it on the same origin, else nest refuses. RFC 9728 §3.3 requires identity with the URL it was derived from, and a prefix is what the root fallback produces.
  - Of `authorization_servers`, the first is used (§7.6 leaves the choice to the client). Its metadata comes from the spec's order of RFC 8414 and OIDC URLs; its `issuer` must match ([RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) §3.3); without `S256` in `code_challenge_methods_supported`, nest refuses to proceed, as the spec requires.
  - Every URL is `https` (loopback `http` only with `ALLOW_LOOPBACK_MCP=1`); redirects aren't followed; each exchange has 10 s and 64 KiB.
- **Client identity, in the spec's order:**
  1. The pre-registered `client`. It authenticates with `client_secret_basic`, or with `client_secret_post` when the server lists only that.
  2. **nest's client ID metadata document**, when the server advertises `client_id_metadata_document_supported` and `PUBLIC_BASE_URL` is https. The Worker serves it at `/v1/oauth/client.json`, and that URL is the client id: a public client (`none`), with the callback as its only redirect URI ([draft-ietf-oauth-client-id-metadata-document-00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)).
  3. [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) registration as a public client, once per authorization server, kept in BrokerDO.
  4. Otherwise the start fails and says to register a client by hand.

  **Why all three:** the spec makes metadata documents the SHOULD for clients with no prior relationship and registration a MAY "for backwards compatibility". Servers built against the 2025-06-18 spec offer only registration (unverified how many still do), so leaving it out would lock them out.
- **The flow:**
  - PKCE S256 with a 32-byte verifier ([RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636)), kept in BrokerDO's flow row and never in the URL.
  - `resource` (the metadata's `resource`) in the authorization request and in every token request ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)), and `state` (32 random bytes).
  - When the server advertises `authorization_response_iss_parameter_supported`, the response's `iss` must match ([RFC 9207](https://datatracker.ietf.org/doc/html/rfc9207)), and a mismatched `iss` is always refused.
  - Only `Bearer` tokens are accepted.
- **The callback needs no admin token (decided).** A browser can't carry one, so the state is the proof. It is single use (deleted as it's read), lasts 10 minutes, and names a flow only the operator's admin call could start. A stolen code is useless without the verifier, which never leaves BrokerDO.
  - `nest.bitcru.sh` has no Cloudflare Access application (Access fronts only the gateways, the dashboard and previews: `deploy/lean/Edge/Stack.lean`), so the callback and the metadata document are reachable. If Access ever fronts the Worker, both paths need a bypass policy: the authorization server fetches the document, and the browser lands on the callback.
  - Cloudflare logs request URLs, and the callback's query carries the code and state. Both are spent by then. The page sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
  - Whoever completes the authorize URL binds their account to the capability, so the URL is the operator's alone.
- **Use (`mcpBearer`, the proxy's one call for a bearer):**
  - An access token with more than 60 s left is sent as is; an older one is refreshed first.
  - A 401 means the request wasn't processed, so the proxy renews the bearer and sends it again, once per request. A tools/call is sent again only after the epoch check and the write-ahead row, as for any forward. A server that refuses the refreshed token too costs one refresh per call, never a loop.
  - **One refresh at a time per record:** BrokerDO is a single instance, so concurrent callers share the refresh in flight, and a rotated refresh token ([OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) §4.3.1, required for public clients) is spent once. A rotated refresh token replaces the spent one; otherwise the old one stays.
  - An authorization the operator completes during a refresh wins over it.
  - **A refused refresh** (any 400 or 401 from the token endpoint, such as `invalid_grant`) marks the record `reauthorize` and clears its tokens. Every call then fails at once with `unauthorized` (not retryable), naming `POST /v1/admin/capabilities/<name>/oauth`, and asks neither the authorization server nor the MCP server. A refresh with no answer (timeout, 5xx) is `internal` (retryable) and changes nothing.
  - A 403 `insufficient_scope` is `forbidden`, naming the scopes the challenge asks for.
  - **Bound to the server:** the record keeps the URL it was authorized for, and a grant naming another URL gets no token. The spec says clients "MUST NOT send tokens to the MCP server other than ones issued by the MCP server's authorization server".
  - The access token reaches AgentDO's memory for the request only. The refresh token, the verifier and any client secret never leave BrokerDO.
- **Audit:** BrokerDO writes `oauth_start`, `oauth_registered`, `oauth_authorized`, `oauth_callback_refused`, `oauth_refreshed`, `oauth_refresh_failed` and `oauth_token_refused` to R2 under `audit/broker/<day>/`. Each record holds the capability, record, resource, issuer, client id, scope, expiry, caller and reason, never a token, code, verifier or state ([issuance audit](../../../control-plane/durable-objects/broker/#issuance-audit)).
- **Not built:**
  - token revocation at the authorization server ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)) and deleting a record;
  - telling the operator unprompted when a record needs re-authorizing (the agent's error and the status route say so);
  - `private_key_jwt`;
  - choosing among several `authorization_servers`;
  - OIDC-only metadata without `code_challenge_methods_supported` (refused, as the spec says).

  A rotated refresh token lost to a BrokerDO crash between the authorization server's answer and the write needs re-authorizing.

## Data

BrokerDO's `oauth_grants` (per token record: server URL, resource, issuer, token endpoint, client, scope, tokens and expiry, `authorized` or `reauthorize`), `oauth_flows` (per state: a started authorization, 10 minutes) and `oauth_clients` (registrations, per authorization server and redirect URI). AgentDO's `mcp_servers` (per capability: URL, session id, negotiated version, its copy of the tool list and when the connector fetched it), `mcp_forwards` (per call key: epoch, tool, `forwarded` or `settled`, attempts, deadline, outcome) and `approvals` (per ask: the sink's name, the arguments digest, `pending`, `approved` or `denied`, expiry, the call key it was spent on, and `tool`, the model-facing tool to call again, null in rows written before it was kept: a remote tool's); settled forwards and decided approvals are pruned after 7 days with the call ledger. AgentDO's `kv` also has `mcp_changed_ms` (the last notice) and `tools_listed` (when its brain last listed, by epoch). The connector's `kv` (the grant it lists with, its session, the list, its digest and when it was fetched, a stale flag), `subscribers` (per agent: last heard from, the digest it was last handed or told of, when to retry), `leases` (until they expire) and `admits` (the last minute); see [McpConnectorDO](../../../control-plane/durable-objects/mcp-connector/).

## Open questions

- **Resolved: Claude Code lists again on `list_changed` and the model sees the new tool in the same session.** Observed on 2.1.316 by `claude-verify` item 13 (haiku, 2026-11-01; [evidence](../../../../e2e/claude-verify/observed/2.1.316-list-changed.json)): `mcp_logger.py --grow-after-call late_echo` answered the first `tools/call`, added `late_echo` and sent `notifications/tools/list_changed`; Claude Code sent a second `tools/list` 10 ms later (+1.84 s, before the second turn at +6.94 s), the second turn's `system/init` listed `mcp__nest__late_echo`, and the model called it. Mid-turn the same: re-listed 10 ms after the notification and called `late_echo` in the same turn. Re-check on each pinned version (the probe runs with `claude-verify`).
- **Per-session tool lists:** the connector's one list assumes a server lists by credential, not by session. A server that unlocks tools per session would need per-agent listing (a capability flag), not built.
- **Fair admission:** waiting calls poll; there is no queue, so a busy server's slot can go to a newer call first.
- **OAuth step-up by agents:** a 403 `insufficient_scope` needs the operator to authorize again with more scopes; an agent can't ask for that itself, and nothing notifies the operator unprompted.

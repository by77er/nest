# API and surfaces

- **Worker HTTP API,** authenticated by [operator tokens](#operator-tokens), or by an [API client](clients/)'s token: an external system's scoped principal, which sees and acts only on what it created, within the operator's grant. The read-only [dashboard](../dashboard/) is a Worker of its own behind Cloudflare Access.
- **External events** (webhooks, email) are external integrations, not platform routes ([principle 9](../../README.md#principles)): one delivers to an agent through its inbox. Agents schedule their own wakes with `wake_at`.
- **Approvals:** a call the sink gate or a tool rule in `ask` mode holds is listed by `GET /v1/agents/<id>/asks` (`{ask, question, created_ms, approval?: {name, tool}}`, oldest first) and answered by `POST /v1/agents/<id>/asks/<ask>/answer {answer}`; the decision reaches the agent as an `ask_answer` turn. The **[Discord bot](discord/)** is designed on top of these; agent events delivered to owners (webhooks) are kernel but not built.
- **`nest` CLI on my machine:** `login` (the Access service token, and a binding per sandbox from SandboxDO's `resolve`), `attach` (a terminal: a WebSocket to the sandbox host's [gateway](../../sandbox/gateway/), then vsock), `logs -f`, `port-forward` (TCP over the same path), `diff <a> <b>`. The CLI reaches a sandbox the way a brain does, by hostname and binding. Not built: these commands (the CLI has only `hook`, `mcp` and the in-sandbox commands).
- **Host authentication:**
  - A signed instance identity document (or a one-time enrollment token) is exchanged for a rotating host token. See [../../compute/provisioning/](../../compute/provisioning/).
  - The fleet channel accepts a token up to 24 h past expiry, so a reconnecting host can get a fresh one. The session channel accepts no grace period.
- **Two public routes for MCP OAuth** ([mcp OAuth](../../agents/capabilities/mcp/#oauth)): `GET /v1/oauth/callback`, where an authorization server sends the operator's browser (its single-use state is the proof), and `GET /v1/oauth/client.json`, nest's client ID metadata document. Every other non-host route needs the operator's token (`test/routes.test.ts` holds the list).
- **Operator API:** endpoints are listed in `control-plane/README.md`.
  - **Includes:** egress policy layers (`PUT /v1/sandboxes/<id>/policy`), ports and public share links (operator-only), paged transcripts, a sandbox's hands target for a person or a harness (`POST /v1/sandboxes/<id>/resolve`), starting a brain on a named host (`POST /v1/agents/<id>/start {host}`), and the Access service token for the gateways (`PUT /v1/admin/secrets/access:gateway`).
  - **Cells:** must be well-formed names, and must be in `CELLS` when that's set.
  - **Agents:** `POST /v1/agents` takes an agent's cell from its sandbox when it has one; a cell that differs from the sandbox's is refused (409).
  - **Compat (one release):** `POST /v1/sandboxes` and `POST /v1/agents` accept a `workstream` field and ignore it (old clients and scripts send it).

## Operator tokens

The operator API takes scoped bearer tokens. Built: one `ADMIN_TOKEN` with every scope; the scopes, hashing and the revocation counter below aren't built.

| Scope | Allows |
|---|---|
| `observe` | Reading state, logs, transcripts and effective policy |
| `approve` | `observe`, plus answering questions and approvals, and temporary egress grants |
| `admin` | Everything else: policy layers, secrets, enrollment tokens, share links, terminals and port-forwards, confirm-dead, launch records |

- **Format:** a recognisable prefix per scope (`nest_obs_`, `nest_apr_`, `nest_adm_`) plus 256 random bits, so a leaked token is easy to spot in logs and for secret scanners.
- **Stored only as SHA-256 hashes** (a Worker secret) and compared in constant time. A fast hash is enough because the tokens are random, not passwords. Revoking one removes its hash.
- **Header only:** `Authorization: Bearer`, never a URL or query string, because Cloudflare logs request URLs ([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)). The CLI sends the header on WebSocket upgrades too.

## Revocation counter

**One counter, `REVOCATION_COUNTER` (a Worker secret), is signed into every share link, terminal session and host token.** Anything minted under an older value is refused. Bumping it is the panic button:
- `wrangler secret put` deploys a new version at once ([secrets](https://developers.cloudflare.com/workers/configuration/secrets/)), which restarts every DO and drops every socket ([upgrades](../#upgrades)), so open terminals and host channels close and can't come back.
- An instance enrolls only once, so its host can't get a new token: leases expire and sandboxes restore on fresh hosts ([FleetDO](../durable-objects/fleet/)).
- It takes my Cloudflare credentials, not an operator token, so it works even when an `admin` token has leaked.

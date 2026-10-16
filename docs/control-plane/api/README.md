# API and surfaces

- **Worker HTTP API and a static dashboard,** with my access gated by Cloudflare Access.
- **External events:** webhooks at `POST /v1/hooks/<hk_…>` and Email Routing to an Email Worker, both turned into channel posts (see [sources](../../channels/sources/)). Agents schedule their own wakes with `wake_at`.
- **Live views:** live tails and agents' waiting `read`s follow channels (ChannelDO), including each agent's and sandbox's `events`.
- **Approvals and escalations** go through the **[Discord bot](discord/)**, and can also be answered in the dashboard.
- **`nest` CLI on my machine:** `attach` (a terminal over WebSocket → nestd → vsock), `logs -f`, `port-forward` (TCP over WebSocket), `diff <a> <b>`.
- **Host authentication:**
  - A signed instance identity document (or a one-time enrollment token) is exchanged for a rotating host token. See [../../compute/provisioning/](../../compute/provisioning/).
  - The fleet channel accepts a token up to 24 h past expiry, so a reconnecting host can get a fresh one. The session channel accepts no grace period.
- **Operator API:** endpoints are listed in `control-plane/README.md`.
  - **Includes:** egress policy layers (`PUT /v1/sandboxes/<id>/policy`), ports and public share links (operator-only), and paged transcripts.
  - **Cells:** must be well-formed names, and must be in `CELLS` when that's set.

## Operator tokens

The operator API takes scoped bearer tokens; Cloudflare Access fronts the dashboard once there's a domain. Built: one `ADMIN_TOKEN` with every scope.

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

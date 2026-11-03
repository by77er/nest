# API and surfaces

- **Worker HTTP API,** authenticated by [operator tokens](#operator-tokens), or by an [API client](clients/)'s token: an external system's scoped principal, which sees and acts only on what it created, within the operator's grant. The read-only [dashboard](../dashboard/) is a Worker of its own behind Cloudflare Access.
- **External events** (webhooks, email) are external integrations, not platform routes ([principle 9](../../README.md#principles)): one delivers to an agent through its inbox. Agents schedule their own wakes with `wake_at`.
- **Approvals:** a call the sink gate or a tool rule in `ask` mode holds is listed by `GET /v1/agents/<id>/asks` (`{ask, question, created_ms, approval?: {name, tool}}`, oldest first) and answered by `POST /v1/agents/<id>/asks/<ask>/answer {answer}`; the decision reaches the agent as an `ask_answer` turn. An API client answers its own subtree's. The **[Discord bot](discord/)** is designed on top of these. Agent events reach an API client's webhook ([events to the owner](clients/#events-to-the-owner)); the operator has no webhook yet.
- **`nest` CLI on my machine:** `login` (the Access service token, and a binding per sandbox from SandboxDO's `resolve`), `attach` (a terminal: a WebSocket to the sandbox host's [gateway](../../sandbox/gateway/), then vsock), `logs -f`, `port-forward` (TCP over the same path), `diff <a> <b>`. The CLI reaches a sandbox the way a brain does, by hostname and binding. Not built: these commands (the CLI has only `hook`, `mcp` and the in-sandbox commands).
- **Host authentication:**
  - A signed instance identity document (or a one-time enrollment token) is exchanged for a rotating host token. See [../../compute/provisioning/](../../compute/provisioning/).
  - The fleet channel accepts a token up to 24 h past expiry, so a reconnecting host can get a fresh one. The session channel accepts no grace period.
- **Two public routes for MCP OAuth** ([mcp OAuth](../../agents/capabilities/mcp/#oauth)): `GET /v1/oauth/callback`, where an authorization server sends the operator's browser (its single-use state is the proof), and `GET /v1/oauth/client.json`, nest's client ID metadata document. Every other non-host route needs the operator's token, and the owner routes (agents, sandboxes, the client catalog) take an API client's too (`test/routes.test.ts` holds both lists).
- **Operator API:** endpoints are listed in `control-plane/README.md`.
  - **Includes:** egress policy layers (`PUT /v1/sandboxes/<id>/policy`), ports and public share links (operator-only), paged transcripts, a sandbox's hands target for a person or a harness (`POST /v1/sandboxes/<id>/resolve`), starting a brain on a named host (`POST /v1/agents/<id>/start {host}`), and the Access service token for the gateways (`PUT /v1/admin/secrets/access:gateway`).
  - **Cells:** must be well-formed names, and must be in `CELLS` when that's set. See [which routes take a cell](#which-routes-take-a-cell).
  - **Agents:** `POST /v1/agents` takes an agent's cell from its sandbox when it has one; a cell that differs from the sandbox's is refused (409).
  - **Creates take an [`Idempotency-Key`](#idempotency-keys).**
  - **Compat (one release):** `POST /v1/sandboxes` and `POST /v1/agents` accept a `workstream` field and ignore it (old clients and scripts send it).

## Live trace

**Decided (2026-11-02):** `GET /v1/agents/<id>/trace?after=<seq>` is a WebSocket upgrade that streams an agent's turns as they happen. It's an owner route: the operator, or an [API client](clients/) for an agent in its subtree (anything else answers 404, as an unknown agent does). The Worker checks the caller before it forwards the upgrade. A browser can't set `Authorization` on a WebSocket, so an app's own Worker connects with its token and proxies the socket. Code: `control-plane/src/lib/trace.ts`, and the trace sockets in [AgentDO](../durable-objects/agent/#live-trace).
- **Why a WebSocket, not SSE:** AgentDO accepts the socket with the [hibernation API](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), so an idle watched agent costs no duration between events ("Billable Duration (GB-s) charges do not accrue during hibernation"). An SSE stream would keep the request, and the object, alive and billed.
- **Messages** are JSON text frames. An event has `seq` (per agent, from 1, monotonic, durable), `ts_ms`, `turn` (within a turn), `type` and its fields:

  | `type` | Fields | From |
  |---|---|---|
  | `turn_started` | `input_kind` (`user`, `inbox`, `ask_answer`, `recovery`) | the runner |
  | `assistant_text` | `text` | the runner (Claude Code's text blocks) |
  | `tool_call` | `call_id`, `name`, `input` (the input as compact JSON, redacted, bounded) | the runner (each `tool_use` block) |
  | `tool_result` | `call_id`, `is_error`, `summary?` (the result's first 200 characters, redacted) | the runner |
  | `turn_completed` | `stop_reason`, `usage?` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`) | the runner |
  | `rate_limited` | `retry_after_ms?`, `detail` | the runner |
  | `error` | `code`, `message` | the runner (a failed Claude Code result) |
  | `task_exited` | `task_id`, `status`, `exit_code?` | the runner (a background hands task) |
  | `timer_set`, `timer_fired`, `timer_cancelled` | `name`, and `at_ms` and `note`, `note`, or `by` | AgentDO ([timers](../../agents/capabilities/timers/)) |
  | `state` | `state` (as `GET /v1/agents/<id>` shows it) | AgentDO, at each change |
  | `ask` | `ask`, `question` | AgentDO (an approval or a tool rule in `ask` mode) |
  | `ask_answered` | `ask` | AgentDO |
  | `ended` | `reason` | AgentDO, once the agent's end is done; the socket then closes (1000) |

  Three messages have no `seq`: `{type: "gap", from, to}` (below); `{type: "live"}`, once the backlog is sent (what follows happens as the client watches, so a viewer can animate only that); and `ended` sent again to a client that connects after the end having already read it. A client ignores a `type` it doesn't know.
- **Order:** the order AgentDO recorded them, one seq each. A runner event comes before the state change it causes (`turn_completed`, then `state: idle`). A `state: working` comes when the turn is sent to the brain, before its `turn_started`.
- **Not streamed:** the runner's `state_changed` (it streams as `state`), `escalation` (it streams as its `ask`), `usage`, `capabilities` and `inbox_delivered`, and everything that isn't an event (session bytes, hands calls' output). The full transcript is `GET /v1/agents/<id>/transcript`.
- **Resume:** AgentDO keeps the newest 1,000 events of the last 24 h. A client connects with `after` (the last `seq` it has; omitted means 0) and gets the events after it, then `live`, then live events. If events after `after` are gone from the ring, it first gets `{type: "gap", from, to}` (inclusive seqs) and can page the transcript for them. An `after` beyond the newest gets nothing until new events.
- **Bounds and redaction:** the live path has no list of secrets (the runner redacts its own secret, the setup token, from session bytes only, and the model never sees it). Every string field is redacted, then cut: tool inputs, results, questions and messages to 4 KiB, assistant text to 16 KiB (UTF-8, marked `…` when cut). Redaction replaces the values of credential-named keys in a tool's input (`token`, `secret`, `password`, `authorization`, `api_key`, `credential`, `cookie`, `private_key`, …) and credential shapes in any string (nest client tokens and webhook secrets, `sk-ant-…`, GitHub and Slack tokens, AWS access key ids, PEM private keys, `Bearer`/`Basic` values) with `[redacted]`. A secret of another shape in a tool's input passes, bounded, as it does in the stored transcript.
- **Keepalive:** send the text `ping` (not JSON) at least every 30 s; the runtime answers `pong` without waking AgentDO ([`setWebSocketAutoResponse`](https://developers.cloudflare.com/durable-objects/api/state/)). AgentDO never pings.
- **Closes:** `1000` when the agent ended; `4008` when a newer trace socket took its place (8 per agent at most, the oldest goes); `1011` when a send to it failed. A client reconnects with `after=<last seq>` and a backoff, except after `ended`.
- **Answers to the upgrade:** `101`; `426` without `Upgrade: websocket`; `400` for an `after` that isn't a non-negative integer; `401`/`404` as for any owner route; `503` (`internal`, `retryable: true`) while AgentDO still runs a release without the trace, in the minutes after a deploy ([rollout](../../../dev/deploy.md)).

## Which routes take a cell

**Decided (2026-11-02):** only a route about one cell's FleetDO reads `?cell=`. It is checked when that route reads it (default `local`), never by the router for every route (`Ctx.cell` in `control-plane/src/index.ts`), so in a deployment whose `CELLS` doesn't name `local` an external app needs no cell on the others.
- **About a cell** (`?cell=`): the fleet, hosts, images, lifetimes, tunnels, GC and the root certificate (`/v1/admin/…`), and the operator's `GET /v1/agents` and `GET /v1/sandboxes` without `?client=` (FleetDO's registry). A client's listing, and the operator's with `?client=`, take `?cell=` only as a filter.
- **In the body:** `POST /v1/agents` and `POST /v1/sandboxes` take `cell` (an agent with a sandbox takes the sandbox's).
- **No cell:** everything reached by an agent's or sandbox's id (its DO's record knows its cell), the catalog (one CatalogDO for every cell), clients and `/v1/clients/self/…`, and secrets (one BrokerDO). These accept a `?cell=` and ignore it, so callers that send one keep working.

## Idempotency keys

**Decided (2026-11-02):** `POST /v1/agents` and `POST /v1/sandboxes` take an `Idempotency-Key` header, so a create whose answer was lost can be sent again without making a second agent or sandbox. Any caller: the operator or an API client (an agent's `agent_spawn` doesn't come here: its ids already derive from its call key). Code: `control-plane/src/lib/idempotency.ts`, `createOnce` in `src/index.ts`.
- **The key:** 1-128 characters of letters, digits and `_ . : ~ + / = -` (a UUID, a ULID, base64url); another is 400. Without one, each create is its own, as before.
- **Scope:** per principal. A client's keys are in its own [ClientDO](../durable-objects/client/), the operator's in ClientDO's `operator` instance, so one principal's key never meets another's. One key binds one request: the route and its parsed body (defaults applied, keys sorted, SHA-256).
- **Retention:** 24 h from its first use (`IDEMPOTENCY_TTL_MS`), then the key is free again. Stripe keeps keys the same 24 h ([idempotent requests](https://docs.stripe.com/api/idempotent_requests)). Expired keys are deleted at the next claim, and in a client's hourly prune.
- **Answers:**
  - The same key and body again: the same object, with the first answer's status (an unplaced sandbox's 202 stays 202), its current view, and `Idempotent-Replayed: true`. An agent isn't started again: `started` is `null`.
  - The same key with another body or route: 409 `conflict`, not retryable; nothing is made.
  - The same key while its first request is still being handled (for up to 60 s, `IDEMPOTENCY_LEASE_MS`): 409 `conflict`, retryable.
- **How a second object is never made:** the id is fixed when the key is first claimed, in one synchronous step of the principal's ClientDO, and every step of a create is idempotent by id (`ClientDO.admit`, `SandboxDO.create`, `AgentDO.create`). A request that died mid-create leaves its claim, which the next request with the key takes over once the lease has passed, under the same id: it finds what was made and finishes it. A request that failed before it made anything (a 400, a 403 outside the grant) frees a fresh key; one that failed later leaves the key bound, and the next request with it takes over at once.
- **The validation runs inside the claim:** a replay answers even if the template or grant changed since.

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

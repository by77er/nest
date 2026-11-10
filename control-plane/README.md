# nest control plane

Cloudflare Worker plus Durable Objects that implement [docs/control-plane/](../docs/control-plane/) and
the [control-host contract](../docs/interfaces/control-host/). Wire types are in `src/protocol/` (zod,
mirroring `crates/nest-protocol`). Every fixture in `protocol/fixtures/control/` must round-trip.

| Path | What |
|---|---|
| `src/index.ts` | Worker: enrollment, WebSocket routing (host-token auth), signed blob URLs, admin API |
| `src/do/fleet.ts` | **FleetDO** (one per cell): enrollment, fleet channel, leases, expiry, STONITH, placement, commands |
| `src/do/sandbox.ts` | **SandboxDO**: epoch, commit compare-and-set, generations, layered policy and expiring grants, idle refcount, ports |
| `src/do/agent.ts` | **AgentDO**: session channel, segments to R2 (acked after the put), turns, inbox, interrupts, hook caches, tool relay, the sink gate (`src/lib/sinks.ts`), the MCP client of its mcp capabilities (`src/lib/mcp-proxy.ts` over `src/lib/mcp.ts`; docs/agents/capabilities/mcp/), brokered actions and their journal (`src/lib/brokered.ts`; docs/agents/capabilities/brokered/), `egress_policy`, and the grants it holds, checked down their chain for `read_transcript` and `list` (`src/lib/grants.ts`, pure but for the chain's two lookups; docs/agents/tools/#grants) |
| `src/do/mcp-connector.ts` | **McpConnectorDO**: one per remote MCP server and credential: the shared tool list, change notices to agents, call admission (docs/control-plane/durable-objects/mcp-connector/) |
| `src/do/workstream.ts` | **WorkstreamDO** (stub): workstreams left the platform; the class stays declared, serving only health (its alarm re-arms daily while the previous release's decision events wait), until stage 4 deletes it |
| `src/do/broker.ts` | **BrokerDO**: Claude setup tokens, injection secrets, capability credentials (`cap:<name>`, read by AgentDO only), MCP OAuth tokens (`OAuthStore`, `src/lib/mcp-auth.ts`), http profile credentials (`http:<name>`), the argument secret scan, the GitHub App minter (`github_app`; `src/lib/github.ts`), the caller identity keys and signer (`src/lib/identity.ts`, served at `/.well-known/jwks.json`), and the issuance audit in R2 |
| `src/do/catalog.ts` | **CatalogDO** (one): templates and capabilities, seeded with `worker` and `captain` and migrated once per later seed version (new entries; the task ledger's and the channel capabilities removed), and API clients' namespaces (`<client>/<entry>`); expansion is `src/lib/spec.ts` (pure), held to a client's grant in its subtree |
| `src/do/client.ts` | **ClientDO** (one per API client, plus the `directory` of names): the record, grant and token hash, the registry of its subtree that its maximums count and it lists, and its webhook with the backlog of events it delivers (`src/lib/client-events.ts`); grants, tokens and labels are `src/lib/clients.ts` (pure) (docs/control-plane/durable-objects/client/) |
| `src/do/channel.ts` | **ChannelDO** (stub): channels left the platform; the class stays declared, serving only health and re-arming a previous release's alarm, until stage 4 deletes it |
| `src/do/tasks.ts` | **TaskLedgerDO** (stub): the task ledger left the platform; the class stays declared, serving only health, until stage 4 deletes it |
| `src/lib/` | Reliable channels (strict in-order inbound, serial queue) and deadlines, host tokens, AWS identity (CMS RSA) verifier, CA signing, EC2 STONITH, tool registry, repo allowlists (`repos.ts`) and the egress rule constructors (`rules/`: GitHub's push allowlist to request guards; docs/sandbox/networking/egress/policy/#request-guards) |
| `test/regressions.test.ts` | One regression test per finding of the control-plane review |

## Commands

```bash
npm install
npm test           # vitest in workerd (@cloudflare/vitest-plugin): fixtures, enrollment, fleet, tunnel, hands, session, policy, regressions
npm run typecheck  # tsc --noEmit
npm run dev        # wrangler dev --local, state persisted in .wrangler/state
```

## Local end-to-end with the Rust host components

1. `cp .dev.vars.example .dev.vars`, then `npm run dev`. It serves `http://127.0.0.1:8787`, with
   `ALLOW_DEV_CA=1` so FleetDO mints a development root CA.
2. Mint an enrollment token per host, `sandbox` for the host that runs sandboxes and `brain` for the one that
   runs brains (every brain starts on a brain host):
   `curl -s -XPOST localhost:8787/v1/admin/enrollment-tokens -H 'authorization: Bearer dev-admin-token' -d '{"role":"sandbox","cell":"local"}'`.
   The host then enrolls with `POST /v1/hosts/enroll` (proof `enrollment_token`) and dials
   `ws://127.0.0.1:8787/v1/fleet` with the returned host token.
3. Fetch the root certificate to trust in test sandboxes: `GET /v1/admin/root-ca`.
4. Store a Claude setup token: `PUT /v1/admin/secrets/claude_oauth_token {"value": "..."}`. A template's
   `credential` may name another, `claude_oauth_token:<name>` (the seeds use `:worker` and `:captain`), which
   falls back to `claude_oauth_token` while it isn't set.
5. Create work (all admin endpoints use `Authorization: Bearer $ADMIN_TOKEN`):
   - `GET /v1/admin/catalog` · `PUT|DELETE /v1/admin/capabilities/<name> {tools, rules, prompt}` ·
     `PUT|DELETE /v1/admin/templates/<name> {capabilities, launch, hands, credential}`
   - `POST /v1/sandboxes {cell, policy?, idle_ttl_ms?}` (a `workstream` is accepted and ignored for one release): placed on a connected sandbox host (201), or accepted unplaced (202) and retried every 30 s while an autoscaled cell launches one. `policy` is the
     operator's layer: `{allow: [{host, ports?}], passthrough: [host], inject: [InjectionBinding], tcp: [{host, port}]}`. `idle_ttl_ms`: destroyed once dormant this long
     (no agent attached, no VM up; default the cell's, 1 day); `PUT /v1/sandboxes/<id>/lifetime {idle_ttl_ms | null}` changes it ([lifetime](../docs/control-plane/durable-objects/sandbox/#lifetime))
   - `PUT /v1/sandboxes/<id>/policy` (same layer) · `GET /v1/sandboxes/<id>/policy` (effective policy; each allow rule has `source`: `base`, `operator`, `repos`, `client`, `grant`)
   - `POST /v1/sandboxes/<id>/place`: place an unplaced sandbox, or re-place a `failed` one under a new epoch
     (409 if it's placed)
   - `POST /v1/sandboxes/<id>/ports {port, share?, host_header?}` · `DELETE /v1/sandboxes/<id>/ports/<port>`:
     the only way to mint a public share link (agents can't)
   - `POST /v1/agents {template, sandbox?, owner?, overrides?, cell?, start?}`: expands the template
     (operator overrides: `launch`, `rules`, `tools` (narrows only), `credential`, `ephemeral`; an agent's own
     spawn, `agent_spawn`, takes only `SpawnerOverrides`, which narrow) and sends `agent_start` to
     the host; an agent with a sandbox takes its cell (a mismatch is refused with 409), and an `owner` must name an
     agent. For one release `workstream` is accepted and ignored, `role` is read as the same-named template,
     `captain` as `owner`, top-level `launch` and `rules` as overrides, and `grants` intersects the tools silently.
     Answers 201 with the agent and `started`; a start that can't run yet (no brain host, a cold cell) keeps its
     intent and runs when room appears, and the answer says why in `start_waiting` (an error body) with `started: null`
   - `POST /v1/agents/<id>/start {host?, restart?, launch?, when?}`: start (or restart) the brain; with `restart: true`, `launch: {model?, effort?}` restarts it on them, resuming its session, and `when: "idle"` only between turns (`409 busy` while a turn runs or is queued) (the owner's: [restarting on another model](../docs/control-plane/api/#restarting-on-another-model)); `host` puts it on a chosen active,
     connected host of the cell (for a test); hands still go through the sandbox's gateway. Answers `{host, cmd}`;
     `kind: none` when the brain already runs (nothing sent; `{restart: true}` restarts it: condemned, then started
     again once released); `kind: waiting, waiting_for: <host>` when the brain runs on another host: it is condemned
     and killed there, and this start (kept as the agent's intent, merged with any other start wanted meanwhile) runs
     once that brain's exit or its host's loss releases it
   - `POST /v1/agents/<id>/turns {text}` · `/inbox` · `/interrupt`
   - `POST /v1/agents` and `POST /v1/sandboxes` take an `Idempotency-Key` header (`src/lib/idempotency.ts`): the same key and
     body within 24 h answer the first object (`Idempotent-Replayed: true`), another body 409 ([idempotency keys](../docs/control-plane/api/#idempotency-keys)).
     Only a cell's own routes read `?cell=` (the fleet, hosts, images, lifetimes, tunnels, GC, root CA, the operator's
     listings); the rest need none ([which routes take a cell](../docs/control-plane/api/#which-routes-take-a-cell))
   - `GET /v1/agents?cell=&label=k=v&state=live|ended|all&limit=&cursor=` and the same for `GET /v1/sandboxes`: the cell's
     registry (FleetDO), or `?client=cli_…` a client's subtree (ClientDO); `label` repeats, each must hold. `POST /v1/agents`
     and `POST /v1/sandboxes` take `labels` (up to 16, fixed once set), and `owner` may be `user`
   - `GET /v1/agents/<id>/asks`: its calls held for the operator (sink approvals, tool rules in `ask` mode), oldest
     first, `{ask, question, created_ms, approval?: {name, tool}}`; `POST /v1/agents/<id>/asks/<ask>/answer {answer}`
     decides one, and the decision reaches the agent as an `ask_answer` turn
   - `POST /v1/sandboxes/<id>/grants {host, ttl_ms, ports?}`
   - `GET /v1/agents/<id>/transcript` (whole committed base) · `?since=<entry>&limit=<n>` (a page:
     `{lines, next_seq, more}`)
   - `GET /v1/agents/<id>/trace?after=<seq>`: a WebSocket of the agent's live trace (turns, assistant text, tool calls
     and results, state, asks, `ended`), resumed after a seq, with a `gap` first when the ring no longer reaches back
     (`src/lib/trace.ts`; docs/control-plane/api/#live-trace)
   - `GET /v1/agents/<id>/trace/history?before=<cursor>&limit=<n>`: the trace's older events from the stored transcript,
     `{events, next_before}`, meeting the ring at its seam (`src/lib/trace-history.ts`; docs/control-plane/api/#trace-history)
   - `POST /v1/admin/hosts/<id>/confirm-dead`: manual STONITH (also releases the host's tunnel and record; a host
     still running cloudflared keeps its tunnel undeletable until the instance is gone, and the sweep finishes it)
   - `POST /v1/admin/tunnels/sweep?cell=<cell>`: run the daily tunnel sweep now; returns what it deleted, retried,
     failed and left alone (`unknown`: nest-named tunnels and records this cell did not create), and how many of
     its own records of creating a tunnel it forgot (`forgotten`: no host row, and two complete listings show nothing)
   - `PUT /v1/admin/secrets/access:gateway {"value": "{\"client_id\":...,\"client_secret\":...}"}`: the Cloudflare
     Access service token `resolve` hands out as `edge` on every target that points at a host's connected tunnel
   - `GET /v1/admin/fleet?cell=<cell>`: hosts (status, tunnel state, capacity, resident sandboxes and brains, idle since),
     launched instances (outcome) and every live sandbox with its lease; `GET /v1/admin/images?cell=<cell>`: the
     cell's host AMIs and the one the launch template resolves to (the dashboard reads both)
   - `GET /v1/admin/lifetimes?cell=<cell>[&cursor=&limit=&quiet_ms=]`: what is left lying around, a page of the
     registry at a time (`next_cursor`): dormant sandboxes and when their TTL destroys them, sandboxes held only by
     agents nobody uses, quiet or stuck-ending agents with what they hold, the rest counted
     ([what counts](../docs/control-plane/dashboard/#abandoned); the dashboard reads it)
   - `POST /v1/admin/launched {instance_id, role, account_id?, region?, cell}`: record an instance we
     launched so it may enroll with its AWS identity document (as that role, from that account and region)
   - Injection secrets: `PUT /v1/admin/secrets/inject:<binding>` (or `inject:<binding>:<sandbox>`; `inject:<binding>:<ws_…>` is still read for older secrets)
   - A remote MCP server: its bearer token with `PUT /v1/admin/secrets/cap:<name>`, then
     `PUT /v1/admin/capabilities/<name> {"mcp": {"url": "https://…/mcp", "auth": "cap:<name>", "tools": [...]}}` and the capability
     added to a template (`docs/agents/capabilities/mcp/`); without `auth`, no bearer is sent and the server verifies `Nest-Identity`
   - Over OAuth: `"auth": {"oauth": "cap:<name>", "client"?: "cap:<name>-client", "scopes"?: [...]}`, then
     `POST /v1/admin/capabilities/<name>/oauth {scopes?}` (answers `authorize_url`: open it and approve), which lands on the public
     `GET /v1/oauth/callback`; `GET /v1/admin/capabilities/<name>/oauth` shows the state, never a token. nest's client ID metadata
     document is the public `GET /v1/oauth/client.json` (`docs/agents/capabilities/mcp/#oauth`)
   - Brokered actions (`docs/agents/capabilities/brokered/`): the GitHub App with `PUT /v1/admin/secrets/github_app {"value": "{\"app_id\": \"…\", \"private_key\": \"-----BEGIN RSA PRIVATE KEY-----…\"}"}`,
     a profile's credential with `PUT /v1/admin/secrets/http:<name>`, then a capability `{"brokered": [{"action": "github.create_pr", "repos": ["owner/name"]}, …]}`
     added to a template. `GET /v1/agents/<id>/brokered?limit=&before=` is the agent's journal, newest first

## API clients

External systems (docs/control-plane/api/clients/): `POST /v1/admin/clients {name, grant}` (answers the token once:
`nest_cli_<id>_<secret>`) · `GET /v1/admin/clients` · `GET|PATCH /v1/admin/clients/<cli> {grant}` ·
`POST /v1/admin/clients/<cli>/rotate` · `DELETE /v1/admin/clients/<cli>` (409 while its subtree lives). A grant is
`{cells, credentials, repos, mcp_urls, github?, max_agents, max_sandboxes}`. With its token a client calls the owner routes
(`auth: "owner"` in `src/index.ts`: create, list, read, turns, inbox, interrupt, start, stop and end, children, transcript, live trace and its history,
brokered journal, asks and answers; sandbox create, list, read, destroy, lifetime and effective policy) on its own subtree only
(anything else answers as an unknown id, 404), with `SpawnerOverrides`, and writes its catalog namespace:
`GET /v1/catalog` · `GET|PUT|DELETE /v1/catalog/templates/<client-name>/<entry>` and `…/capabilities/…`. Its own, with a
client token only: `POST /v1/clients/self/github-token {repo, permissions}` (a GitHub App token within `github`; BrokerDO mints it). Its secrets (`src/lib/client-secrets.ts`): `PUT|DELETE /v1/clients/self/secrets/<name> {value, description?}` and
`GET /v1/clients/self/secrets` (names and metadata, never a value; the operator's `GET /v1/admin/clients/<cli>/secrets`),
within `secrets {max_count, max_bytes}`; bindings naming them (`inject` in its templates, overrides and `POST /v1/sandboxes`,
hosts within `inject_hosts`) are injected by nest-proxy; `github_push: {workflows: true}` (within `github_push`) adds
`workflows: write` to a sandbox's push token. Egress rules within `egress_hosts` (`egress {allow: [{host, ports?}]}` in its templates, overrides and
`POST /v1/sandboxes`), env (`env {NAME: value}`), and the live sandbox's client layer, `GET|PUT /v1/sandboxes/<id>/client-policy {egress?, inject?, env?}`
(`src/lib/client-egress.ts`, `src/lib/sandbox-env.ts`). An agent's timers (`src/lib/timers.ts`): `GET /v1/agents/<id>/timers`, `DELETE /v1/agents/<id>/timers/<name>`.
Its events (`src/lib/client-events.ts`): `PUT /v1/clients/self/webhook {url}` (https; answers the signing secret once);
its agents and sandboxes hand them to ClientDO from their alarms, and ClientDO POSTs each, signed (`Nest-Signature`), with
retries; `GET /v1/clients/self` (the client) and `GET /v1/admin/clients/<cli>` show `events {webhook, backlog, dropped, failures, last_error}`.

## Secrets and vars

| Name | Purpose |
|---|---|
| `ADMIN_TOKEN` | Admin API bearer token (Cloudflare Access replaces it later) |
| `HOST_TOKEN_SECRET` | HMAC key for host tokens, signed blob URLs and share links |
| `ROOT_CA_CERT_PEM`, `ROOT_CA_KEY_PEM` | Development proxy root CA (PKCS#8 ECDSA P-256 key), for a cell with no KMS key. Without them, `ALLOW_DEV_CA=1` mints a dev root. A cell with a KMS key derives its certificate instead and ignores them (`docs/sandbox/networking/egress/tls/`) |
| `AWS_IDENTITY_CERT_PEM` | AWS public certificate for the `rsa2048` identity signature (enables AWS enrollment) |
| `AWS_CELL_CREDENTIALS` | Secret: JSON object of cell → `{access_key_id, secret_access_key}` of `nest-<cell>-control-plane` (STONITH, the autoscaler, KMS). Without an entry the cell has no AWS access (no global fallback): STONITH waits for the host to fence, or for an operator |
| `PUBLIC_BASE_URL`, `HOST_TOKEN_TTL_MS`, `PROXY_CA_TTL_MS` | See `wrangler.jsonc` |
| `CELLS` | Optional comma-separated list of valid cells; when set, requests for other cells are refused |
| `SANDBOX_RETENTION` | Generation retention (`src/lib/retention.ts`; docs/sandbox/state/#retention): `on` (the default: marks generations `deleting` and non-source memory unrooted; GC's first run after it turns on is dry) or `off` (an emergency stop) |
| `ALLOW_LOOPBACK_MCP` | `1` lets an mcp capability name a loopback URL (`http://127.0.0.1:…`): tests and local dev (the e2e harness) only; never set in a deploy |
| `ALLOW_LOOPBACK_BROKERED` | `1` lets an http profile and `GITHUB_API_URL` name a loopback URL: tests and local dev only; never set in a deploy |
| `GITHUB_API_URL`, `BROKERED_TIMEOUT_MS` | The REST API GitHub actions use (default `https://api.github.com`; a fake in e2e) and one brokered request's budget (default 30000) |
| `MCP_CALL_TIMEOUT_MS`, `MCP_LIST_TIMEOUT_MS` | The MCP proxy's budget for one forwarded `tools/call` (default 45000) and the connector's for listing one server's tools, `initialize` included (default 4000) |
| `MCP_ADMIT_WAIT_MS`, `MCP_RELIST_MS` | How long an MCP call waits for a slot on its server (default 10000), and how often a connector lists again while brains use its list (default 60000) |
| `NEST_DOMAIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_API_TOKEN` | Per-host tunnels (`src/lib/cloudflare.ts`): with all three set, a sandbox host's enrollment creates a Cloudflare Tunnel `<label>-<host>`, its ingress to the gateway on loopback and a proxied CNAME `<host>-gw-<label>.<zone>`, and `resolve` targets `wss://` that hostname (a tunnel host that serves none is not ready, never its loopback `gateway_url`). `NEST_DOMAIN` also names previews (`<port>-<sandbox>-preview-<label>.<zone>`) and share links (`<token>-share-<label>.<zone>`). The token needs Account › Cloudflare One Connector: cloudflared › Edit and Zone › DNS › Edit. Unset: no tunnels; `resolve` uses the host's own `gateway_url`, and preview names use `nest.localhost` |
| `AWS_CELLS` | Per-cell AWS settings, written by the cell stacks: JSON object of cell → `{region, launch_template_id, subnet_ids, instance_types, spot?, max_hosts?, idle_grace_ms?, enroll_timeout_ms?, sandbox_reserve_mib?, max_sandboxes_per_host?, proxy_root_key_arn?, brain?}` (`src/lib/cells.ts`); `brain` is the brain hosts' `{launch_template_id, instance_types, spot?, max_hosts?, idle_grace_ms?, max_brains_per_host?}`. A cell without an entry is never scaled, and one without `brain` launches no brain host |

Secret values exist only in BrokerDO. Command bodies stored in FleetDO (and its resend queue) carry
`$nest-secret:<name>` references, resolved when the command is sent to a host.

## Known gaps

- **The two-system split** (`docs/architecture/`): the control plane's side of the seam is built: BrokerDO holds
  the per-cell binding signing key (`binding_key:<cell>`, a P-256 private JWK; `signBinding`, `bindingPublicKeys`),
  FleetDO sends `binding_key` after every hello and records each host's `gateway_url`, SandboxDO configures agent
  slots with `agent_attach`/`agent_detach` and answers `resolve` with a `HandsTarget` only once the slot's result
  is in, AgentDO answers `hands_resolve` on the session channel, and `POST /v1/sandboxes/:id/resolve` serves a
  person or a test harness. Per-host tunnels: FleetDO creates one at a sandbox host's enrollment (`tunnel_id`,
  `tunnel_hostname`, `dns_record_id` on the host's row; the tunnel token goes to the host and is kept nowhere
  else), is the authority for the name but advertises `wss://<tunnel_hostname>` only while the host reports its
  tunnel `connected` (`hello.tunnel` and the `tunnel_state` event, kept in `tunnel_state`): `connecting` makes
  `resolve` answer `sandbox_not_ready` (the runner retries), and `none` (an old nestd, no cloudflared) falls back
  to the hello URL with an error logged (reachable only from the same machine, as on the harness). A tunnel
  target without `access:gateway` is refused (500, not retryable) rather than minted for the edge to reject.
  FleetDO deletes the tunnel and record on every path that marks a host dead, and a daily `tunnel_sweep` alarm
  deletes leaks. A proof (enrollment token or instance identity) already used by a host that never said hello
  enrolls again (that host dies and its tunnel goes): a lost enrollment answer does not brick the instance. A
  Cloudflare 401/403 at enrollment (the API token revoked or short of a permission) enrolls the host without a
  tunnel and logs it, so a bad token does not burn instances through the enroll timeout. The account is shared (other cells, other deployments, tunnels
  made by hand), so the sweep deletes only tunnels and records this cell recorded in `tunnels_created` before its
  first Cloudflare call, for a host that is dead or never got a row within an hour; every other nest-shaped name
  is counted as `unknown` and logged. `resolve` carries the Access service token only when the host has a tunnel,
  never because a URL happens to be `wss://`. A sandbox host enrolled before this change has no tunnel until it
  re-enrolls (a new instance). Host kinds: `HostKind` is `sandbox | brain`; `HostRole` names on the wire and in
  storage stay `burst | controller` this release, with the new names read too (`hostKind`, `roleName`;
  expand/contract, `dev/deploy.md`). Every brain starts on a brain host with room (`FleetDO.placeBrain`,
  deciding through the pure `pickBrainHost` in `src/lib/placement.ts`: the agent's previous brain host, else the
  fullest; capacity in brains, `brain.max_brains_per_host` or 2 per vCPU, enforced by `issueCommands`),
  never on a sandbox host (`issueCommands` refuses one there); with none the start waits and FleetDO launches a brain host from the
  cell's `brain` section of `AWS_CELLS`, retiring one after `brain.idle_grace_ms` with no brain (`scaleUpPlan`,
  `idleStep`; `test/brain-hosts.test.ts`). A brain host enrolls without a proxy CA. AgentDO issues an agent
  epoch per start (a sandbox move doesn't restart a brain), and `agent_start.hands` carries the sandbox id only
  (the runner fetches its target). Not built: key rotation, the three desired versions, and gentle drains.
- **Generation retention** (`docs/sandbox/state/#restore-sources`, `#retention`; `src/lib/retention.ts`, pure): the one
  `isRestoreSource` predicate, the placement pin, the retention tiers and the bounded turn ends, `deleting` generations
  and the GC roots they leave; SandboxDO's `retention` deadline applies it, behind `SANDBOX_RETENTION`. Not built: fork pins.
- **Agent lifetimes** (`docs/agents/#lifetimes`, `src/lib/lifetimes.ts`): `agent_spawn`, `agent_stop` and `exit`; ephemeral
  agents; an end's cascade, turn drop, sandbox release (`SandboxDO.release`) and record pruning; sandboxes' idle TTL. An
  operator's plain stop is unchanged (its next input lifts it) and keeps the agent's slot; `POST /v1/agents/<id>/stop
  {end: true, destroy_sandbox?}` ends it for good. `GET /v1/agents/<id>/children` lists what it spawned. Not built:
  adoption and parking, budgets (fixed depth and live-children caps stand in), agent events delivered to owners.
- **Removed** (microkernel, `docs/README.md` principle 9): the task ledger (stage 1), channels (stage 2: ChannelDO's
  logic, the channel tools and capabilities, subscriptions and wakes, agent and sandbox events, `/v1/admin/channels`)
  and workstreams (stage 3: WorkstreamDO's logic and routes, `notify`/`ask`/`emit`, `escalate_to`, `subscribe`).
  Their classes stay declared as stubs until stage 4. For one release the control plane still writes and sends a
  `ws_` value (records, `sandbox_create`, `agent_start`) for the previous release's hosts, runners and rollback.
- **Behind the design** (`docs/agents/`): grants with attenuation,
  capability sources (`api`) and parameters, and labels aren't built.
  Templates and capabilities are data (CatalogDO), an agent stores its expanded spec and `owner`, and nothing
  decides on a role; `agent_start.role` and `ToolDef.roles` are still sent for one release. Taint is a conservative stand-in (an agent with hands or a web built-in, or one another agent's
  possibly tainted text reached, is tainted). The sink gate covers remote MCP tools, brokered actions and `egress_policy`; budgets and the hands journal aren't built.
  Session bytes are acked after the R2 put and flushed every 5 s, where the design acks on the SQLite
  commit and flushes at turn boundaries. The contract changes are listed in `docs/interfaces/README.md`.
- **Built: placement** packs (`test/placement.test.ts`): on regular pages by `memory_mib_free` with a per-sandbox
  reserve and an optional per-host cap, on a hugepage host by the pool; an empty host always takes one.
- **Platform tools without implementations** return `not_implemented`: `fork_sandbox`,
  `attach`, `checkpoint`, and the seeded `management` and `memory` capabilities' tools; of the brokered actions, `email.send`.
- **GitHub App installation tokens** are minted for brokered actions and for a sandbox's push allowlist (`docs/control-plane/durable-objects/broker/#injection-minting`); the rule constructors are in `src/lib/rules/` (GitHub's only).
- **Metrics** (`docs/control-plane/metrics/`): no Analytics Engine writes or `metrics_query`. Built: `/v1/health` makes one read-only round trip to each DO class (`src/lib/health.ts`).
- **Catalogs seeded before this release** keep `delegate`, `spawn_agent` and `kill` in `management` (ignored on expansion: the registry no longer has them), get the `spawning` capability without a template listing it, and the old `worker` (`subagents`, `TodoWrite`, `Task`, `WebSearch`) until the operator edits them; a new catalog gets the design's (`docs/control-plane/durable-objects/catalog/`).
- **Security design** (`docs/control-plane/api/`, `docs/sandbox/networking/egress/tls/`): one `ADMIN_TOKEN` stands in for scoped, hashed operator tokens; there's no revocation counter; the CSR shape isn't enforced; BrokerDO audits GitHub mints only (not secret pushes or binding mints).
- **Lifecycle design** (`docs/control-plane/durable-objects/sandbox/`): typed placement claims, loss records, fork pins, the pause tier and restore-ABI sets aren't built. Built: idle suspend (`SANDBOX_SUSPEND_IDLE_MS`), lazy wake, eviction, the spot drain and dropping leases a restarted nestd doesn't report.
- **Built:** the autoscaler, per host kind (`AWS_CELLS`: `RunInstances` from the cell's launch template, or the `brain` section's for brain hosts; idle retirement, enroll timeouts).
- **Not built:** Cloudflare Access applications from the control plane (the `edge` inframe stack manages
  them; the control plane only stores the service token), the preview/share Worker routes, the api-loop backend (deferred), budgets. Preview and
  share URLs are already minted by the hostname rule (`sandbox.ts`), so nothing routes them yet.
- **Host-side behavior is driven, not modeled.** The control plane issues create (including re-place
  and reassign), destroy, fence, suspend (idle and spot drains), resume (lazy wake) and turn-end checkpoints;
  fork, archive and drain are never sent.
- **Commands aren't coalesced:** each `issueCommands` call is one `commands` batch, sent in seq order through the
  host's send chain.
- **Delivery semantics to know:** platform tool calls are at least once across an AgentDO eviction
  (a call cut off mid-dispatch runs again when redelivered); a turn cut off by a brain restart comes
  back as a `recovery` turn.

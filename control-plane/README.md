# nest control plane

Cloudflare Worker plus Durable Objects that implement [docs/control-plane/](../docs/control-plane/) and
the [control-host contract](../docs/interfaces/control-host/). Wire types are in `src/protocol/` (zod,
mirroring `crates/nest-protocol`). Every fixture in `protocol/fixtures/control/` must round-trip.

| Path | What |
|---|---|
| `src/index.ts` | Worker: enrollment, WebSocket routing (host-token auth), signed blob URLs, admin API |
| `src/do/fleet.ts` | **FleetDO** (one per cell): enrollment, fleet channel, leases, expiry, STONITH, placement, commands |
| `src/do/sandbox.ts` | **SandboxDO**: epoch, commit compare-and-set, generations, layered policy and expiring grants, idle refcount, ports |
| `src/do/agent.ts` | **AgentDO**: session channel, segments to R2 (acked after the put), turns, inbox, interrupts, hook caches, tool relay |
| `src/do/workstream.ts` | **WorkstreamDO**: event fan-in, batched captain wakes, user-notification queue |
| `src/do/broker.ts` | **BrokerDO**: Claude setup tokens, injection secrets, GitHub App minter (interface only) |
| `src/lib/` | Reliable channels (strict in-order inbound, serial queue) and deadlines, host tokens, AWS identity (CMS RSA) verifier, CA signing, EC2 STONITH, tool registry |
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
2. Mint an enrollment token:
   `curl -s -XPOST localhost:8787/v1/admin/enrollment-tokens -H 'authorization: Bearer dev-admin-token' -d '{"role":"burst","cell":"local"}'`.
   The host then enrolls with `POST /v1/hosts/enroll` (proof `enrollment_token`) and dials
   `ws://127.0.0.1:8787/v1/fleet` with the returned host token.
3. Fetch the root certificate to trust in test sandboxes: `GET /v1/admin/root-ca`.
4. Store a Claude setup token: `PUT /v1/admin/secrets/claude_oauth_token {"value": "..."}`. Optional
   per-role overrides are `claude_oauth_token:worker` and `claude_oauth_token:captain`.
5. Create work (all admin endpoints use `Authorization: Bearer $ADMIN_TOKEN`):
   - `POST /v1/workstreams {goal}`
   - `POST /v1/sandboxes {workstream, cell, policy?}`: placed on a connected sandbox host (the `burst` role; 201), or accepted unplaced (202) and retried every 30 s while an autoscaled cell launches one. `policy` is the
     workstream layer: `{allow: [{host, ports?}], passthrough: [host], inject: [InjectionBinding], tcp: [{host, port}]}`
   - `PUT /v1/sandboxes/<id>/policy` (same layer) · `GET /v1/sandboxes/<id>/policy` (effective policy)
   - `POST /v1/sandboxes/<id>/place`: place an unplaced sandbox, or re-place a `failed` one under a new epoch
     (409 if it's placed)
   - `POST /v1/sandboxes/<id>/ports {port, share?, host_header?}` · `DELETE /v1/sandboxes/<id>/ports/<port>`:
     the only way to mint a public share link (agents can't)
   - `POST /v1/agents {role, workstream, sandbox?, cell, start?}`: sends `agent_start` to the host
   - `POST /v1/agents/<id>/start {host?}`: start (or restart) the brain; `host` puts it on a chosen active,
     connected host of the cell (for a test); hands still go through the sandbox's gateway
   - `POST /v1/agents/<id>/turns {text}` · `/inbox` · `/interrupt` · `/asks/<ask>/answer {answer}`
   - `POST /v1/sandboxes/<id>/grants {host, ttl_ms, ports?}`
   - `GET /v1/agents/<id>/transcript` (whole committed base) · `?since=<entry>&limit=<n>` (a page:
     `{lines, next_seq, more}`)
   - `POST /v1/admin/hosts/<id>/confirm-dead`: manual STONITH (also releases the host's tunnel and record; a host
     still running cloudflared keeps its tunnel undeletable until the instance is gone, and the sweep finishes it)
   - `POST /v1/admin/tunnels/sweep?cell=<cell>`: run the daily tunnel sweep now; returns what it deleted, retried,
     failed and left alone (`unknown`: nest-named tunnels and records this cell did not create)
   - `PUT /v1/admin/secrets/access:gateway {"value": "{\"client_id\":...,\"client_secret\":...}"}`: the Cloudflare
     Access service token `resolve` hands out as `edge` on every target that points at a host's connected tunnel
   - `GET /v1/admin/fleet?cell=<cell>`: hosts (status, leases, idle since) and launched instances (outcome)
   - `POST /v1/admin/launched {instance_id, role, account_id?, region?, cell}`: record an instance we
     launched so it may enroll with its AWS identity document (as that role, from that account and region)
   - Injection secrets: `PUT /v1/admin/secrets/inject:<binding>` (or `inject:<binding>:<workstream>`)

## Secrets and vars

| Name | Purpose |
|---|---|
| `ADMIN_TOKEN` | Admin API bearer token (Cloudflare Access replaces it later) |
| `HOST_TOKEN_SECRET` | HMAC key for host tokens, signed blob URLs and share links |
| `ROOT_CA_CERT_PEM`, `ROOT_CA_KEY_PEM` | Proxy root CA (PKCS#8 ECDSA P-256 key). Without them, `ALLOW_DEV_CA=1` mints a dev root |
| `AWS_IDENTITY_CERT_PEM` | AWS public certificate for the `rsa2048` identity signature (enables AWS enrollment) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | Scoped IAM user for STONITH. Without them, STONITH waits for the host to fence, or for an operator |
| `PUBLIC_BASE_URL`, `PREVIEW_DOMAIN`, `ASK_SYNC_WINDOW_MS`, `HOST_TOKEN_TTL_MS`, `PROXY_CA_TTL_MS` | See `wrangler.jsonc` |
| `WAKE_BATCH_MS` | Captain wake batching window; defaults to 2000 in code (not in `wrangler.jsonc`) |
| `CELLS` | Optional comma-separated list of valid cells; when set, requests for other cells are refused |
| `NEST_DOMAIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_API_TOKEN` | Per-host tunnels (`src/lib/cloudflare.ts`): with all three set, a sandbox host's enrollment creates a Cloudflare Tunnel `<label>-<host>`, its ingress to the gateway on loopback and a proxied CNAME `<host>-gw-<label>.<zone>`, and `resolve` targets `wss://` that hostname. The token needs Account › Cloudflare One Connector: cloudflared › Edit and Zone › DNS › Edit. Unset: no tunnels; `resolve` uses the host's own `gateway_url` |
| `AWS_CELLS` | Autoscaled cells: JSON object of cell → `{region, launch_template_id, subnet_ids, instance_types, spot?, max_hosts?, idle_grace_ms?, enroll_timeout_ms?}` (`src/lib/cells.ts`). A cell without an entry is never scaled |

Secret values exist only in BrokerDO. Command bodies stored in FleetDO (and its resend queue) carry
`$nest-secret:<name>` references, resolved when the command is sent to a host.

## Known gaps

- **The two-system split** (`docs/architecture/`): the control plane's side of the seam is built: BrokerDO holds
- Agent removal isn't built, so `SandboxDO.detach` has no caller yet: a stopped agent keeps its slot, proxy port and gateway client entry, and revocation by detach is exercised only by tests.
  the per-cell binding signing key (`binding_key:<cell>`, a P-256 private JWK; `signBinding`, `bindingPublicKeys`),
  FleetDO sends `binding_key` after every hello and records each host's `gateway_url`, SandboxDO configures agent
  slots with `agent_attach`/`agent_detach` and answers `resolve` with a `HandsTarget` only once the slot's result
  is in, AgentDO answers `hands_resolve` on the session channel, and `POST /v1/sandboxes/:id/resolve` serves a
  person or a test harness. Per-host tunnels: FleetDO creates one at a sandbox host's enrollment (`tunnel_id`,
  `tunnel_hostname`, `dns_record_id` on the host's row; the tunnel token goes to the host and is kept nowhere
  else), is the authority for the name but advertises `wss://<tunnel_hostname>` only while the host reports its
  tunnel `connected` (`hello.tunnel` and the `tunnel_state` event, kept in `tunnel_state`): `connecting` makes
  `resolve` answer `sandbox_not_ready` (the runner retries), and `none` (an old nestd, no cloudflared) falls back
  to the hello URL with an error logged, which works while every brain starts on its sandbox's host. A tunnel
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
  re-enrolls (a new instance). Not built: the agent epoch, host kinds with brain placement by capacity, key
  rotation and the three desired versions. The code has `burst` and `controller` host roles
  (`HostRole`), `FleetDO.controllerHost()` starts captains on a `controller` host, other brains start on the
  sandbox's host, and `agent_start.hands` carries the sandbox id and epoch only (the runner fetches its target).
- **Behind the design** (`docs/agents/`, `docs/channels/`): channels (ChannelDO), webhooks (HookDO), grants
  with attenuation, spawn specs, templates and capabilities, owners and labels aren't built. The code still has
  `AgentRole` (placement, tool filtering, launch defaults, per-role setup token), WorkstreamDO with
  `WorkstreamEvent` and batched captain wakes, a role-filtered tool catalog, and a `workstream`
  egress policy layer. Taint and sinks, budgets, wake envelopes and the hands journal aren't built either.
  Session bytes are acked after the R2 put and flushed every 5 s, where the design acks on the SQLite
  commit and flushes at turn boundaries. Placement is least-loaded by lease count, where the design packs
  by free hugepages. The contract changes are listed in `docs/interfaces/README.md`.
- **Platform tools without implementations** return `not_implemented`: `fork_sandbox`, `spawn_agent`,
  `attach`, `checkpoint`, `brokered`, and all captain tools except `notify`, `ask` and `read_transcript`.
- **GitHub App installation-token minting** is an interface only; the `github.*` brokered actions aren't built.
- **Metrics** (`docs/control-plane/metrics/`): no Analytics Engine writes or `metrics_query`; `/v1/health` doesn't reach the DOs yet.
- **Security design** (`docs/control-plane/api/`, `docs/sandbox/networking/egress/tls/`): one `ADMIN_TOKEN` stands in for scoped, hashed operator tokens; there's no revocation counter; the root CA key is `ROOT_CA_KEY_PEM`, not a KMS key, and the CSR shape isn't enforced; BrokerDO has no issuance audit.
- **Lifecycle design** (`docs/control-plane/durable-objects/sandbox/`): typed placement claims, loss records, pins, `isRestoreSource`, retention, the pause tier and restore-ABI sets aren't built. Built: idle suspend (`SANDBOX_SUSPEND_IDLE_MS`), lazy wake, eviction, the spot drain and dropping leases a restarted nestd doesn't report.
- **Built:** the autoscaler (`AWS_CELLS`: `RunInstances` from the cell's launch template, idle retirement, enroll timeouts).
- **Not built:** Discord, the Cloudflare Access applications (created by hand; the control plane only stores
  the service token), the preview/share Worker routes, the api-loop backend (deferred), budgets. The share-link
  code still mints `<port>-<sandbox>.<PREVIEW_DOMAIN>` (`sandbox.ts`), a second-level name under `nest.<zone>`
  that Universal SSL does not cover; when the routes are built it derives `<port>-<sandbox>-preview-<label>.<zone>`
  from `NEST_DOMAIN` and `PREVIEW_DOMAIN` goes.
- **Host-side behavior is driven, not modeled.** The control plane issues create (including re-place
  and reassign), destroy, fence, suspend (idle and spot drains) and resume (lazy wake); checkpoint,
  fork, archive and drain are never sent.
- **Commands aren't batched:** FleetDO sends one `commands` frame per `issueCommands` call.
- **Delivery semantics to know:** platform tool calls are at least once across an AgentDO eviction
  (a call cut off mid-dispatch runs again when redelivered); a turn cut off by a brain restart comes
  back as a `recovery` turn; a guest `nest ask` waiting in memory falls back to an async answer on
  eviction.

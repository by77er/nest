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
npm test           # vitest in workerd (@cloudflare/vitest-plugin): fixtures, enrollment, fleet, session, policy, regressions
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
   - `POST /v1/sandboxes {workstream, cell, policy?}`: placed on a connected burst host. `policy` is the
     workstream layer: `{allow: [{host, ports?}], passthrough: [host], inject: [InjectionBinding], tcp: [{host, port}]}`
   - `PUT /v1/sandboxes/<id>/policy` (same layer) · `GET /v1/sandboxes/<id>/policy` (effective policy)
   - `POST /v1/sandboxes/<id>/place`: place an unplaced sandbox, or re-place a `failed` one under a new epoch
     (409 if it's placed)
   - `POST /v1/sandboxes/<id>/ports {port, share?, host_header?}` · `DELETE /v1/sandboxes/<id>/ports/<port>`:
     the only way to mint a public share link (agents can't)
   - `POST /v1/agents {role, workstream, sandbox?, cell}`: sends `agent_start` to the host
   - `POST /v1/agents/<id>/turns {text}` · `/inbox` · `/interrupt` · `/asks/<ask>/answer {answer}`
   - `POST /v1/sandboxes/<id>/grants {host, ttl_ms, ports?}`
   - `GET /v1/agents/<id>/transcript` (whole committed base) · `?since=<entry>&limit=<n>` (a page:
     `{lines, next_seq, more}`)
   - `POST /v1/admin/hosts/<id>/confirm-dead`: manual STONITH
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

Secret values exist only in BrokerDO. Command bodies stored in FleetDO (and its resend queue) carry
`$nest-secret:<name>` references, resolved when the command is sent to a host.

## Known gaps

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
- **Not built:** Discord, the autoscaler (`RunInstances` + `/v1/admin/launched`), the Cloudflare Access
  front end, the preview/share Worker routes, the api-loop backend, budgets.
- **Host-side behavior is driven, not modeled.** Suspend/resume/fork commands exist in the protocol,
  but the control plane issues only create (including re-place and reassign), destroy and fence;
  checkpoint, suspend, resume, fork, archive and drain are never sent.
- **Commands aren't batched:** FleetDO sends one `commands` frame per `issueCommands` call.
- **Delivery semantics to know:** platform tool calls are at least once across an AgentDO eviction
  (a call cut off mid-dispatch runs again when redelivered); a turn cut off by a brain restart comes
  back as a `recovery` turn; a guest `nest ask` waiting in memory falls back to an async answer on
  eviction.

# Credentials inventory

| Credential | Stored | Seen by | Notes |
|---|---|---|---|
| Claude setup token (subscription OAuth, 1 year, model requests only) | BrokerDO | Claude Code process env on brain hosts only, **never a sandbox host, never a VM** | Separate named tokens per template, e.g. captains vs workers (to verify that they're independent and revocable) |
| GitHub App private key | BrokerDO | Control plane | Mints installation tokens per binding (1 hour, narrowed to the binding's repos and permissions); every mint is audited; see [BrokerDO](../../control-plane/durable-objects/broker/) |
| GitHub installation tokens | nest-proxy memory | Proxy only | Injected by placeholder, on the binding's exact hosts, methods and path |
| Other injected secrets | BrokerDO → nest-proxy memory | Proxy only | Per host and grant. Pushed with the policy hash; the proxy refuses one whose binding isn't in the installed policy. Every push and refusal is audited |
| Brokered-action secrets (email, …) | BrokerDO | Never a VM | Executed outside the VM |
| Proxy root CA key | AWS KMS (`ECC_NIST_P256`, non-exportable) | Nobody: FleetDO calls `kms:Sign` | Signs per-host intermediates at enrollment and renewal; CloudTrail logs each issuance; the root certificate is in the image. See [tls](../../sandbox/networking/egress/tls/) |
| Per-host intermediate CA (~7 days, pathLen 0) | nest-proxy memory; the key is generated on the host | Proxy | Signs leaf certificates (≤ 24 h) on the fly |
| OIDC signing key (deferred) | Worker secret | Control plane | JWKS published |
| Host token | FleetDO issues it; nestd and the runner hold it in memory | Host | Obtained with the signed identity document; rotated; void when the [revocation counter](../../control-plane/api/) moves |
| Binding key (per cell) | FleetDO; pushed to each sandbox host's gateway over the fleet channel | SandboxDO (signs bindings), the gateway (verifies) | Bindings are verified, never stored; an epoch bump voids them. See [gateway](../../sandbox/gateway/) |
| Bindings (sandbox, epoch, client, scope, about an hour) | Nowhere: signed tokens | The runner or `nest` CLI that holds one, the gateway | Issued by SandboxDO at `attach`, renewed by `resolve`, revoked by `detach` and by any epoch bump |
| Cloudflare Tunnel API token (Account: Cloudflare One Connector: cloudflared → Edit, Zone: DNS: Edit) | A secret on the GitHub `production` environment, written to the Worker as the secret `CLOUDFLARE_TUNNEL_API_TOKEN` at deploy | Control plane only | Creates and deletes one tunnel and one DNS record per sandbox host; sweeps leaks daily. See [gateway](../../sandbox/gateway/) |
| Per-host tunnel token | The Worker creates it at enrollment and returns it in the enrollment response; nestd keeps it in its credentials file (`0600`) and in cloudflared's process environment, never on a command line | Sandbox host | Names one tunnel; deleted with the host |
| Access service token (`access:gateway`) | BrokerDO, stored through `PUT /v1/admin/secrets/access:gateway` | SandboxDO puts it in every `wss://` hands target as `edge`, so a runner holds it in memory for the connection; **never a sandbox**; not built: the `nest` CLI through a login | The edge check in front of every gateway hostname |
| Operator tokens (`observe`, `approve`, `admin`) | SHA-256 hashes only, as a Worker secret | Me (`nest` CLI) | Scoped; header only, never in URLs. See [API](../../control-plane/api/) |
| AWS: host role | Instance profile | nestd (nest-proxy is kernel-blocked from IMDS) | S3 for its whole cell (below) |
| AWS: control plane | Worker secret | FleetDO | Launch template only; terminate/stop only instances tagged `nest=true`; `kms:Sign` on the proxy root CA key only |
| R2 | DO bindings | Control plane | Hosts use Worker-signed URLs only (no R2 S3 credentials exist) |
| Webhook secrets (`hook:<hk_…>`) | BrokerDO | Control plane only | BrokerDO verifies signatures itself; brokered actions send the secret straight to the provider |
| MCP server and API credentials (`cap:<name>`) | BrokerDO | Control plane only | One per `mcp` or `api` capability; attached per call |
| api-loop API key (deferred) | BrokerDO | Control plane only | For the `api-loop` backend, once the API credits are picked up |
| Cloudflare Analytics read token | BrokerDO (`cap:metrics`) | Control plane only | Account Analytics Read only; see [metrics](../../control-plane/metrics/) |

**S3 access is a cell-wide host role, not per-sandbox STS credentials.** Hosts are trusted and fenced, and nest has a single owner, so there's no tenant to isolate from another. Per-sandbox credentials would gain nothing if the host minted them (it would still hold the cell role), and the control plane deliberately holds no S3 access to mint them with.

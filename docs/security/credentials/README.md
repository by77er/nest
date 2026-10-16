# Credentials inventory

| Credential | Stored | Seen by | Notes |
|---|---|---|---|
| Claude setup token (subscription OAuth, 1 year, model requests only) | BrokerDO | Claude Code process env on hosts, **never a VM** | Separate named tokens per template, e.g. captains vs workers (to verify that they're independent and revocable) |
| GitHub App private key | BrokerDO | Control plane | Mints installation tokens per binding (1 hour, narrowed to the binding's repos and permissions); every mint is audited; see [BrokerDO](../../control-plane/durable-objects/broker/) |
| GitHub installation tokens | nest-proxy memory | Proxy only | Injected by placeholder, on the binding's exact hosts, methods and path |
| Other injected secrets | BrokerDO → nest-proxy memory | Proxy only | Per host and grant. Pushed with the policy hash; the proxy refuses one whose binding isn't in the installed policy. Every push and refusal is audited |
| Brokered-action secrets (email, …) | BrokerDO | Never a VM | Executed outside the VM |
| Proxy root CA key | AWS KMS (`ECC_NIST_P256`, non-exportable) | Nobody: FleetDO calls `kms:Sign` | Signs per-host intermediates at enrollment and renewal; CloudTrail logs each issuance; the root certificate is in the image. See [tls](../../sandbox/networking/egress/tls/) |
| Per-host intermediate CA (~7 days, pathLen 0) | nest-proxy memory; the key is generated on the host | Proxy | Signs leaf certificates (≤ 24 h) on the fly |
| OIDC signing key (deferred) | Worker secret | Control plane | JWKS published |
| Host token | FleetDO issues it; nestd and the runner hold it in memory | Host | Obtained with the signed identity document; rotated; void when the [revocation counter](../../control-plane/api/) moves |
| Operator tokens (`observe`, `approve`, `admin`) | SHA-256 hashes only, as a Worker secret | Me (`nest` CLI) | Scoped; header only, never in URLs. See [API](../../control-plane/api/) |
| AWS: host role | Instance profile | nestd (nest-proxy is kernel-blocked from IMDS) | S3 for its whole cell (below) |
| AWS: control plane | Worker secret | FleetDO | Launch template only; terminate/stop only instances tagged `nest=true`; `kms:Sign` on the proxy root CA key only |
| R2 | DO bindings | Control plane | Hosts use Worker-signed URLs only (no R2 S3 credentials exist) |
| Webhook secrets (`hook:<hk_…>`) | BrokerDO | Control plane only | BrokerDO verifies signatures itself; brokered actions send the secret straight to the provider |
| MCP server and API credentials (`cap:<name>`) | BrokerDO | Control plane only | One per `mcp` or `api` capability; attached per call |
| api-loop API key (future) | BrokerDO | Control plane only | |
| Cloudflare Analytics read token | BrokerDO (`cap:metrics`) | Control plane only | Account Analytics Read only; see [metrics](../../control-plane/metrics/) |

**S3 access is a cell-wide host role, not per-sandbox STS credentials.** Hosts are trusted and fenced, and nest has a single owner, so there's no tenant to isolate from another. Per-sandbox credentials would gain nothing if the host minted them (it would still hold the cell role), and the control plane deliberately holds no S3 access to mint them with.

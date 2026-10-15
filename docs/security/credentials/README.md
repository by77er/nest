# Credentials inventory

| Credential | Stored | Seen by | Notes |
|---|---|---|---|
| Claude setup token (subscription OAuth, 1 year, model requests only) | BrokerDO | Claude Code process env on hosts, **never a VM** | Separate named tokens per template, e.g. captains vs workers (to verify that they're independent and revocable) |
| GitHub App private key | BrokerDO | Control plane | Mints installation tokens per binding (1 hour, scoped) |
| GitHub installation tokens | nest-proxy memory | Proxy only | Injected by placeholder |
| Other injected secrets | BrokerDO → nest-proxy memory | Proxy only | Per host and grant |
| Brokered-action secrets (email, …) | BrokerDO | Never a VM | Executed outside the VM |
| Proxy root CA key | Worker secret | Control plane | Signs per-host intermediates at enrollment; the root certificate is in the image |
| Per-host intermediate CA (~7 days) | nest-proxy memory | Proxy | Signs leaf certificates on the fly |
| OIDC signing key (deferred) | Worker secret | Control plane | JWKS published |
| Host token | FleetDO issues it; nestd and the runner hold it in memory | Host | Obtained with the signed identity document; rotated |
| AWS: host role | Instance profile | nestd | S3 for its cell only |
| AWS: control plane | Worker secret | FleetDO | Launch template only; terminate/stop only instances tagged `nest=true` |
| R2 | DO bindings | Control plane | Hosts use Worker-signed URLs only (no R2 S3 credentials exist) |
| Webhook secrets (`hook:<hk_…>`) | BrokerDO | Control plane only | BrokerDO verifies signatures itself; brokered actions send the secret straight to the provider |
| MCP server and API credentials (`cap:<name>`) | BrokerDO | Control plane only | One per `mcp` or `api` capability; attached per call |
| api-loop API key (future) | BrokerDO | Control plane only | |

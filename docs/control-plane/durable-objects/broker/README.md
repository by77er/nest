# BrokerDO

The only DO that stores secret values. Platform keys live elsewhere: the proxy root CA key in AWS KMS, and AWS credentials, the host-token secret and the operator-token hashes as Worker secrets. See [../../../security/credentials/](../../../security/credentials/).

- **References, not values:** other DOs ask BrokerDO for a reference (`$nest-secret:<name>`) and pass that around. FleetDO resolves references when it sends a command to a host. Missing or expired secrets resolve to empty and are logged.
- **Claude setup tokens:** `claude_oauth_token`, plus named ones (`claude_oauth_token:<name>`, e.g. `:captain`) that a spawn spec's `credential` picks. They end up only in the Claude Code process environment on a brain host, never on a sandbox host.
- **Injected secrets:** `inject:<binding>`, sent to nest-proxy for placeholder substitution. Putting a binding in a sandbox's policy needs a grant on it. They're pushed only together with the policy version and sha256 they were resolved for ([injection](../../../sandbox/networking/egress/injection/)).
- **Serving a secret is checked twice.** Before fetching or minting a value for a push, BrokerDO reads the target's state: the sandbox's epoch, its policy version and sha256, and the binding's grant. It reads the same state again once the value is in hand, and **discards the value if anything changed**, so a revocation, fence or policy edit that lands during a slow GitHub call never ships a credential. SPACE does the same ([credential_injection_authority.rs](https://github.com/perplexityai/space/blob/main/crates/libs/credential/mgr/server/src/credential_injection_authority.rs)).
- **Hook secrets:** `hook:<hk_…>` for each [webhook](../../../channels/sources/). BrokerDO verifies signatures itself (`verify(ref, scheme, headers, body)`), so the secret is never returned to anyone after it's created; brokered actions such as `github.create_webhook` send it straight to the provider.
- **Capability credentials:** `cap:<capability>` holds the bearer token or OAuth tokens for an `mcp` or `api` [capability](../../../agents/capabilities/#sources), and `cap:metrics` the Analytics Engine read token. The control plane uses them for each call; they never reach a host or a sandbox.
- **GitHub App:** holds the App's private key and mints installation tokens per binding: a JWT signed with the key, then an access-token request narrowed to the binding's repos and permissions. Tokens last an hour and are cached for 50 minutes. A binding is one use, such as a worker's sandbox injection (push and open PRs) or a reviewer's brokered actions (post a check), so each token carries only what that use needs. Designed; the code has an interface only.
- **The Access service token** (`access:gateway`) that fronts the sandbox hosts' tunnel hostnames: pushed to brain hosts for the runner, used by the Worker and AgentDO, and minted into a `nest` login for my laptop. Never a sandbox ([gateway](../../../sandbox/gateway/)).
- **The api-loop API key** (deferred), used only inside the control plane.

The Cloudflare API token that creates and deletes per-host tunnels and DNS records is a Worker secret, like the other platform keys, not a BrokerDO secret.

## Issuance audit

Every installation-token mint, every secret push to a host and every refusal is written to R2 with the audit log. A record holds the binding, repos, permissions, expiry, the target `(sandbox, epoch)`, the caller (the DO or principal that asked) and, for a refusal, the reason. **Never a value.**

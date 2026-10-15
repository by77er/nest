# BrokerDO

The only DO that stores secret values. Platform keys (the root CA key, AWS credentials, the host-token and admin secrets) are Worker secrets. See [../../../security/credentials/](../../../security/credentials/).

- **References, not values:** other DOs ask BrokerDO for a reference (`$nest-secret:<name>`) and pass that around. FleetDO resolves references when it sends a command to a host. Missing or expired secrets resolve to empty and are logged.
- **Claude setup tokens:** `claude_oauth_token`, plus named ones (`claude_oauth_token:<name>`, e.g. `:captain`) that a spawn spec's `credential` picks. They end up only in the Claude Code process environment on the host.
- **Injected secrets:** `inject:<binding>`, sent to nest-proxy for placeholder substitution. Putting a binding in a sandbox's policy needs a grant on it.
- **Hook secrets:** `hook:<hk_…>` for each [webhook](../../../channels/sources/). BrokerDO verifies signatures itself (`verify(ref, scheme, headers, body)`), so the secret is never returned to anyone after it's created; brokered actions such as `github.create_webhook` send it straight to the provider.
- **Capability credentials:** `cap:<capability>` holds the bearer token or OAuth tokens for an `mcp` or `api` [capability](../../../agents/capabilities/#sources), and `cap:metrics` the Analytics Engine read token. The control plane uses them for each call; they never reach a host or a sandbox.
- **GitHub App:** holds the App's private key and mints installation tokens per binding: a JWT signed with the key, then an access-token request narrowed to the binding's repos and permissions. Tokens last an hour and are cached for 50 minutes. A binding is one use, such as a worker's sandbox injection (push and open PRs) or a reviewer's brokered actions (post a check), so each token carries only what that use needs. Designed; the code has an interface only.
- **The api-loop API key** (future), used only inside the control plane.

# BrokerDO

The only place secret values are stored. See [../../../security/credentials/](../../../security/credentials/).

- **References, not values:** other DOs ask BrokerDO for a reference (`$nest-secret:<name>`) and pass that around. FleetDO resolves references when it sends a command to a host. Missing or expired secrets resolve to empty and are logged.
- **Claude setup tokens:** `claude_oauth_token`, plus named ones (`claude_oauth_token:<name>`, e.g. `:captain`) that a spawn spec's `credential` picks. They end up only in the Claude Code process environment on the host.
- **Injected secrets:** `inject:<binding>`, sent to nest-proxy for placeholder substitution. Putting a binding in a sandbox's policy needs a grant on it.
- **Hook secrets:** `hook:<hk_…>` for each [webhook](../../../channels/sources/). BrokerDO verifies signatures itself (`verify(ref, scheme, headers, body)`), so the secret is never returned to anyone after it's created; brokered actions such as `github.create_webhook` send it straight to the provider.
- **Capability credentials:** `cap:<capability>` holds the bearer token or OAuth tokens for an `mcp` or `api` [capability](../../../agents/capabilities/#sources). The control plane uses them for each call; they never reach a host or a sandbox.
- **GitHub App:** would mint installation tokens per binding (1 hour, scoped to the repos and permissions in the binding). It's an interface only for now.
- **The api-loop API key** (future), used only inside the control plane.

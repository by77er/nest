# BrokerDO

The only place secret values are stored. See [../../../security/credentials/](../../../security/credentials/).

- **References, not values:** other DOs ask BrokerDO for a reference (`$nest-secret:<name>`) and pass that around. FleetDO resolves references when it sends a command to a host. Missing or expired secrets resolve to empty and are logged.
- **Claude setup tokens:** `claude_oauth_token`, with per-role overrides `claude_oauth_token:worker` and `claude_oauth_token:captain`. They end up only in the Claude Code process environment on the host.
- **Injected secrets:** `inject:<binding>`, or a workstream-scoped `inject:<binding>:<workstream>`, sent to nest-proxy for placeholder substitution.
- **GitHub App:** would mint installation tokens per workstream (1 hour, scoped). It's an interface only for now.
- **The api-loop captain API key** (future), used only inside the control plane.

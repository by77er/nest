# Controller host

A small, always-on, **stateless** host. It runs no sandboxes.

**What it runs:**
- **nestd** without sandbox networking: the fleet channel, the host's lease, and commands to the runner.
- **The agent runner, for agents without hands** (captains, for example). See [claude-code backend](../../agents/backends/claude-code/).
- **nest-mcp:** platform tools proxied to AgentDO.
- **Discord Gateway client:** free-form messages.

**Size:** about 2 vCPU / 4 GB. No KVM, no hugepages, no S3 access. An AWS `t4g.medium` (~$25/mo) or any cheap VPS (ARM is fine).

**Stateless:**
- Session files are rebuilt from R2.
- Setup tokens come from BrokerDO.
- It authenticates like any host: a signed identity document on AWS, or a one-time enrollment token elsewhere.

**If it goes down:**
- Turns for its agents queue in the DOs.
- Discord buttons and slash commands keep working, because they're served by the Worker.
- After 30 s of silence, FleetDO restarts its agents on another connected controller host, or on this one once it reconnects. See [FleetDO](../../control-plane/durable-objects/fleet/).
- Launching a replacement host needs the autoscaler, which isn't built.

If agents without hands move to the [api-loop backend](../../agents/backends/api-loop/), the controller host is needed only for the Discord Gateway, and it can be removed entirely if Discord switches to interactions-only.

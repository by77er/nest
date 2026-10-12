# Controller host

A small, always-on, **stateless** host. It runs no sandboxes.

**What it runs:**
- **The agent runner, for captains:** brains with no hands. See [claude-code backend](../../orchestration/captains/backends/claude-code/).
- **nest-mcp:** platform tools proxied to AgentDO.
- **Discord Gateway client:** free-form messages.

**Size:** about 2 vCPU / 4 GB. No KVM, no hugepages, no S3 access. An AWS `t4g.medium` (~$25/mo) or any cheap VPS (ARM is fine).

**Stateless:**
- Session files are rebuilt from R2.
- Setup tokens come from BrokerDO.
- It authenticates like any host: a signed identity document on AWS, or a one-time enrollment token elsewhere.

**If it goes down:**
- Captain turns queue in the DOs.
- Discord buttons and slash commands keep working, because they're served by the Worker.
- FleetDO starts a replacement anywhere.

If captains move to the [api-loop backend](../../orchestration/captains/backends/api-loop/), the controller host is needed only for the Discord Gateway, and it can be removed entirely if Discord switches to interactions-only.

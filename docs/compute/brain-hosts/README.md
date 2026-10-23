# Brain hosts

The hosts that run brains: small, stateless, and never the machine a sandbox runs on. A brain reaches its sandbox only over the network, through the sandbox's [gateway](../../sandbox/gateway/), so a brain host needs nothing a sandbox host needs, and nothing about a brain's placement depends on where its sandbox is.

**What it runs:**
- **nestd** with supervisor duties only: enrollment, the fleet channel and the host's lease, command delivery to the runner, self-fencing. No sandbox networking, no drivers ([nestd](../nestd/)).
- **The agent runner** and one unmodified Claude Code process per active agent, with or without hands ([runner](../../agents/runner/), [claude-code backend](../../agents/backends/claude-code/)). An agent without hands (the `captain` template, for example) is a brain here like any other.
- **`nest mcp`:** hands to the sandbox's gateway, platform tools to AgentDO.
- **The Discord gateway client,** a singleton service FleetDO places on one brain host and places again when that host goes ([Discord](../../control-plane/api/discord/)).

**What it never has:** KVM, hugepages, S3 access, sandboxes, Firecracker, a gateway or a tunnel. The subscription token lives only here, in each brain's process environment ([credentials](../../security/credentials/)).

**Kind and capacity:** `kind: brain` in FleetDO, which counts its capacity in brains, not hugepages. Its `hello` and `capacity` carry no restore ABIs. See [FleetDO](../../control-plane/durable-objects/fleet/).

**Placement:** AgentDO places a `claude-code` brain on any brain host with capacity, preferring the host that ran the agent last, whose session file is still on disk: a preference, not a rule ([AgentDO](../../control-plane/durable-objects/agent/)). An `api-loop` brain runs inside AgentDO and needs no host.

**Size:** the cheapest instance class that runs Claude Code, about 2 vCPU / 4 GB; ARM is fine. An AWS `t4g.medium`-class instance is about $25/mo on demand, spot where available, or any cheap VPS.

**Stateless:**
- Session files are rebuilt from R2 at each brain start; the warm-host preference only makes `--resume` faster.
- Setup tokens come from BrokerDO, into the brain's process environment and nowhere else.
- The gateway binding a brain holds comes from AgentDO in `agent_start` and is renewed through it ([runner](../../agents/runner/)).
- It authenticates like any host: a signed identity document on AWS, or a one-time enrollment token elsewhere ([provisioning](../provisioning/)).

**Egress:** Anthropic's hosts (every host Claude Code contacts), the control plane, the sandbox hosts' gateway hostnames, and WebFetch through the host allowlist. Nothing is decrypted.

**Lease and the agent epoch:** nestd heartbeats to FleetDO every 5 s. When the lease lapses locally, 20 s after the renewal it sent, nestd stops the runner's brains. At 30 s of silence FleetDO expires the host, and AgentDO expires the agent epoch of every brain on it; each brain starts again on another brain host with `--resume`, or on this one once it reconnects. No STONITH is needed: a brain host holds no sandbox, so nothing on it can run twice, and only an agent's assigned host may attach its session channel ([FleetDO](../../control-plane/durable-objects/fleet/)). Its agents' sandboxes notice nothing: an open hands call is cancelled by the hangup, and the recovery context comes from `call_status` through the gateway ([hands](../../agents/hands/)).

**Idle:** a brain exits after 120 s idle ([runner](../../agents/runner/)); a host with no brain for 30 min is terminated, so an idle fleet costs nothing ([autoscaling](../autoscaling/)). Turns that arrive meanwhile queue in the DOs, and a host launches for them.

**Image:** nestd, the agent runner, the `nest` binary, bubblewrap, the Discord gateway client, and the runner's pinned Claude Code version, checked by SHA-256. No hypervisor, no hugepages ([provisioning](../provisioning/)). In every release, brain hosts roll out before sandbox hosts ([upgrades](../provisioning/#upgrades)).

**If one goes down:** turns for its agents queue; Discord buttons and slash commands keep working, because the Worker serves them; the brains start elsewhere after 30 s, and the Discord gateway client is placed again.

**Not built:** brain hosts. The code has `burst` and `controller` host roles, FleetDO's `controllerHost()` picks a `controller` host for captains, and the runner reaches the guest over vsock on the sandbox's host; `control-plane/README.md` lists the gaps.

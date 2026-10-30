# Brain hosts

The hosts that run brains: small, stateless, and never the machine a sandbox runs on. A brain reaches its sandbox only over the network, through the sandbox's [gateway](../../sandbox/gateway/), so a brain host needs nothing a sandbox host needs, and nothing about a brain's placement depends on where its sandbox is.

**What it runs:**
- **nestd** with supervisor duties only: enrollment, the fleet channel and the host's lease, command delivery to the runner, self-fencing. No drivers, KVM or hugepage checks, sandbox networking, proxy, gateway, tunnel or object store; it refuses every sandbox command ([nestd](../nestd/)).
- **The agent runner** and one unmodified Claude Code process per active agent, with or without hands ([runner](../../agents/runner/), [claude-code backend](../../agents/backends/claude-code/)). An agent without hands (the `captain` template, for example) is a brain here like any other.
- **`nest mcp`:** hands to the sandbox's gateway, platform tools to AgentDO.
- **The Discord gateway client,** a singleton service FleetDO places on one brain host and places again when that host goes ([Discord](../../control-plane/api/discord/)). Not built.

**What it never has:** KVM, hugepages, S3 access, sandboxes, Firecracker, a gateway or a tunnel. The subscription token lives only here, in each brain's process environment ([credentials](../../security/credentials/)).

**Kind and capacity:** `role: brain` in FleetDO (the previous release's `controller`, read as `brain` for one release), which counts its capacity in brains, not hugepages: `brain.max_brains_per_host` from the cell's `AWS_CELLS` entry, or 2 per vCPU the host reports when unset (0). The brains counted are FleetDO's brain index for the host (started and not yet proven exited), so a brain being killed still holds its place. The cap is soft: placement is a query, so two starts racing may both take a host's last slot. Its `hello` and `capacity` carry no restore ABIs. See [FleetDO](../../control-plane/durable-objects/fleet/).

**Placement:** AgentDO places a `claude-code` brain on a brain host with room, preferring the host that ran the agent last, whose session file is still on disk: a preference, not a rule ([AgentDO](../../control-plane/durable-objects/agent/)). Otherwise the fullest brain host with room (then the smallest id), so idle ones empty out. Never a sandbox host, a host of the previous release, a wedged one or the one a move avoids; an operator's hint must name an active, connected brain host. With none, the start waits (its intent kept, retried every 30 s) and FleetDO launches a brain host. The decision is a pure function (`pickBrainHost` in `control-plane/src/lib/placement.ts`, unit- and property-tested); FleetDO's `placeBrain` only gathers its inputs. An `api-loop` brain runs inside AgentDO and needs no host.

**Size:** the cheapest instance class that runs Claude Code, about 2 vCPU / 4 GB. On AWS, `t3a.medium` then `t3.medium` (x86, because both kinds boot the one x86 host AMI; standard CPU credits, so a burstable type never bills for surplus), spot then on demand; about $27/mo on demand (unverified). Any cheap VPS works with an enrollment token.

**Stateless:**
- Session files are rebuilt from R2 at each brain start; the warm-host preference only makes `--resume` faster.
- Setup tokens come from BrokerDO, into the brain's process environment and nowhere else.
- The gateway binding a brain holds comes from AgentDO in `agent_start` and is renewed through it ([runner](../../agents/runner/)).
- It authenticates like any host: a signed identity document on AWS, or a one-time enrollment token elsewhere ([provisioning](../provisioning/)).

**Egress:** Anthropic's hosts (every host Claude Code contacts), the control plane, the sandbox hosts' gateway hostnames, and WebFetch through the host allowlist. Nothing is decrypted. On AWS its own security group allows TCP 443 out and nothing in (no 7844: no tunnel); its instance role has no permissions at all (no bucket access). The cell stack's policies check both ([provisioning](../provisioning/)).

**Lease and the agent epoch:** nestd heartbeats to FleetDO every 5 s. When the lease lapses locally, 20 s after the renewal it sent, nestd stops the runner's brains. At 30 s of silence FleetDO expires the host, and AgentDO releases the brain record of every brain on it; each brain starts again on another brain host with `--resume`, or on this one once it reconnects. No STONITH is needed (except for a host reported wedged, whose brains are released only once its death is confirmed): a brain host holds no sandbox, so nothing on it can run twice, and only a brain record's host may attach its session channel ([FleetDO](../../control-plane/durable-objects/fleet/), [AgentDO](../../control-plane/durable-objects/agent/)). Its agents' sandboxes notice nothing: an open hands call is cancelled by the hangup, and the recovery context comes from `call_status` through the gateway ([hands](../../agents/hands/)).

**Idle:** a brain exits after 120 s idle ([runner](../../agents/runner/)); a launched host with no brain for `brain.idle_grace_ms` (30 min) is terminated, so an idle fleet costs nothing ([autoscaling](../autoscaling/)). Turns that arrive meanwhile queue in the DOs, and a host launches for them (from the cell's brain launch template, up to `brain.max_hosts`).

**Image:** the one host AMI, the same as sandbox hosts', which already holds nestd, the agent runner, the `nest` binary, bubblewrap and the runner's pinned Claude Code version; the brain launch template's user data writes `role: brain`, masks the sandbox services and starts nestd and the runner. With no bucket access it can't install a release at boot, so an AMI without one never enrolls (FleetDO terminates it at the enroll timeout) ([provisioning](../provisioning/#host-kind)). In every release, brain hosts roll out before sandbox hosts ([upgrades](../provisioning/#upgrades)).

**If one goes down:** turns for its agents queue; Discord buttons and slash commands keep working, because the Worker serves them; the brains start elsewhere after 30 s, and the Discord gateway client is placed again.

**Built** as above, and run on the harness as two hosts (`e2e/`); not yet run on AWS. **Not built:** the Discord gateway client, gentle drains for upgrades, and the desired brain-host version.

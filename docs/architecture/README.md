# Architecture

nest is two systems with one seam between them:
- **The sandbox system runs machines.** Sandbox hosts (spot, KVM) run Firecracker VMs, and each host's **gateway** is the one network door into its sandboxes. SandboxDO and FleetDO hold its state.
- **The agent system runs loops.** Brain hosts (cheap, no KVM) run unmodified Claude Code processes; AgentDO and the channels hold its state. A brain never shares a machine with a sandbox.
- **A control plane on Cloudflare** holds every piece of authoritative state for both and makes every decision.

Neither system knows where the other runs. A brain reaches a sandbox only through the seam, by hostname and binding, over the network. Nothing durable lives on a host; hosts can vanish at any time.

> This is the design. **Built:** the gateway, bindings and per-host tunnels (verified on AWS on 2026-10-23, with Access in front on 2026-10-24: spike item 13); brain hosts, so every brain starts on a brain host, never on a sandbox host, and reaches the guest only through its gateway (on AWS since 2026-10-29); templates and capabilities as data in CatalogDO, with nothing deciding on an agent role. **Not built:** the coordination layer (ChannelDO, HookDO, grants, taint, `wake_at`; WorkstreamDO stands in for the workstream channel), the Discord bot, memory snapshots, the hands journal's `call_status`, the 60 s dirty-disk commit and desired host versions. `control-plane/README.md` lists the gaps.

## At a glance

```
         me: Discord · API · nest CLI              external senders: GitHub, email, …
                     │                                          │
                     ▼                                          ▼
┌────────────────────── Cloudflare control plane (authoritative) ──────────────────────┐
│ Worker: API · webhook route · Discord interactions · signed blob URLs (stateless)     │
│ Durable Objects, one writer per entity:                                               │
│  FleetDO (per cell) · SandboxDO · AgentDO · ChannelDO · HookDO · BrokerDO · CatalogDO │
│ R2: session transcripts · large and older channel messages · audit                   │
└────────────▲──────────────────────────────────────────────────▲──────────────────────┘
             │ WebSockets that hosts dial out:                  │
             │ fleet channel per host · session per brain       │ fleet channel per host
┌────────────┴─────── agent system ──────────┐    ┌────────────┴────── sandbox system ──────────────┐
│ brain host (cheap, no KVM, scales to zero) │    │ sandbox host (spot, KVM, scales to zero)         │
│  nestd · agent runner · Claude Code        │    │  nestd ── Firecracker VMs (sandboxes)            │
│   nest mcp → hands client ─────────────────┼────┼─► cloudflared → gateway ─ vsock ─► guest agent  │
│   the subscription token lives only here   │    │  nest-proxy: every byte of sandbox egress        │
│  Discord gateway client (one brain host)   │    │  (hands, PTY and ingress: one door, a binding)   │
└────────────────────────────────────────────┘    └──────────────────────────┬───────────────────────┘
      the seam: SandboxDO control API · hands over the tunnel · events on channels
                                                                             ▼
                                                              S3 (per cell): disk and memory chunks
```

## Components

| Component | Runs on | Does | Doc |
|---|---|---|---|
| **Worker** | Cloudflare | HTTP API, webhook route, Discord interactions, signed blob URLs, tunnel and DNS records per sandbox host. Stateless; routes to DOs. | [control-plane/api/](../control-plane/api/) |
| **FleetDO** | Cloudflare, one per cell | Hosts of both kinds, enrollment, leases, placement and autoscaling, STONITH, ordered command delivery, the binding public keys pushed to gateways; three desired versions per cell (designed) | [fleet/](../control-plane/durable-objects/fleet/) |
| **SandboxDO** | Cloudflare, one per sandbox | Epoch, generation head (compare-and-set commits), egress policy, attached clients; issues bindings and answers `resolve` | [sandbox/](../control-plane/durable-objects/sandbox/) |
| **AgentDO** | Cloudflare, one per agent | Spawn spec (capabilities, grants, budget), turn queue, session stream, taint, scheduled wakes, tool relay, the agent epoch, brain placement | [agent/](../control-plane/durable-objects/agent/) |
| **ChannelDO** | Cloudflare, one per channel | Message log, keyed view, subscriptions, fan-out | [channel/](../control-plane/durable-objects/channel/) |
| **HookDO** | Cloudflare, one per webhook | Verification (through BrokerDO), mapping, dedup, posting | [hook/](../control-plane/durable-objects/hook/) |
| **BrokerDO** | Cloudflare, one | The only DO that stores secret values: setup tokens, injection secrets, hook and capability credentials, the Access service token. Platform keys (AWS, the host-token secret, operator-token hashes, the revocation counter, the Cloudflare Tunnel API token) are Worker secrets; the proxy root CA key is in AWS KMS | [broker/](../control-plane/durable-objects/broker/) |
| **CatalogDO** | Cloudflare, one | Templates and capabilities, as data I edit; expands spawn specs | [catalog/](../control-plane/durable-objects/catalog/) |
| **nestd** | Every host | Enrollment, the lease, command delivery, self-fencing. On sandbox hosts: runs sandboxes, builds their network namespaces, launches cloudflared and the gateway, commits sandbox state to S3. On brain hosts: supervises the runner | [compute/nestd/](../compute/nestd/) |
| **nest-proxy** | Sandbox hosts | All sandbox egress: allowlist, TLS inspection, credential injection by placeholder, audit | [egress/](../sandbox/networking/egress/) |
| **Gateway** | Sandbox hosts | The one door into a sandbox: checks the binding, pins `(sandbox, epoch)`, forwards hands, terminal and ingress connections to the guest over vsock | [sandbox/gateway/](../sandbox/gateway/) |
| **cloudflared** | Sandbox hosts | Dials Cloudflare outbound and carries the host's tunnel hostname to the gateway; no inbound ports | [sandbox/gateway/](../sandbox/gateway/) |
| **Agent runner** | Brain hosts | Starts and drives unmodified Claude Code, tails its session, answers hooks locally, bridges MCP, carries hands calls to the gateway | [agents/runner/](../agents/runner/) |
| **Claude Code** | Brain hosts, one process per active agent | The brain. No local exec or file tools; everything goes through `nest` MCP tools | [agents/](../agents/) |
| **`nest mcp`** | Spawned by Claude Code | Stdio MCP bridge from Claude Code to the runner | [agents/tools/](../agents/tools/) |
| **Discord gateway client** | One brain host, placed by FleetDO | Free-form Discord messages | [control-plane/api/discord/](../control-plane/api/discord/) |
| **Guest agent** | Inside each VM | The hands server (`Bash`, `Read`, `Write`, …), port watching, the in-sandbox `nest` CLI | [sandbox/guest-agent/](../sandbox/guest-agent/) |

## The seam

Three things cross between the systems, and nothing else:
1. **The SandboxDO control API:** `create`, `fork`, `pause`, `suspend`, `resume`, `archive`, `destroy`, `attach`, `detach`, `resolve`, `expose_port`, `egress_policy`, `checkpoint`. `attach` issues a **binding** (a signed token naming the sandbox, its epoch, the client, a scope and an expiry); `resolve` returns the host's tunnel hostname, a renewed binding, and the guest's protocol version and capabilities.
2. **The hands data plane on the gateway:** one WebSocket per call to the host's tunnel hostname, the binding first, then the host-guest hands frames verbatim. Cancel is a close. Terminals (`/pty`) and ingress (`/ingress/<port>`) are the same kind of connection. A person's `nest` CLI is a client like any brain.
3. **The sandbox's events** on `<sbx>/events`: ports, task exits, egress denials, loss records.

The contract is in [interfaces/gateway/](../interfaces/gateway/). Any runner can drive any sandbox: a brain host in the cell, one in another cell, or (later) the `api-loop` inside AgentDO.

## A turn, end to end

1. **Something happens.** A webhook arrives (HookDO verifies it and posts to a channel), another agent or I post, or a scheduled `wake_at` comes due. ChannelDO delivers it to the agent's AgentDO.
2. **Placing the brain.** AgentDO queues the turn and, if no brain is running, picks a runner by backend and capacity: for `claude-code`, a brain host with room, preferring the one that ran the agent last. FleetDO sends `agent_start`, and the runner rebuilds the session from R2 and starts Claude Code, resumed or fresh (see [continuity](../agents/#continuity)).
3. **Reaching the hands.** If the agent has hands, AgentDO makes sure the sandbox is running (a suspended one is resumed, an archived one placed and restored by the [activator](../control-plane/activator/)), attaches the agent through SandboxDO, and gives the runner the sandbox host's hostname, the binding and the guest's version. The runner renews or re-resolves through AgentDO when a binding ages or a connection is refused.
4. **The turn.** AgentDO sends a [wake envelope](../channels/#the-wake-envelope): a notice of what arrived, not the bodies. Claude Code reads the bodies with `read`; messages from me arrive inline.
5. **Hands.** `mcp__nest__Bash` goes Claude Code → `nest mcp` → runner → hands client → one WebSocket to the gateway (binding first) → vsock → guest agent, which runs it as the sandbox user and keeps a call record. Results come back the same way. Platform tools (`post`, `agent_spawn`, `wake_at`, brokered actions, MCP or API capability tools) go runner → AgentDO, which checks the grant and the session's [taint](../agents/tools/#taint-and-sinks).
6. **Egress and durability.** Processes in the VM reach the network only through nest-proxy, which allows listed hosts and injects credentials by placeholder. The session streams from the brain host to AgentDO and R2 (acked once in SQLite; flushed at 1 MiB, at turn end, after 30 s idle and before any start). nestd commits the sandbox disk to S3 from the sandbox host at turn ends (at most every 10 s), every 60 s while dirty, and on pause and suspend, each after the guest's `syncfs`; the head moves by compare-and-set in SandboxDO. The two never touch.
7. **After.** `turn_completed` is posted to the agent's `events`, which its spawner subscribes to. An idle brain exits after 120 s. A sandbox with no agent mid-turn, no live ingress and no hold pauses after 1 minute and suspends after 10 more. An idle brain host and an idle sandbox host drain and terminate independently.

## When things fail

| Failure | What happens |
|---|---|
| Brain crash | AgentDO restarts it with `--resume`; the recovery context asks the guest for each in-flight hands call's outcome (`call_status` through the gateway) and the files changed since. Three crashes without a completed turn, and it waits for new input |
| Wedged host (processes no commands, or a killed brain outlives its kill) | nestd first drops its runner connection, killing that host's brains. If that doesn't end them, AgentDO reports the host wedged: FleetDO cuts it off, places nothing on it, and sends it to STONITH; its brains restart elsewhere only once its death is confirmed (an operator's confirm-dead in a cell without EC2), and its sandboxes are placed again from their heads |
| Brain host loss | Heartbeats stop. The runner kills its brains at 20 s; at 30 s FleetDO expires the host, AgentDO releases each brain record and starts each brain on another brain host with `--resume`. Open hands connections drop, so the gateway cancels those calls in the guest. The sandbox is untouched: no pause, no fence, no loss record |
| Sandbox host loss | The host self-fences at 20 s (pauses VMs); at 30 s FleetDO expires its leases and terminates the instance (STONITH), then each sandbox records its loss and is claimed again under a new epoch, restoring from its last committed generation. Every binding for the old epoch is dead; the brain survives, its next call is refused, it re-resolves, and its next tool result says the sandbox moved and what was lost |
| Network partition between a brain and its sandbox | After 30 s without a frame the runner reports the call's outcome unknown; the gateway sees the dropped connection and cancels the call in the guest. Long work belongs in background tasks |
| Cloudflare edge or tunnel outage | Every hands path is down: new calls fail, open calls are cancelled. Sandboxes keep running and brains wait |
| Control-plane restart or deploy | Hosts reconnect with jittered backoff; reliable channels resend in order from the last ack. Bindings keep working until they expire (about an hour), so a turn in flight continues as long as the tunnel is up |
| Gateway crash | nestd restarts it. Open calls are cancelled; bindings are unaffected, since they are verified, not stored |
| Spot notice | Every sandbox's disk is cut first, then memory snapshots in order of recent activity, within the 2-minute warning |
| Stale host comes back | Its epochs are fenced; uncommitted work is offered as an orphaned sibling generation. A stale brain's platform calls are rejected by its agent epoch |

Details: [sandbox/fencing/](../sandbox/fencing/), [sandbox/gateway/](../sandbox/gateway/), [sandbox/state/](../sandbox/state/), [agents/sessions/](../agents/sessions/).

## Where state lives

| State | Store | Written by |
|---|---|---|
| Entity metadata: leases, epochs, agent epochs, generation heads, spawn specs, grants, taint, turns, subscriptions, channel indexes and recent messages, tunnel ids per sandbox host, the three desired versions per cell | DO SQLite | The entity's own DO |
| Session transcripts | DO SQLite until flushed, then R2 | AgentDO |
| Large and older channel bodies, audit logs | R2 | ChannelDO, FleetDO |
| Sandbox disk and memory chunks, manifests | S3, per cell | nestd; the head moves only through SandboxDO |
| Secrets | BrokerDO (platform keys: Worker secrets) | Me, or minted by BrokerDO |
| The binding key | BrokerDO (private, per cell; it signs); FleetDO pushes the public keys to each sandbox host's gateway over the fleet channel | BrokerDO |
| Runtime metrics | Workers Analytics Engine | The Worker and DOs; hosts' through FleetDO ([metrics](../control-plane/metrics/)) |

Bindings themselves are verified, never stored. Hosts hold only caches: page cache, NVMe chunk caches, local session files on brain hosts. See [data/](../data/).

## Trust boundaries

| Boundary | Holds | Guarantee |
|---|---|---|
| Sandbox VM | Code and data being worked on | Untrusted. No credentials; egress only through nest-proxy. The only isolation primitive is a fork |
| Gateway | The binding key | The only way into a guest's hands or ingress ports. Nothing is admitted without a binding SandboxDO issued, and the guest checks the epoch again |
| Sandbox host | nestd, nest-proxy, cloudflared, the gateway, VMs | Trusted but fenced by leases, epochs and STONITH. Holds no subscription token and runs no brain |
| Brain | The subscription token, in its process environment | No local exec or file tools; repo config never loads. It acts only through `nest` tools and the web built-ins (host-allowlisted, tainting) |
| Brain host | Brains, session file caches | Trusted but fenced by its lease and the agent epoch. No KVM, no sandbox state; in S3 it may read the release (`releases/*`) only |
| Control plane | All authority | Every platform tool call is checked against grants and taint here; hands calls are gated by the runner's local policy cache, pushed from AgentDO, and by the binding |
| External input | Webhooks, web pages, other agents' posts | Tainted; its content reaches models only as tool results |

See [security/](../security/).

# Architecture

nest is two systems with one seam between them:
- **The sandbox system runs machines.** Sandbox hosts (spot, KVM) run Firecracker VMs, and each host's **gateway** is the one network door into its sandboxes. SandboxDO and FleetDO hold its state.
- **The agent system runs loops.** Brain hosts (cheap, no KVM) run unmodified Claude Code processes; AgentDO holds its state. A brain never shares a machine with a sandbox.
- **A control plane on Cloudflare** holds every piece of authoritative state for both and makes every decision.

Neither system knows where the other runs. A brain reaches a sandbox only through the seam, by hostname and binding, over the network. Nothing durable lives on a host; hosts can vanish at any time.

> **Microkernel (decided 2026-11-02):** coordination is not the platform's. Shared logs, boards and messaging are external apps that agents reach over MCP and that drive agents through the public API as [API clients](../control-plane/api/clients/) ([principle 9](../README.md#principles)); the kernel keeps sandboxes, agents (spawning, ownership, lifecycle), the credential broker, egress policy, MCP tool attachment, approvals, and scoped API clients with labels and events to the owner.

> This is the design. **Built:** the gateway, bindings and per-host tunnels (verified on AWS on 2026-10-23, with Access in front on 2026-10-24: spike item 13); brain hosts, so every brain starts on a brain host, never on a sandbox host, and reaches the guest only through its gateway (on AWS since 2026-10-29); templates and capabilities as data in CatalogDO, with nothing deciding on an agent role; spawning and lifetimes; transcript grants; agent timers; remote MCP and brokered capabilities; API clients with webhook events and live traces. **Not built:** grants beyond transcript grants, taint beyond a conservative stand-in, `wake_at`, memory snapshots, the hands journal's `call_status` and the 30 s silence rule, the pause tier, fork and archive, the gateway's terminal and ingress routes, the 60 s dirty-disk commit, runtime metrics and desired host versions. `control-plane/README.md` lists the gaps.

## At a glance

```
               me: API · nest CLI       external apps: API in · webhooks, MCP calls out
                     │                                          │
                     ▼                                          ↕
┌────────────────────── Cloudflare control plane (authoritative) ──────────────────────┐
│ Worker: API · OAuth callback · signed blob URLs (stateless)                          │
│ Durable Objects, one writer per entity:                                              │
│  FleetDO (per cell) · SandboxDO · AgentDO · BrokerDO · CatalogDO ·                   │
│  McpConnectorDO · ClientDO                                                           │
│ R2: session transcripts · audit                                                      │
└────────────▲──────────────────────────────────────────────────▲──────────────────────┘
             │ WebSockets that hosts dial out:                  │
             │ fleet channel per host · session per brain       │ fleet channel per host
┌────────────┴─────── agent system ──────────┐    ┌────────────┴────── sandbox system ──────────────┐
│ brain host (cheap, no KVM, scales to zero) │    │ sandbox host (spot, KVM, scales to zero)         │
│  nestd · agent runner · Claude Code        │    │  nestd ── Firecracker VMs (sandboxes)            │
│   nest mcp → hands client ─────────────────┼────┼─► cloudflared → gateway ─ vsock ─► guest agent  │
│   the subscription token lives only here   │    │  nest-proxy: every byte of sandbox egress        │
│                                            │    │  (hands, PTY and ingress: one door, a binding)   │
└────────────────────────────────────────────┘    └──────────────────────────┬───────────────────────┘
      the seam: SandboxDO control API · hands over the tunnel
                                                                             ▼
                                                              S3 (per cell): disk and memory chunks
```

## Components

| Component | Runs on | Does | Doc |
|---|---|---|---|
| **Worker** | Cloudflare | HTTP API (operator and API clients), the MCP OAuth callback, signed blob URLs. Stateless; routes to DOs. | [control-plane/api/](../control-plane/api/) |
| **FleetDO** | Cloudflare, one per cell | Hosts of both kinds, enrollment, leases, placement and autoscaling, STONITH, ordered command delivery, the tunnel and DNS record per sandbox host, the binding public keys pushed to gateways; three desired versions per cell (designed) | [fleet/](../control-plane/durable-objects/fleet/) |
| **SandboxDO** | Cloudflare, one per sandbox | Epoch, generation head (compare-and-set commits), egress policy, attached clients; issues bindings and answers `resolve` | [sandbox/](../control-plane/durable-objects/sandbox/) |
| **AgentDO** | Cloudflare, one per agent | Spawn spec (capabilities, grants; budget designed), owner, turn queue and inbox, session stream, taint, open asks, timers, repeating wakes (designed), tool relay (MCP client, brokered actions), the agent epoch, brain placement, its client's event outbox | [agent/](../control-plane/durable-objects/agent/) |
| **BrokerDO** | Cloudflare, one | The only DO that stores secret values: setup tokens, injection secrets, capability credentials, the Access service token. Platform keys (per-cell AWS credentials, the host-token secret, the admin token, the Cloudflare Tunnel API token; operator-token hashes and the revocation counter are designed) are Worker secrets; the proxy root CA key is in the cell's AWS KMS key | [broker/](../control-plane/durable-objects/broker/) |
| **CatalogDO** | Cloudflare, one | Templates and capabilities, as data I edit; expands spawn specs | [catalog/](../control-plane/durable-objects/catalog/) |
| **McpConnectorDO** | Cloudflare, one per remote MCP server, credential and API client namespace | The server's shared tool list, `list_changed`, admission | [mcp-connector/](../control-plane/durable-objects/mcp-connector/) |
| **ClientDO** | Cloudflare, one per API client | Its record and grant, webhook and event backlog, idempotency keys (its catalog namespace's entries are CatalogDO's) | [client/](../control-plane/durable-objects/client/) |
| **nestd** | Every host | Enrollment, the lease, command delivery, self-fencing. On sandbox hosts: runs sandboxes, builds their network namespaces, launches cloudflared, commits sandbox state to S3. On brain hosts: drives the runner over its socket. The gateway and the runner are systemd units of their own | [compute/nestd/](../compute/nestd/) |
| **nest-proxy** | Sandbox hosts | All sandbox egress: allowlist, TLS inspection, credential injection by placeholder, audit | [egress/](../sandbox/networking/egress/) |
| **Gateway** | Sandbox hosts | The one door into a sandbox: checks the binding, pins `(sandbox, epoch)`, forwards hands connections to the guest over vsock (terminal and ingress connections designed, not built) | [sandbox/gateway/](../sandbox/gateway/) |
| **cloudflared** | Sandbox hosts | Dials Cloudflare outbound and carries the host's tunnel hostname to the gateway; no inbound ports | [sandbox/gateway/](../sandbox/gateway/) |
| **Agent runner** | Brain hosts | Starts and drives unmodified Claude Code, tails its session, answers hooks locally, bridges MCP, carries hands calls to the gateway | [agents/runner/](../agents/runner/) |
| **Claude Code** | Brain hosts, one process per active agent | The brain. No local exec or file tools; everything goes through `nest` MCP tools | [agents/](../agents/) |
| **`nest mcp`** | Spawned by Claude Code | Stdio MCP bridge from Claude Code to the runner | [agents/tools/](../agents/tools/) |
| **Guest agent** | Inside each VM | The hands server (`Bash`, `Read`, `Write`, …), port watching, the in-sandbox `nest` CLI | [sandbox/guest-agent/](../sandbox/guest-agent/) |

## The seam

Two things cross between the systems, and nothing else:
1. **The SandboxDO control API:** `create`, `fork`, `pause`, `suspend`, `resume`, `archive`, `destroy`, `attach`, `detach`, `resolve`, `expose_port`, `egress_policy`, `checkpoint` (built: `suspend` and `resume` inside SandboxDO, on idle and on wake, not as calls; `fork`, `pause`, `archive` and an explicit `checkpoint` are designed, not built). `resolve` issues a **binding** (a signed token naming the sandbox, its epoch, the client, a scope and an expiry), fresh on each call, with the host's tunnel hostname and the guest's protocol version and capabilities. SandboxDO tells each attached agent when the sandbox moves (a new host or epoch, and what was lost).
2. **The hands data plane on the gateway:** one WebSocket per call to the host's tunnel hostname, the binding first, then the host-guest hands frames verbatim. Cancel is a close. Terminals (`/pty`) and ingress (`/ingress/<port>`) are the same kind of connection, and a person's `nest` CLI is a client like any brain (designed, not built: the gateway answers those routes 501).

The contract is in [interfaces/gateway/](../interfaces/gateway/). Any runner can drive any sandbox: a brain host in the cell, one in another cell, or (later) the `api-loop` inside AgentDO.

## A turn, end to end

1. **Something happens.** I or an API client send a turn or an inbox message, an owner agent's spawn gives the first task, an integration posts to the agent's inbox, an ask is answered, a timer fires, or (designed) a repeating `wake_at` comes due. It enters the agent's AgentDO queue.
2. **Placing the brain.** AgentDO queues the turn and, if no brain is running, picks a runner by backend and capacity: for `claude-code`, a brain host with room, preferring the one that ran the agent last. FleetDO sends `agent_start`, and the runner rebuilds the session from R2 and starts Claude Code, resumed or fresh (see [continuity](../agents/#continuity)).
3. **Reaching the hands.** If the agent has hands, AgentDO makes sure the sandbox is running (a suspended or unplaced one is placed and restored from its head; an archived one by the [activator](../control-plane/activator/), designed), attaches the agent through SandboxDO, and gives the runner the sandbox host's hostname, the binding and the guest's version. The runner renews or re-resolves through AgentDO when a binding ages or a connection is refused.
4. **The turn.** AgentDO sends the turn's input to the runner; messages that arrive mid-turn join it through the inbox mirror.
5. **Hands.** `mcp__nest__Bash` goes Claude Code → `nest mcp` → runner → hands client → one WebSocket to the gateway (binding first) → vsock → guest agent, which runs it as the sandbox user and keeps a call record. Results come back the same way. Platform tools (`agent_spawn`, `egress_policy`, brokered actions, remote MCP tools) go runner → AgentDO, which checks the grant and the session's [taint](../agents/tools/#taint-and-sinks), holds a sink call from a tainted session as an ask, and forwards remote MCP tools to their servers.
6. **Egress and durability.** Processes in the VM reach the network only through nest-proxy, which allows listed hosts and injects credentials by placeholder. The session streams from the brain host to AgentDO and R2 (buffered in SQLite and acked once in R2; flushed at 1 MiB, 5 s after bytes arrive while the agent works, 30 s otherwise, and before any start). nestd commits the sandbox disk to S3 from the sandbox host at turn ends (at most every 10 s) and on suspend, each after the guest's `sync` (a 60 s dirty commit, pause and a `syncfs` that must succeed are designed); the head moves by compare-and-set in SandboxDO. The two never touch.
7. **After.** The turn is recorded done (an API client owner gets `agent.turn_completed` by webhook), and the next queued one starts. An idle brain exits after 120 s. A sandbox with no agent mid-turn suspends after 11 minutes (designed: it pauses after 1 minute and suspends after 10 more, and live ingress and a hold keep it up). An idle brain host and an idle sandbox host drain and terminate independently.

## When things fail

| Failure | What happens |
|---|---|
| Brain crash | AgentDO restarts it with `--resume` and a recovery note (where the saved transcript ends; check the workspace); asking the guest for each in-flight hands call's outcome through `call_status` is designed. After three restarts without a completed turn, the next exit leaves it errored until new input |
| Wedged host (processes no commands, or a killed brain outlives its kill) | nestd first drops its runner connection, killing that host's brains. If that doesn't end them, AgentDO reports the host wedged: FleetDO cuts it off, places nothing on it, and sends it to STONITH; its brains restart elsewhere only once its death is confirmed (an operator's confirm-dead in a cell without EC2), and its sandboxes are placed again from their heads |
| Brain host loss | Heartbeats stop. The runner kills its brains at 20 s; at 30 s FleetDO expires the host, AgentDO releases each brain record and starts each brain on another brain host with `--resume`. Open hands connections drop, so the gateway cancels those calls in the guest. The sandbox is untouched: no pause, no fence, no loss record |
| Sandbox host loss | The host self-fences at 20 s (pauses VMs); at 30 s FleetDO expires its leases and terminates the instance (STONITH), then each sandbox is claimed again under a new epoch (loss records are designed), restoring from its last committed generation. Every binding for the old epoch is dead; the brain survives, its next call is refused, it re-resolves, and its next tool result says the sandbox moved and what was lost |
| Network partition between a brain and its sandbox | When the connection drops the runner reports the call's outcome unknown, and the gateway cancels the call in the guest (a 30 s silence limit is designed). Long work belongs in background tasks |
| Cloudflare edge or tunnel outage | Every hands path is down: new calls fail, open calls are cancelled. Sandboxes keep running and brains wait |
| Control-plane restart or deploy | Hosts reconnect with jittered backoff; reliable channels resend in order from the last ack. Bindings keep working until they expire (about an hour), so a turn in flight continues as long as the tunnel is up |
| Gateway crash | systemd restarts it (`nest-gateway.service`). Open calls are cancelled; bindings are unaffected, since they are verified, not stored |
| Spot notice | Every running sandbox is sent a disk-only suspend at the notice, inside the 2-minute warning (memory snapshots after the disks, in order of recent activity, are designed) |
| Stale host comes back | Its epochs are fenced; uncommitted work is offered as an orphaned sibling generation. A stale brain's platform calls are rejected by its agent epoch |

Details: [sandbox/fencing/](../sandbox/fencing/), [sandbox/gateway/](../sandbox/gateway/), [sandbox/state/](../sandbox/state/), [agents/sessions/](../agents/sessions/).

## Where state lives

| State | Store | Written by |
|---|---|---|
| Entity metadata: leases, epochs, agent epochs, generation heads, spawn specs, grants, taint, turns, tunnel ids per sandbox host, the three desired versions per cell (designed) | DO SQLite | The entity's own DO |
| Session transcripts | DO SQLite until flushed, then R2 | AgentDO |
| Audit logs | R2 | FleetDO (hosts'), BrokerDO (credential issuance) |
| Sandbox disk and memory chunks, manifests | S3, per cell | nestd; the head moves only through SandboxDO |
| Secrets | BrokerDO (platform keys: Worker secrets) | Me, or minted by BrokerDO |
| The binding key | BrokerDO (private, per cell; it signs); FleetDO pushes the public keys to each sandbox host's gateway over the fleet channel | BrokerDO |
| Runtime metrics (designed, not built) | Workers Analytics Engine | The Worker and DOs; hosts' through FleetDO ([metrics](../control-plane/metrics/)) |

Bindings themselves are verified, never stored. Hosts hold only caches: page cache, NVMe chunk caches, local session files on brain hosts. See [data/](../data/).

## Trust boundaries

| Boundary | Holds | Guarantee |
|---|---|---|
| Sandbox VM | Code and data being worked on | Untrusted. No credentials; egress only through nest-proxy. The only isolation primitive is a fork |
| Gateway | The binding public keys | The only way into a guest's hands or ingress ports. Nothing is admitted without a binding SandboxDO issued, and the guest checks the epoch again |
| Sandbox host | nestd, nest-proxy, cloudflared, the gateway, VMs | Trusted but fenced by leases, epochs and STONITH. Holds no subscription token and runs no brain |
| Brain | The subscription token, in its process environment | No local exec or file tools; repo config never loads. It acts only through `nest` tools and the web built-ins (host-allowlisted, tainting) |
| Brain host | Brains, session file caches | Trusted but fenced by its lease and the agent epoch. No KVM, no sandbox state; in S3 it may read the release (`releases/*`) only |
| Control plane | All authority | Every platform tool call is checked against grants and taint here; hands calls are gated by the runner's local policy cache, pushed from AgentDO, and by the binding |
| External input | Web pages, integrations' results, other agents' messages | Tainted; its content reaches models only as tool results |

See [security/](../security/).

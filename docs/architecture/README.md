# Architecture

nest has three tiers:
- **A control plane on Cloudflare** holds every piece of authoritative state and makes every decision.
- **Hosts** run the brains (Claude Code processes) and the sandboxes.
- **Sandboxes** are Firecracker VMs where the agents' hands act.

Brains live outside the VMs, on hosts, and act inside them only through RPC. Nothing durable lives on a host; hosts can vanish at any time.

> This is the design. The coordination layer (ChannelDO, HookDO, grants, taint, capabilities, `wake_at`) isn't built, and the code still has roles and WorkstreamDO; `control-plane/README.md` lists the gaps.

## At a glance

```
         me: Discord · API · nest CLI              external senders: GitHub, email, …
                     │                                          │
                     ▼                                          ▼
┌────────────────────── Cloudflare control plane (authoritative) ──────────────────────┐
│ Worker: API · webhook route · Discord interactions · signed blob URLs (stateless)     │
│ Durable Objects, one writer per entity:                                               │
│   FleetDO (per cell) · SandboxDO · AgentDO · ChannelDO · HookDO · BrokerDO (secrets)  │
│ R2: session transcripts · large and older channel messages · audit                    │
└────────────▲──────────────────────────────────────────────────▲──────────────────────┘
             │ WebSockets that hosts dial out:                  │
             │ one fleet channel per host, one session per brain │
┌────────────┴───────────────┐            ┌─────────────────────┴───────────────────────┐
│ controller host (always on)│            │ burst host (spot, scales to zero)           │
│  nestd · agent runner      │            │  nestd ── Firecracker VMs (sandboxes)       │
│    (brains without hands)  │            │             └ guest agent: hands server     │
│  Discord gateway           │            │  agent runner: brains with hands ─ vsock ─┘ │
└────────────────────────────┘            │  nest-proxy: every byte of sandbox egress   │
                                          └─────────────────────┬───────────────────────┘
                                                                ▼
                                                 S3 (per cell): disk and memory chunks
```

## Components

| Component | Runs on | Does | Doc |
|---|---|---|---|
| **Worker** | Cloudflare | HTTP API, webhook route, Discord interactions, signed blob URLs. Stateless; routes to DOs. | [control-plane/api/](../control-plane/api/) |
| **FleetDO** | Cloudflare, one per cell | Hosts, enrollment, leases, placement, STONITH, ordered command delivery | [fleet/](../control-plane/durable-objects/fleet/) |
| **SandboxDO** | Cloudflare, one per sandbox | Epoch, generation head (compare-and-set commits), egress policy, attached agents | [sandbox/](../control-plane/durable-objects/sandbox/) |
| **AgentDO** | Cloudflare, one per agent | Spawn spec (capabilities, grants, budget), turn queue, session stream, taint, scheduled wakes, tool relay | [agent/](../control-plane/durable-objects/agent/) |
| **ChannelDO** | Cloudflare, one per channel | Message log, keyed view, subscriptions, fan-out | [channel/](../control-plane/durable-objects/channel/) |
| **HookDO** | Cloudflare, one per webhook | Verification (through BrokerDO), mapping, dedup, posting | [hook/](../control-plane/durable-objects/hook/) |
| **BrokerDO** | Cloudflare, one | The only DO that stores secret values: setup tokens, injection secrets, hook and capability credentials. Platform keys (root CA, AWS, host-token and admin secrets) are Worker secrets | [broker/](../control-plane/durable-objects/broker/) |
| **nestd** | Burst hosts (and the controller host, without sandboxes) | Runs sandboxes, builds their network namespaces, holds the host's lease and self-fences, commits sandbox state to S3 | [compute/nestd/](../compute/nestd/) |
| **nest-proxy** | Burst hosts | All sandbox egress: allowlist, TLS inspection, credential injection by placeholder, audit | [egress/](../sandbox/networking/egress/) |
| **Agent runner** | Every host | Starts and drives unmodified Claude Code, tails its session, answers hooks locally, bridges MCP | [agents/runner/](../agents/runner/) |
| **Claude Code** | Every host, one process per active agent | The brain. No local exec or file tools; everything goes through `nest` MCP tools | [agents/](../agents/) |
| **`nest mcp`** | Spawned by Claude Code | Stdio MCP bridge from Claude Code to the runner | [agents/tools/](../agents/tools/) |
| **Guest agent** | Inside each VM | The hands server (`Bash`, `Read`, `Write`, …), port watching, the in-sandbox `nest` CLI | [sandbox/guest-agent/](../sandbox/guest-agent/) |

## A turn, end to end

1. **Something happens.** A webhook arrives (HookDO verifies it and posts to a channel), another agent or I post, or a scheduled `wake_at` comes due.
2. **Delivery.** ChannelDO matches subscriptions and, from its alarm, delivers to each subscriber's AgentDO.
3. **Waking.** AgentDO queues a turn. If no brain is running, it picks the host: its sandbox's host for an agent with hands, a controller host otherwise. FleetDO sends `agent_start`, and the runner rebuilds the session from R2 and starts Claude Code, resumed or fresh (see [continuity](../agents/#continuity)). A suspended sandbox is resumed first; an archived one is placed and restored ([activator](../control-plane/activator/)).
4. **The turn.** AgentDO sends a [wake envelope](../channels/#the-wake-envelope): a notice of what arrived, not the bodies. Claude Code reads the bodies with `read`; messages from me arrive inline.
5. **Hands.** `mcp__nest__Bash` goes Claude Code → `nest mcp` → runner → vsock → guest agent, which runs it as the sandbox user and journals intent and outcome. Results come back the same way.
6. **Platform tools.** `post`, `agent_spawn`, `wake_at`, brokered actions and MCP or API capability tools go runner → AgentDO. AgentDO checks the grant and the session's [taint](../agents/tools/#taint-and-sinks); a sink called from a tainted session first becomes a question for me or an untainted holder.
7. **Egress.** Processes in the VM reach the network only through nest-proxy. It allows listed hosts and injects credentials into requests that carry a placeholder, so the sandbox never holds a secret.
8. **Durability.** The runner tails the session file to AgentDO, which acks once the bytes are in SQLite and flushes them to R2 at 1 MiB, at turn end, after 30 s idle and before any start. nestd commits the sandbox disk at turn ends (at most every 10 s), every 60 s while dirty, and on suspend. Chunks go to S3, and the head moves by compare-and-set in SandboxDO.
9. **After.** `turn_completed` is posted to the agent's `events`, which its spawner subscribes to. An idle brain exits after 120 s, a sandbox with no agent mid-turn can suspend, and an idle host is drained and terminated.

## When things fail

| Failure | What happens |
|---|---|
| Brain crash | AgentDO restarts it with `--resume`; the recovery context lists hands calls with unknown outcomes. Three crashes without a completed turn, and it waits for new input |
| Host loss | Heartbeats stop. The host self-fences at 20 s (pauses VMs, kills brains); at 30 s FleetDO expires its leases and terminates the instance (STONITH), then each sandbox is re-placed under a new epoch from its last committed generation and its agents follow. A rollback notice tells each agent what may be undone |
| Controller host loss | After 30 s its agents start on another controller host; nothing to fence |
| Spot notice | Every sandbox's disk is cut first, then memory snapshots in order of recent activity, within the 2-minute warning |
| Control-plane restart or deploy | Hosts reconnect with jittered backoff; reliable channels resend in order from the last ack |
| Stale host comes back | Its epochs are fenced; uncommitted work is offered as an orphaned sibling generation |

Details: [sandbox/fencing/](../sandbox/fencing/), [sandbox/state/](../sandbox/state/), [agents/sessions/](../agents/sessions/).

## Where state lives

| State | Store | Written by |
|---|---|---|
| Entity metadata: leases, epochs, generation heads, spawn specs, grants, taint, turns, subscriptions, channel indexes and recent messages | DO SQLite | The entity's own DO |
| Session transcripts | DO SQLite until flushed, then R2 | AgentDO |
| Large and older channel bodies, audit logs | R2 | ChannelDO, FleetDO |
| Sandbox disk and memory chunks, manifests | S3, per cell | nestd; the head moves only through SandboxDO |
| Secrets | BrokerDO (platform keys: Worker secrets) | Me, or minted by BrokerDO |

Hosts hold only caches: page cache, NVMe chunk caches, local session files. See [data/](../data/).

## Trust boundaries

| Boundary | Holds | Guarantee |
|---|---|---|
| Sandbox VM | Code and data being worked on | Untrusted. No credentials; egress only through nest-proxy. The only isolation primitive is a fork |
| Brain | The subscription token, in its process environment | No local exec or file tools; repo config never loads. It acts only through `nest` tools and the web built-ins (host-allowlisted, tainting) |
| Host | Brains and VMs | Trusted but fenced by leases, epochs and STONITH |
| Control plane | All authority | Every platform tool call is checked against grants and taint here; hands calls are gated by the runner's local policy cache, pushed from AgentDO |
| External input | Webhooks, web pages, other agents' posts | Tainted; its content reaches models only as tool results |

See [security/](../security/).

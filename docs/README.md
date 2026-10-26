# nest

A personal platform built as two systems with one seam: a **sandbox system** that runs isolated VMs on commodity cloud compute, and an **agent system** that runs long-lived Claude Code agents on my own subscription. Brains run on brain hosts (or, later, inside the control plane) and act on sandboxes only over the network, through each sandbox host's gateway; neither system knows where the other runs. Agents organize themselves: captains, teams and pipelines are structures they build from a few primitives, not platform features. Everything scales to zero.

**Status:** early implementation. The runtime (control plane, nestd, nest-proxy, guest agent, agent runner, `nest` CLI) exists and is tested locally; each crate or package README says what is built and what is missing. A local end-to-end harness (`e2e/`) runs the real components together. It runs on AWS: the `use1` cell scales sandbox hosts from zero and back, suspends idle sandboxes to S3, wakes them lazily, survives spot interruptions and nestd restarts (verified on EC2; see [compute/autoscaling/](compute/autoscaling/)). Sandboxes run in Firecracker on nested-virtualization hosts (jailed, hugepages, the proxy root CA in KMS): a real Claude Code turn ran in a VM, its disk was committed at turn end, and after a host reboot the sandbox came back with the file (EC2, 2026-10-18; see [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/)). Hosts without `/dev/kvm` fall back to the process driver. The seam between the two systems is built (the [gateway](sandbox/gateway/), bindings, the runner's hands client, each sandbox host's tunnel), proven on the harness with the gateway on loopback and verified on AWS on 2026-10-23 and, with Access in front, on 2026-10-24 (spike item 13). Designed but not built: [brain hosts](compute/brain-hosts/) and the agent epoch (brains still start on the sandbox's host), the coordination layer (channels, hooks, grants, capabilities, spawn specs, scheduled wakes) and the Discord bot; `control-plane/README.md` lists the gaps.

**Start with [architecture/](architecture/)** for how the pieces fit and how a turn flows. Everything needed to bring nest up (accounts, credentials, where they go) is in [setup/](setup/).

## Goals

- Run many agents in parallel, each in an isolated VM, on cheap cloud compute (AWS spot first, with other providers kept possible).
- **Durable:** an agent can wait days for an event at near-zero cost and survive losing its host.
- **Scale to zero:** an idle system costs close to nothing.
- **Arbitrary agent structures:** a captain managing workstreams, a reviewer watching an implementer, a pipeline, a swarm sharing a board. Agents build these; the platform only provides primitives.
- **Use my Claude Code subscription** (Claude Code is the only harness for now). Apps in sandboxes bring their own API keys; that isn't a platform concern.

## Principles

1. **Mechanism, not policy.** Primitives make no assumptions about the work inside them: no git, no worktrees, no port conventions, no roles, no workstreams.
2. **Structure is the model's job** ([the bitter lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)). The platform provides general primitives and hard limits. How agents organize, delegate and coordinate lives in prompts and tool calls, so it improves as models do and changes without a release.
3. **Authority is grants, and grants only shrink.** Every action needs a grant, and an agent can pass on only grants it holds. A session that has read untrusted content needs approval for actions that send data out. I hold the root.
4. **The sandbox is the trust boundary.** Everything inside one sandbox shares a trust domain.
5. **Decisions on the agent's hot path are local; everything else is async.** Hooks never wait on the network.
6. **Each piece of data lives next to its main reader.** Metadata lives in Durable Objects, bookkeeping in R2 and sandbox bytes in S3.
7. **One writer per entity, fenced by epochs.** Each entity has a single Durable Object, and stale writers are rejected.
8. **Claude Code runs unmodified, on brain hosts that never share a machine with a sandbox.** The subscription token never enters a sandbox or a sandbox host. Agents act on sandboxes only through RPC hands, over the network, through the gateway.

## Implementation

The control plane is TypeScript (Cloudflare Workers). Everything on hosts and in guests is Rust.

| Path | What |
|---|---|
| `control-plane/` | Worker and Durable Objects |
| `crates/nest-protocol` | Wire types for every boundary |
| `crates/nestd` | Host daemon |
| `crates/nest-proxy` | Egress proxy |
| `crates/nest-guest` | Guest agent (hands server) |
| `crates/nest-runner` | Agent runner |
| `crates/nest-gateway` | The sandbox gateway: the one network door into a sandbox ([gateway](sandbox/gateway/)) |
| `crates/nest-hands-client` | The hands client the runner uses: one WebSocket per call to a gateway ([gateway contract](interfaces/gateway/)) |
| `crates/nest-cli` | `nest` binary: `nest hook`, `nest mcp`, in-sandbox commands |
| `protocol/` | Fixtures, tool catalogs, Claude Code reference artifacts |
| `e2e/` | Local end-to-end harness |
| `deploy/` | Cells as an inframe stack (OpenTofu): network, bucket, IAM, the host-image pipeline; the sandbox-host install and bootstrap |
| `images/` | The Firecracker guest image (kernel and `nest-base` rootfs) and its EC2 builder |
| `.github/`, `scripts/` | CI and `CODEOWNERS`; repo checks |
| `verification/` | Formal models and proofs of the protocols (TLA+, Lean, Stateright) and their runner ([verification](verification/)) |
| `dev/` | Developing this repo: CI, deploys, repo settings (outside the design docs) |

UFFD memory snapshots and the ublk lazy disk are designed but not built (see `crates/nestd/README.md`); memory snapshots are deferred by decision until cold boot proves too slow ([memory](sandbox/state/memory/)).

## Primitives

| Primitive | What | Doc |
|---|---|---|
| **Sandbox** | A machine: volumes, processes, network | [sandbox/](sandbox/) |
| **Agent** | A brain with optional hands in one sandbox, plus capabilities, grants and subscriptions | [agents/](agents/) |
| **Channel** | A named, durable, append-only log that agents, sandbox programs, the platform and I post to, read and subscribe to | [channels/](channels/) |

- **Operations:** create, **attach** (bind an agent's hands to a sandbox), **fork** (copy a sandbox; the only isolation primitive), **spawn** (an agent creates an agent), **post / read / subscribe**, **grant / revoke**.
- **On every resource:** an **owner** (the agent that created it, or me) and **labels** (free-form key/values).
- **Capabilities:** pluggable bundles of tools, grants and prompt instructions (messaging, channels, spawning, memory, …).
- **Templates:** named spawn specs, mostly a list of capabilities, stored as data. `captain` and `worker` are templates.

Captains, workstreams and teams are patterns built from these. See [orchestration/](orchestration/).

## Layers

```
patterns        captains · workstreams (templates + conventions) · quota scheduling  orchestration/
agents          backends · capabilities · runner · hands · sessions · state tracking · tools  agents/
channels        logs · subscriptions · wakes · external sources (webhooks, email)      channels/
sandbox         drivers · state · fencing · networking · gateway · guest agent         sandbox/
compute         cells · sandbox hosts · brain hosts · nestd · autoscaling · provisioning  compute/
control plane   Cloudflare Workers + Durable Objects · API · activator                 control-plane/
cross-cutting   security (authority, model access, identity, credentials) · data      security/  data/
                verification (state-machine inventory, models, proofs)                verification/
contracts       boundary interfaces (wire protocols, the gateway contract, tool schemas) interfaces/
```

See [architecture/](architecture/) for the system diagram, components, a turn end to end, failure handling, state and trust boundaries. The layers in detail: [orchestration/](orchestration/), [agents/](agents/), [channels/](channels/), [sandbox/](sandbox/), [compute/](compute/), [control-plane/](control-plane/), [security/](security/), [data/](data/), [verification/](verification/), [interfaces/](interfaces/) and [setup/](setup/).

## Glossary

| Term | Meaning |
|---|---|
| Sandbox | A VM: volumes, processes, network. Holds 0..N attached agents. |
| Agent | A brain (Claude Code on a brain host, on my subscription; later, a Messages API loop inside AgentDO) plus optional hands, grants and subscriptions. There are no agent roles. |
| Agent runner | Brain-host component that starts, drives and tails Claude Code processes, and carries their hands calls to a sandbox's gateway |
| Hands | `nest` MCP tools modeled on Claude Code's built-ins, executed in a sandbox by the guest agent, reached through the sandbox host's gateway |
| Gateway | The one network door into a sandbox: an unprivileged process per sandbox host, behind the host's Cloudflare Tunnel, that checks a binding and forwards hands, terminal and ingress connections to the guest over vsock |
| Binding | A signed token from SandboxDO's `resolve`: sandbox, epoch, client, scope and expiry, one hour long. The gateway admits a connection only with one; a detach or an epoch bump voids it |
| Agent epoch | Fencing token for a brain, issued by AgentDO at each brain start; platform tool calls and brokered actions carry it |
| Attach | Bind an agent's hands to a sandbox |
| Fork | Copy-on-write copy of a sandbox (disk only, or live with memory) |
| Channel | A named, durable, append-only message log. Inboxes, platform events, questions, shared state and memory are all channels. |
| Hook | A verified webhook (or email address) that turns each external event into a tainted post on a channel |
| Subscription | An agent's wake rule on a channel: a filter plus how matches are delivered |
| Grant | Permission for a principal to do an action on a resource. Passed on only by someone who holds it. |
| Owner | Whoever created a resource. Holds every grant on it. |
| Taint | A per-session bit the platform sets when a session reads untrusted content (hands output, the web, MCP and API results, transcripts, tainted posts) |
| Sink | An action that can send data out or widen authority; from a tainted session it needs approval |
| Capability | A pluggable bundle of tools, the grants they need and prompt instructions, listed in spawn specs |
| Template | A named spawn spec (prompt, capabilities, grants, subscriptions, backend), stored as data |
| Generation | Immutable manifest of a sandbox's disk (and optionally memory) chunks |
| Epoch | Fencing token. A new one is issued with each placement claim, and only a host holding the newest epoch's lease may act for the sandbox. |
| Cell | A unit of compute plus its object store (e.g. AWS us-east-1 with S3) |
| Sandbox host | A spot VM with nested virtualization running Firecracker sandboxes, nestd, nest-proxy, cloudflared and the gateway. Every sandbox lives here; no brain does. The `burst` role in code. |
| Brain host | A cheap host with no KVM running nestd, the agent runner and Claude Code processes. Every brain lives here; no sandbox does. Scales to zero. |
| Captain | A pattern, not a platform concept: an agent without hands, spawned from the `captain` template, that manages other agents and escalates to me |
| Workstream | A pattern, not a platform concept: a goal plus the channel, sandboxes and agents set up for it, grouped by a label |
| nestd | Per-host daemon |
| nest-proxy | Per-host egress proxy |
| Guest agent | Hands server inside each sandbox VM. Holds no credentials. |
| `nest mcp` / `nest` | `nest mcp`: the stdio MCP bridge that Claude Code spawns on a brain host. `nest`: the CLI used for hooks, for a person's terminal and port-forward through the gateway, and inside sandboxes. |

## Settled decisions

| Decision | Owning doc |
|---|---|
| Rust on the host side (nestd, nest-proxy, guest agent, UFFD/ublk, CLI); TypeScript for the control plane | this file |
| Workers Paid ($5/mo) | [control-plane/](control-plane/) |
| Hosts authenticate with signed instance identity documents; guests can't reach IMDS | [compute/provisioning/](compute/provisioning/) |
| No agent roles. Where a brain runs and where its sandbox runs are unrelated: brains run on brain hosts (later, inside AgentDO) and reach a sandbox only through the gateway; an agent without hands needs no sandbox. The brain backend is pluggable (`claude-code`, and `api-loop` inside the control plane later). | [agents/](agents/) |
| Captains and workstreams are patterns (templates plus conventions), not code | [orchestration/](orchestration/) |
| Agent features are pluggable capabilities: named bundles of tools, grants and prompt, composed by templates | [agents/capabilities/](agents/capabilities/) |
| Agents message each other through the messaging capability; by default an agent reaches its owner and its label group | [agents/capabilities/](agents/capabilities/) |
| Remote MCP servers and HTTP APIs (`ro` or `rw`) plug in as capabilities, as data: the control plane calls them with credentials from BrokerDO and surfaces them as tools | [agents/capabilities/](agents/capabilities/) |
| Coordination is one primitive: channels. Inboxes, platform events, questions, shared state and memory are channels. | [channels/](channels/) |
| Authority is grants, attenuated from me and revoked down the chain; there's no built-in scoping unit | [agents/tools/](agents/tools/) |
| When an agent is removed, what it owns is parked (stopped, archived, read-only), adoptable, and destroyed after 30 days | [agents/](agents/) |
| Inspection without hands is a pure pattern: no `delegate` tool or reader template | [orchestration/captains/](orchestration/captains/) |
| Memory is a capability for long-lived agents only (monitors, personal assistants, captains); ephemeral agents have none and always resume | [agents/](agents/) |
| The memory key index injected at session start is capped at 200 keys, newest first; agents tidy memory as they go, plus a weekly consolidation wake | [agents/](agents/) |
| Agents schedule their own wakes with `wake_at` (once or repeating), a capability backed by AgentDO alarms | [agents/capabilities/](agents/capabilities/) |
| MCP servers are remote only; a local server runs as a sandbox service exposed through ingress | [agents/capabilities/](agents/capabilities/) |
| External events (webhooks, email) become tainted channel posts through verified hooks; polling is an agent's job, not a platform source | [channels/sources/](channels/sources/) |
| An agent with memory resumes if its last turn was under an hour ago or its session is under ~50k tokens, otherwise starts fresh from memory | [agents/](agents/) |
| Channel message bodies older than 7 days move to R2; the index and keyed view stay in SQLite | [channels/](channels/) |
| Egress policy is per sandbox (forks inherit); no shared policy objects | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/) |
| Guardrails start "balanced": 60 subscription-started or scheduled turns an hour per agent, a 50-delivery backlog, 30-day retention | [channels/](channels/) |
| Taint is tracked per session by the platform; sink calls (egress widening, external brokered actions, MCP tools not marked read-only, `rw` APIs, granting sinks) from a tainted session need approval from me or an untainted holder | [agents/tools/](agents/tools/) |
| A woken turn gets a platform notice; other agents' message bodies reach a model only as `read` results | [channels/](channels/) |
| Budgets (depth, concurrency, spawns, turns) shrink like grants and are enforced per owner subtree; quota is divided by priority and the concurrency cap, not by estimated shares | [orchestration/scheduling/](orchestration/scheduling/) |
| Hands calls are journaled, with intent written at the point of no return. A refusal before it says `executed: false` and the runner retries it; duplicate call ids are refused. After a crash, outcomes come from the guest's call records, and a call that may have run is never retried | [agents/hands/](agents/hands/) |
| A hands call ends with its main process (pidfd, 1 s drain, cgroup kill), and a hangup cancels it. Write and Edit replace atomically when safe, otherwise in place | [agents/hands/](agents/hands/) |
| The host accepts guest protocol versions in `[min_supported, current]`, gating features on capabilities, so a protocol bump doesn't strand memory snapshots | [sandbox/guest-agent/](sandbox/guest-agent/#versions) |
| Terminals survive a dropped connection for 60 s and reattach by offset; attach tokens never go in URLs | [sandbox/guest-agent/](sandbox/guest-agent/#terminals) |
| The runner pins one Claude Code version (version and SHA-256); upgrades are gated on `claude-verify`, the hands fidelity eval and resume | [agents/runner/](agents/runner/) |
| The restore ABI is a SHA-256 over a canonical, versioned descriptor, never inferred from version strings. Hosts advertise the ABIs they can create and load, and an ABI-changing upgrade resumes dormant memory generations disk-only | [sandbox/state/memory/](sandbox/state/memory/#restore-abi) |
| Firecracker is pinned by binary digest, and memory restore is qualified per (Firecracker, kernel) pair before hosts create memory generations | [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/) |
| New sandboxes restore a base memory generation per (image, ABI), falling back to cold boot; no warm pools (designed; today every create cold-boots) | [sandbox/state/memory/](sandbox/state/memory/#base-generations) |
| Sandboxes cold-boot from their disk generation, and forks are disk-only, so they land on any host in the cell. Memory snapshots (hugepages plus UFFD, S3-backed) wait for a measured need; a same-host File-backend restore is rejected | [sandbox/state/memory/](sandbox/state/memory/) |
| The guest kernel is Firecracker's prebuilt 6.18 longterm CI build, pinned by digest and never self-built; the image is Firecracker's Ubuntu 24.04 rootfs plus apt packages (`nest-base`, with python3) | [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/) |
| Placement is a fenced claim in SandboxDO: the epoch is issued at claim, completion is one compare-and-set checked against host evidence, an epoch is never retried, and every loss is recorded | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#placement) |
| One `isRestoreSource` predicate decides resume, the drain gate and GC; deleting a generation is one-way | [sandbox/state/](sandbox/state/#restore-sources) |
| Turn-end generations are always kept; periodic ones thin by tier | [sandbox/state/](sandbox/state/#retention) |
| Drains are gentle (consolidation) or forced (spot notices); a host terminates only after it reports, all or nothing, that its uploads are done | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| A sandbox pauses, then suspends, only with no agent mid-turn, no live ingress and no hold (`nest hold`) | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#activity-and-idle) |
| Every commit, pause and suspend requires a guest `syncfs` | [sandbox/state/disk/](sandbox/state/disk/#flush-before-commit) |
| Per-sandbox disk I/O is limited (10,000 ops/s, 100 MiB/s, 30 s burst) | [sandbox/state/disk/](sandbox/state/disk/#io-limits) |
| The AWS burst fleet is the 8i family only | [compute/](compute/) |
| Everything AWS is per cell, keyed by the cell name: resources, settings (`AWS_CELLS`), the control plane's credentials (`AWS_CELL_CREDENTIALS`), the proxy root CA key and its certificate, which FleetDO derives from the key | [compute/cells/](compute/cells/) |
| Placement packs by free hugepages | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| Claude Code is the only harness; on a rate limit, park and wait for quota | [orchestration/scheduling/](orchestration/scheduling/) |
| The harness runs on brain hosts; hands are RPC into the sandbox through the gateway; no credentials in VMs or on sandbox hosts | [agents/](agents/) |
| I reach agents through a Discord bot that bridges Discord channels and threads to nest channels | [control-plane/api/discord/](control-plane/api/discord/) |
| No platform API-key proxy; apps bring their own keys | [security/model-access/](security/model-access/) |
| One session artifact: the native session file, tailed on the host. No proxy decrypts OAuth traffic. | [agents/sessions/](agents/sessions/) |
| Sandbox credentials are injected at the proxy by placeholder; GitHub through a GitHub App; OIDC deferred | [security/identity/](security/identity/) |
| Credential bindings name exact hosts (wildcards opt-in), optional methods and whole-segment path prefixes, and allow no upgrade after a substitution | [sandbox/networking/egress/injection/](sandbox/networking/egress/injection/) |
| Inspected requests have CDN routing overrides stripped and smuggling-shaped framing rejected | [sandbox/networking/egress/inspection/](sandbox/networking/egress/inspection/) |
| Non-public destinations are hard-denied ahead of any policy, by nest-proxy and by a kernel rule on its uid; denied guest traffic is rejected, not dropped | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/#hard-deny) |
| A policy change re-checks open connections, and a VM boots only after nest-proxy acknowledges its exact policy | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/#changes) |
| The proxy root CA key is a non-exportable AWS KMS key; hosts send fixed-shape CSRs for intermediates (pathLen 0, about 7 days); leaves last at most 24 h | [sandbox/networking/egress/tls/](sandbox/networking/egress/tls/) |
| Operator tokens are scoped, stored hashed and sent only in headers; one revocation counter invalidates every minted session | [control-plane/api/](control-plane/api/) |
| BrokerDO audits every credential mint, push and refusal; S3 access stays a cell-wide host role | [security/credentials/](security/credentials/) |
| The netns has no uplink: nestd binds nest-proxy's listeners inside it and passes them over; the proxy is unprivileged | [sandbox/networking/egress/](sandbox/networking/egress/) |
| Ingress (previews, terminals, port-forwards) goes through the gateway and over vsock through the guest agent | [sandbox/networking/ingress/](sandbox/networking/ingress/) |
| Reliable channels deliver strictly in order: a gap or a processing failure closes the socket and the sender resends. Each peer process has an `instance_id`; a new one resets the lineage. | [interfaces/control-host/](interfaces/control-host/) |
| A fence is terminal for its epoch, applied on arrival, and never waits on the proxy link | [sandbox/fencing/](sandbox/fencing/) |
| Repo maintenance is a pattern: a maintainer, a worker per task, a clean-context reviewer per PR and a monitor, merging through the repo's own GitHub gates (required checks, the review check pinned to the App, `CODEOWNERS`) | [orchestration/repo-maintenance/](orchestration/repo-maintenance/) |
| GitHub access is a GitHub App; BrokerDO mints installation tokens narrowed per binding | [control-plane/durable-objects/broker/](control-plane/durable-objects/broker/) |
| Control-plane upgrades: expand-only schemas, wire formats compatible one version back, deploys at 100%, DO class changes one-way. Hosts upgrade by replacement, brain hosts before sandbox hosts | [control-plane/](control-plane/#upgrades) |
| Runtime metrics go to Workers Analytics Engine (numbers, enums and ids only), read through the `metrics` capability | [control-plane/metrics/](control-plane/metrics/) |
| nest is two systems with one seam: the sandbox system (hosts, VMs, state, fencing, egress, the gateway) and the agent system (agents, runners, channels). Only three protocols cross it: the SandboxDO control API, the gateway's hands data plane, and the sandbox's events on channels. Co-location is never assumed; there is one hands path, and it goes over the network | [architecture/](architecture/), [sandbox/gateway/](sandbox/gateway/) |
| Sandbox hosts accept no inbound connections: each runs cloudflared, and the gateway sits behind the host's tunnel hostname with an Access service token at the edge, a binding at the gateway and the epoch check in the guest. Tunnel-only to start; a VPC endpoint only if a measurement asks for one | [sandbox/gateway/](sandbox/gateway/) |
| The control plane owns each sandbox host's tunnel and DNS record: created at enrollment before the host exists in the fleet, deleted when the host dies, swept daily, matched only by nest's own names; the Access applications are created by hand | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| A brain has its own epoch, issued by AgentDO at each start; platform tool calls and brokered actions carry it, and hands calls carry the sandbox epoch inside the binding | [control-plane/durable-objects/agent/](control-plane/durable-objects/agent/) |
| Hands journal records stay in the guest; after a crash the runner asks `call_status` through the gateway, and nestd relays nothing about agents | [agents/hands/](agents/hands/) |
| Every brain runs on a brain host: the cheapest instance class that runs Claude Code, no KVM, idle 30 min then terminated. An agent without hands is a brain like any other, and the Discord gateway client is a singleton placed on one brain host; no host kind is reserved for brains without sandboxes | [compute/brain-hosts/](compute/brain-hosts/) |
| A release rolls out control plane, then brain hosts, then sandbox hosts, one canary and a probe gate each; FleetDO holds three desired versions per cell (brain host, sandbox host, guest image), and rollback sets a version back | [compute/provisioning/](compute/provisioning/#upgrades) |
| `api-loop` can hold hands through the gateway (a Durable Object opens one WebSocket per call) and is deferred until the API credits are picked up | [agents/backends/api-loop/](agents/backends/api-loop/) |

## Open questions and watch items

- **Watch:** `--bare` may become the default for `claude -p`, which would break subscription auth. The mitigation is the `authMethod` startup check. See [agents/runner/](agents/runner/).
- **Verify:** that separate setup tokens can be revoked independently. See [agents/runner/](agents/runner/).
- **Verify:** that `SessionStart` fires after an automatic compaction under `--disable-slash-commands`. `e2e/claude-verify` could trigger compaction only with `/compact`, which needs slash commands. See [agents/](agents/#continuity).
- **Checked against the real binary** (Claude Code 2.1.301, `e2e/claude-verify` with a real token, 2026-10-16): the token works under `forceLoginMethod: "claudeai"`, and the stdin shape, the MCP tool-use id, cancellation, the env scrub, the transcript path, interrupted-turn resume, `defer` and `SessionStart` after `/compact` all behave as nest assumes. Two don't: `system/init` arrives only after the first user message, and `--restricted` drops `TodoWrite` even when it's named. The designs already account for both. Details: [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/).

- **Verify:** that Amazon Linux 2023 ships ublk, which the lazy disk needs. See [compute/provisioning/](compute/provisioning/).
- **Verify:** that every 8i variant reports the same CPU model (it's part of the restore ABI); that Firecracker's writes pass through the host page cache before ublk; and whether S3 Inventory and lifecycle rules work on S3 Express One Zone directory buckets. See [sandbox/state/](sandbox/state/).
- **Not built:** the 60 s dirty-disk timer and the 256 MB dirty threshold. Disks commit at turn end, suspend, drain and spot notice only; a timer needs dirty tracking and a cut that doesn't pause the VM for the whole chunking pass (ublk). See [sandbox/state/](sandbox/state/#writeback-cadence).
- **Watch:** a host terminated outside FleetDO kept new sandboxes waiting about 10 minutes before a replacement launched. See [compute/autoscaling/](compute/autoscaling/).
- **Not built:** pruning old host AMIs and their snapshots. Each build adds one (a few GB of snapshot, cents a month); an Image Builder lifecycle policy would keep the last few. See [compute/provisioning/](compute/provisioning/).
- **Not built:** retrying a failed turn-end commit. One that times out leaves the head where it was, with nothing surfaced until the next turn ends (seen on EC2 with a cold-snapshot AMI). See [sandbox/state/](sandbox/state/).
- **Open:** guest `init_on_free=1` (for compressible memory snapshots) stalled 1-vCPU guest boots past a minute on a nested 8i host, so it's off until snapshots exist; whether nested hosts can afford it then is unmeasured. See [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/).
- **Open:** turn-end generations are always kept, so a long-lived sandbox's history grows without bound; it may need a cap. See [sandbox/state/](sandbox/state/#retention).
- **Open:** per-sandbox I/O limits don't make a dense host fair when many sandboxes spend their burst at once. See [sandbox/state/disk/](sandbox/state/disk/#io-limits).
- **Open:** upgrading the guest agent in place by re-exec, which needs a task registry rebuildable from tmpfs. See [sandbox/guest-agent/](sandbox/guest-agent/#versions).
- **Open:** resolving upstream names with a DNS client instead of getaddrinfo, so TTL and CNAME caps can apply. Which origins honor `X-Forwarded-Host` and similar overrides is unverified (nest strips them regardless). See [sandbox/networking/egress/dns/](sandbox/networking/egress/dns/).
- **Open:** taint is one bit, so it can't tell sandbox output from outside content; auto-merging agents' PRs relies on keeping outside content from the repo's workers. Recording a taint source would let PRs from sessions that read the web wait for me. See [repo maintenance](orchestration/repo-maintenance/#why-auto-merge-is-safe-enough).
- **Not designed yet:** the sandbox-to-sandbox **link** (an opt-in path through the proxy). See [sandbox/](sandbox/).
- **Measure:** the edge round trip a hands call pays over the tunnel, in the remote-brain arm of the fidelity eval (spike item 10). A VPC endpoint for same-cell brain hosts waits on this number. See [sandbox/gateway/](sandbox/gateway/).
- **Measure:** a worker's wall time inside hands calls per turn, before `api-loop` ships: a Durable Object is billed while an outbound WebSocket is open. See [agents/backends/api-loop/](agents/backends/api-loop/).
- **Access in front of the gateway hostnames is in place** (2026-10-24): the application on `*-gw-nest.bitcru.sh` answers 403 without the service token and admits it with a Service Auth policy (an Allow policy redirects a service token to the login page, which is what the first cross-host run hit). Every brain now depends on the token the control plane hands out as `edge`.
- **Open:** the long-run spec language for protocol models: TLA+ with TLC (what the pilots used, and found bugs with) or Quint (the survey's pick, for model-based testing). See [verification/](verification/#open-questions).
- **Decide:** the no-capacity placement rollback reuses an epoch number, contrary to "an epoch is never retried", and makes the old holder's salvage fail for good. Keep it and authorize that salvage, or spend an epoch per attempt? See [verification/sandbox-lease/](verification/sandbox-lease/).
- **Docs ahead of code (found by the verification study):** hands-call journaling (`call_status`, `executed: false`) and the single `isRestoreSource` predicate are settled here but not built, and nestd's command receiver has no gap check. See [verification/](verification/#real-bugs-found).

## First spike

On a c8id with nested virtualization and a hugepage pool:
1. Cold boot until the guest agent is ready, against a restore from a base memory generation.
2. Disk-only resume through `claude --resume`.
3. Hugepage UFFD resume from page cache, NVMe and S3 Express (no public benchmark of 2 MB UFFD restores exists). This also qualifies the pinned (Firecracker, guest kernel) pair for memory restore; until it passes, hosts create no memory generations ([restore ABI](sandbox/state/memory/#restore-abi)).
4. Time to write a full snapshot at 2 and 4 GB.
5. A dev server's first response after resume.
6. ublk lazy-disk throughput.
7. Commit latency under write load, including the guest flush and the epoch flip.
8. Forced-partition test: self-fence, then STONITH, then restore.
9. **First real Claude Code run** through the runner (the verification list above). It needs no KVM, so it runs in the cloud dev environment through the e2e harness, with the token as `NEST_CLAUDE_OAUTH_TOKEN`. **Done** (2026-10-16, Claude Code 2.1.301, `NEST_E2E_CLAUDE=real e2e/run.sh`): a real turn ran entirely through `mcp__nest__` hands (Bash, Write, Read, Edit), with no host-side built-ins and the token absent from the sandbox. All 21 checks passed, including self-fencing 20 s after the control plane was cut.
10. **Hands fidelity eval:** the same tasks with native tools (Claude Code inside a VM), with RPC hands from a brain on the same machine, and with hands from a remote brain through the gateway and the tunnel; compare success rate, turns and tokens, and record the per-call round trip of the remote arm. The same eval gates every upgrade of the pinned Claude Code version ([runner](agents/runner/)).
11. **Nested overhead:** CPU and I/O on a nested 8i instance against the same work on `.metal`.
12. **Resume or fresh:** turn cost and quality when resuming a long session after the cache expired, against a fresh session seeded from memory.
13. **The seam:** a brain on a cell host drives its own sandbox through the tunnel: its target is `wss://<host>-gw-nest.<zone>`, so every hands call leaves the host, crosses Cloudflare's edge and Access, and returns down the tunnel into the gateway. Proven on 2026-10-23: a real Claude Code agent in `use1` completed the Python task (F(90)) against `wss://<host>-gw-nest.bitcru.sh`, the host's cloudflared held four QUIC connections to the edge, and the gateway logged every call `bound … via="edge"` (a `cf-ray` header on the upgrade; a direct connection logs `via=direct`); twelve minutes after the sandbox was destroyed the idle host was retired and its tunnel and DNS record were gone from the account. One readiness blip was seen (a single failed `/ready` probe flipped the state to `connecting` for 2 s), so a brain resolving in that window waits one retry. The second half ran the same evening with two cell hosts: the sandbox on one, the brain started on the other (`POST /v1/agents/<id>/start {host}`), `resolve` pointing at the sandbox host's tunnel hostname with the edge credential; the first attempt was refused at the edge (the policy's action was Allow, not Service Auth); with the action fixed on 2026-10-24 the brain on one cell host completed the Python task against the sandbox on the other, every hands call crossing Access and the tunnel. Still open: the same with a real brain host kind. The first proves the contract and the edge path, the second the fleet ([gateway](sandbox/gateway/), [brain hosts](compute/brain-hosts/)).

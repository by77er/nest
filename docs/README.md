# nest

A personal platform built as two systems with one seam: a **sandbox system** that runs isolated VMs on commodity cloud compute, and an **agent system** that runs long-lived Claude Code agents on my own subscription. Brains run on brain hosts (or, later, inside the control plane) and act on sandboxes only over the network, through each sandbox host's gateway; neither system knows where the other runs. Agents organize themselves: captains, teams and pipelines are structures they build from a few primitives, not platform features. Everything scales to zero.

**Status:** early implementation. The runtime (control plane, nestd, nest-proxy, guest agent, agent runner, `nest` CLI) exists and is tested locally; each crate or package README says what is built and what is missing. A local end-to-end harness (`e2e/`) runs the real components together. It runs on AWS: the `use1` cell scales sandbox hosts from zero and back, suspends idle sandboxes to S3, wakes them lazily, survives spot interruptions and nestd restarts (verified on EC2; see [compute/autoscaling/](compute/autoscaling/)). Sandboxes run in Firecracker on nested-virtualization hosts (jailed, guest memory on regular pages capped per VM, the proxy root CA in KMS): a real Claude Code turn ran in a VM, its disk was committed at turn end, and after a host reboot the sandbox came back with the file (EC2, 2026-10-18; see [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/)). Hosts without `/dev/kvm` fall back to the process driver. The seam between the two systems is built (the [gateway](sandbox/gateway/), bindings, the runner's hands client, each sandbox host's tunnel), proven on the harness with the gateway on loopback and verified on AWS on 2026-10-23 and, with Access in front, on 2026-10-24 (spike item 13). Templates and capabilities are data (CatalogDO, seeded with `worker` and `captain`), agents store their expanded spawn spec, and nothing decides on an agent role. Every brain runs on a [brain host](compute/brain-hosts/), never on a sandbox host: built, run on the harness as two hosts, and on AWS since 2026-10-29 (two workers' brains on a brain host driving their sandboxes on a sandbox host). The one-brain rule is model-checked, and nestd's fleet link is a pure core checked as the shipped code ([verification](verification/)). Channels, the task ledger, workstreams and the `notify`/`ask`/`emit` tools have left the platform (principle 9, stages 1 to 3); approvals stay, listed per agent. External systems use nest as [API clients](control-plane/api/clients/): scoped principals with a grant, their own subtree, labels, a catalog namespace, caller identity for MCP servers, events to owners, GitHub tokens and idempotent creates are built. Designed but not built: grants and their attenuation, capability sources and parameters, scheduled wakes, and the Discord bot; `control-plane/README.md` lists the gaps.

**Start with [architecture/](architecture/)** for how the pieces fit and how a turn flows. Everything needed to bring nest up (accounts, credentials, where they go) is in [setup/](setup/).

## Goals

- Run many agents in parallel, each in an isolated VM, on cheap cloud compute (AWS spot first, with other providers kept possible).
- **Durable:** an agent can wait days for an event at near-zero cost and survive losing its host.
- **Scale to zero:** an idle system costs close to nothing.
- **Arbitrary agent structures:** a captain managing workers, a reviewer watching an implementer, a pipeline, a swarm sharing a board. Agents and external apps build these; the platform only provides primitives.
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
9. **nest is a microkernel** (decided 2026-11-02). The kernel keeps what needs the root or the seam: sandboxes (with the gateway and hands); agents (the loop, the input queue, lifecycle, spawning, ownership); the credential broker and egress policy; MCP tool attachment; scoped API clients and labels; and agent events delivered to owners. Everything else is an external integration that agents reach over MCP and the public API. Channels, the task ledger, WorkstreamDO and the built-in `notify`, `ask` and `emit` tools leave the platform. A small kernel keeps the trusted, fenced and model-checked surface small, and coordination tools can change without a platform release. The removal is staged: (1) the task ledger (done), (2) channels (done), (3) workstreams and `notify`/`ask`/`emit` (done), (4) deleting their Durable Object classes and all their storage (done, in a deploy of its own: one-way).

## Implementation

The control plane is TypeScript (Cloudflare Workers). Everything on hosts and in guests is Rust.

| Path | What |
|---|---|
| `control-plane/` | Worker and Durable Objects |
| `crates/nest-protocol` | Wire types for every boundary |
| `crates/nestd` | Host daemon |
| `crates/nestd-core` | nestd's pure state-machine cores, checked as shipped ([verification](verification/nestd/); [README](../crates/nestd-core/README.md)) |
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
| `projects/` | An app on nest, not part of it: a task board with agents for its GitHub repos, built only on the [API clients](control-plane/api/clients/) interface |
| `dev/` | Developing this repo: CI, deploys, repo settings (outside the design docs) |

UFFD memory snapshots, the reflink disk cut and the ublk lazy disk are designed but not built (see `crates/nestd/README.md`); memory snapshots are deferred by decision until cold boot proves too slow ([memory](sandbox/state/memory/)).

## Primitives

| Primitive | What | Doc |
|---|---|---|
| **Sandbox** | A machine: volumes, processes, network | [sandbox/](sandbox/) |
| **Agent** | A brain with optional hands in one sandbox, plus capabilities and grants | [agents/](agents/) |

- **Operations:** create, **attach** (bind an agent's hands to a sandbox), **fork** (copy a sandbox; the only isolation primitive), **spawn** (an agent creates an agent), **grant / revoke**.
- **On every resource:** an **owner** (the agent that created it, or me) and **labels** (free-form key/values).
- **Capabilities:** pluggable bundles of tools, grants and prompt instructions (messaging, spawning, MCP servers, brokered actions, …).
- **Templates:** named spawn specs, mostly a list of capabilities, stored as data. `captain` and `worker` are templates.

Captains, task boards and teams are patterns that agents and external apps build from these. See [orchestration/](orchestration/).

## Layers

```
patterns        captains · external apps (templates + conventions) · quota scheduling  orchestration/
agents          backends · capabilities · runner · hands · sessions · state tracking · tools  agents/
sandbox         drivers · state · fencing · networking · gateway · guest agent         sandbox/
compute         cells · sandbox hosts · brain hosts · nestd · autoscaling · provisioning  compute/
control plane   Cloudflare Workers + Durable Objects · API · activator                 control-plane/
cross-cutting   security (authority, model access, identity, credentials) · data      security/  data/
                verification (state-machine inventory, models, proofs)                verification/
contracts       boundary interfaces (wire protocols, the gateway contract, tool schemas) interfaces/
```

See [architecture/](architecture/) for the system diagram, components, a turn end to end, failure handling, state and trust boundaries. The layers in detail: [orchestration/](orchestration/), [agents/](agents/), [sandbox/](sandbox/), [compute/](compute/), [control-plane/](control-plane/), [security/](security/), [data/](data/), [verification/](verification/), [interfaces/](interfaces/) and [setup/](setup/).

## Glossary

| Term | Meaning |
|---|---|
| Sandbox | A VM: volumes, processes, network. Holds 0..N attached agents. |
| Agent | A brain (Claude Code on a brain host, on my subscription; later, a Messages API loop inside AgentDO) plus optional hands and grants. There are no agent roles. |
| Agent runner | Brain-host component that starts, drives and tails Claude Code processes, and carries their hands calls to a sandbox's gateway |
| Hands | `nest` MCP tools modeled on Claude Code's built-ins, executed in a sandbox by the guest agent, reached through the sandbox host's gateway |
| Gateway | The one network door into a sandbox: an unprivileged process per sandbox host, behind the host's Cloudflare Tunnel, that checks a binding and forwards hands, terminal and ingress connections to the guest over vsock |
| Binding | A signed token from SandboxDO's `resolve`: sandbox, epoch, client, scope and expiry, one hour long. The gateway admits a connection only with one; a detach or an epoch bump voids it |
| Agent epoch | Fencing token for a brain, issued by AgentDO at each brain start; platform tool calls and brokered actions carry it |
| Attach | Bind an agent's hands to a sandbox |
| Fork | Copy-on-write copy of a sandbox (disk only, or live with memory) |
| Grant | Permission for a principal to do an action on a resource. Passed on only by someone who holds it. |
| Owner | Whoever created a resource. Holds every grant on it. |
| Taint | A per-session bit the platform sets when a session reads untrusted content (hands output, the web, MCP and API results, transcripts) |
| Sink | An action that can send data out or widen authority; from a tainted session it needs approval |
| Capability | A pluggable bundle of tools, the grants they need and prompt instructions, listed in spawn specs |
| Template | A named spawn spec, stored as data in CatalogDO: capabilities, launch settings (model, built-in tools, base prompt), whether it takes a sandbox and the credential (grants and the backend choice are designed, not built) |
| Generation | Immutable manifest of a sandbox's disk (and optionally memory) chunks |
| Epoch | Fencing token. A new one is issued with each placement claim, and only a host holding the newest epoch's lease may act for the sandbox. |
| Cell | A unit of compute plus its object store (e.g. AWS us-east-1 with S3) |
| Sandbox host | A spot VM with nested virtualization running Firecracker sandboxes, nestd, nest-proxy, cloudflared and the gateway. Every sandbox lives here; no brain does. |
| Brain host | A cheap host with no KVM running nestd (supervisor duties only), the agent runner and Claude Code processes. Every brain lives here; no sandbox does. Capacity is counted in brains; scales to zero. |
| Captain | A pattern, not a platform concept: an agent without hands, spawned from the `captain` template, that manages other agents and asks me when it must |
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
| Captains, task boards and review pipelines are patterns (templates plus conventions) that agents and external apps build over MCP and the public API, not kernel code | [orchestration/](orchestration/) |
| Agent features are pluggable capabilities: named bundles of tools, grants and prompt, composed by templates | [agents/capabilities/](agents/capabilities/) |
| Agents message each other through an external integration that posts to the recipient's inbox (principle 9) | [agents/capabilities/](agents/capabilities/#messaging) |
| Remote MCP servers and HTTP APIs (`ro` or `rw`) plug in as capabilities, as data: the control plane calls them with credentials from BrokerDO and surfaces them as tools | [agents/capabilities/](agents/capabilities/) |
| nest is a microkernel: sandboxes, agents, the credential broker and egress policy, and MCP tool attachment stay; channels, the task ledger, WorkstreamDO and `notify`/`ask`/`emit` become external integrations over MCP and the public API, removed in four stages (principle 9) | this file |
| External systems use nest only as [API clients](control-plane/api/clients/): a scoped principal with the operator's grant as its ceiling, owning (and seeing) only what it creates, writing catalog entries in its own namespace; labels on agents and sandboxes; a signed caller identity on every MCP request; events to the owner by signed webhooks that never block an agent; a live trace of each agent's turns over a hibernated WebSocket, resumable by seq, with its history from the stored transcript; GitHub tokens minted by the broker; creates made idempotent by a key, and a cell asked for only where a route is about one. A special case for one app means the interface is wrong | [control-plane/api/clients/](control-plane/api/clients/) |
| Authority is grants, attenuated from me and revoked down the chain; there's no built-in scoping unit | [agents/tools/](agents/tools/) |
| When an agent is removed, what it owns is parked (stopped, archived, read-only), adoptable, and destroyed after 30 days | [agents/](agents/) |
| An agent ends for good by `agent_stop` from an owner (transitively), by `exit`, or, if ephemeral, when a turn completes with nothing waiting; an end kills or finishes its brain, drops its queued turns, ends what it owns and may destroy the sandbox made for it. An ended agent's records go after 30 days | [agents/](agents/#lifetimes) |
| A sandbox dormant (no agent attached, no VM up) for its idle TTL is destroyed, a day by default per cell (a longer TTL gets a notice a day first, shown in the lifetimes view) | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#lifetime) |
| Inspection without hands is a pure pattern: no `delegate` tool or reader template | [orchestration/captains/](orchestration/captains/) |
| Memory is a capability for long-lived agents only (monitors, personal assistants, captains); ephemeral agents have none and always resume | [agents/](agents/) |
| The memory key index injected at session start is capped at 200 keys, newest first; agents tidy memory as they go, plus a weekly consolidation wake | [agents/](agents/) |
| Agents schedule their own wakes with `wake_at` (once or repeating), a capability backed by AgentDO alarms | [agents/capabilities/](agents/capabilities/) |
| MCP servers are remote only; a local server runs as a sandbox service exposed through ingress | [agents/capabilities/](agents/capabilities/) |
| An agent with memory resumes if its last turn was under an hour ago or its session is under ~50k tokens, otherwise starts fresh from memory | [agents/](agents/) |
| Egress policy is per sandbox (forks inherit); no shared policy objects | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/) |
| A sandbox pushes only to repos on its push allowlist (exact `owner/name`; none by default), enforced by nest-proxy whatever credential a push carries. Repos it may only read get a read-only token of their own: one token's permissions cover all its repos. nest-proxy evaluates only generic request guards; what a service's rules mean is a control-plane constructor's (GitHub's today) | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/#request-guards) |
| Public repos the owner doesn't own are worked on through forks in the owner's account (`github.fork`, always approved; the upstream PR through a compare link) | [agents/capabilities/brokered/](agents/capabilities/brokered/#forks) |
| Taint is tracked per session by the platform; sink calls (egress widening, external brokered actions, MCP tools not marked read-only, `rw` APIs, granting sinks) from a tainted session need approval from me or an untainted holder | [agents/tools/](agents/tools/) |
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
| Turn-end generations: the newest 20 always, up to 200 while under 7 days old; periodic ones thin by tier | [sandbox/state/](sandbox/state/#retention) |
| Drains are gentle (consolidation) or forced (spot notices); a host terminates only after it reports, all or nothing, that its uploads are done (designed; today a spot notice suspends every running sandbox, and no host reports pending uploads) | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| A sandbox pauses, then suspends, only with no agent mid-turn, no live ingress and no hold (`nest hold`) | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#activity-and-idle) |
| A commit's cost follows what changed: the VM pauses only to read its disk (built), then is cut with a reflink while it runs, on instance-store XFS, and only chunks whose extents changed are read (designed, M2 and M3); uploads and the control plane's answer never hold the VM | [sandbox/state/disk/](sandbox/state/disk/) |
| Every commit, pause and suspend requires a guest `syncfs` (designed for guest protocol v2; today nestd asks the v1 guest to `sync()` and goes on if that fails) | [sandbox/state/disk/](sandbox/state/disk/#flush-before-commit) |
| Per-sandbox disk I/O is limited (10,000 ops/s, 100 MiB/s, 30 s burst; designed, not built) | [sandbox/state/disk/](sandbox/state/disk/#io-limits) |
| AWS sandbox hosts are the 8i family only; brain hosts are cheap x86 types (`t3a`/`t3`) on the same AMI | [compute/](compute/), [brain hosts](compute/brain-hosts/) |
| A host's kind comes from its launch template's user data, never from the instance | [compute/provisioning/](compute/provisioning/#host-kind) |
| Everything AWS is per cell, keyed by the cell name: resources, settings (`AWS_CELLS`), the control plane's credentials (`AWS_CELL_CREDENTIALS`), the proxy root CA key and its certificate, which FleetDO derives from the key | [compute/cells/](compute/cells/) |
| Sandbox placement packs onto the fullest host that fits: by free memory less a per-sandbox reserve on regular pages (the default), by free hugepages and vCPUs on a hugepage host | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| Claude Code is the only harness; on a rate limit, park and wait for quota | [orchestration/scheduling/](orchestration/scheduling/) |
| The harness runs on brain hosts; hands are RPC into the sandbox through the gateway; no credentials in VMs or on sandbox hosts | [agents/](agents/) |
| I reach agents through a Discord bot that bridges Discord threads to agents' inboxes and the notification queue | [control-plane/api/discord/](control-plane/api/discord/) |
| No platform API-key proxy; apps bring their own keys | [security/model-access/](security/model-access/) |
| One session artifact: the native session file, tailed on the host. No proxy decrypts OAuth traffic. | [agents/sessions/](agents/sessions/) |
| Sandbox credentials are injected at the proxy by placeholder; GitHub through a GitHub App; OIDC deferred | [security/identity/](security/identity/) |
| Credential bindings name exact hosts (wildcards opt-in), optional methods and whole-segment path prefixes, and allow no upgrade after a substitution | [sandbox/networking/egress/injection/](sandbox/networking/egress/injection/) |
| Inspected requests have CDN routing overrides stripped and smuggling-shaped framing rejected | [sandbox/networking/egress/inspection/](sandbox/networking/egress/inspection/) |
| Non-public destinations are hard-denied ahead of any policy, by nest-proxy and by a kernel rule on its uid; denied guest traffic is rejected, not dropped | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/#hard-deny) |
| A policy change re-checks open connections, and a VM boots only after nest-proxy acknowledges its exact policy | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/#changes) |
| The proxy root CA key is a non-exportable AWS KMS key; hosts send fixed-shape CSRs for intermediates (pathLen 0, about 7 days); leaves last at most 24 h | [sandbox/networking/egress/tls/](sandbox/networking/egress/tls/) |
| Operator tokens are scoped, stored hashed and sent only in headers; one revocation counter invalidates every minted session | [control-plane/api/](control-plane/api/) |
| BrokerDO audits every credential mint, push and refusal (not built); S3 access stays a cell-wide host role | [security/credentials/](security/credentials/) |
| The netns has no uplink: nestd binds nest-proxy's listeners inside it and passes them over; the proxy is unprivileged | [sandbox/networking/egress/](sandbox/networking/egress/) |
| Ingress (previews, terminals, port-forwards) goes through the gateway and over vsock through the guest agent | [sandbox/networking/ingress/](sandbox/networking/ingress/) |
| Reliable channels deliver strictly in order: a gap or a processing failure closes the socket and the sender resends. Each peer process has an `instance_id`; a new one resets the lineage. | [interfaces/control-host/](interfaces/control-host/) |
| A fence is terminal for its epoch, applied on arrival, and never waits on the proxy link | [sandbox/fencing/](sandbox/fencing/) |
| Repo maintenance is a pattern: a maintainer, a worker per task, a clean-context reviewer per PR and a monitor, merging through the repo's own GitHub gates (required checks, the review check pinned to the App, `CODEOWNERS`) | [orchestration/repo-maintenance/](orchestration/repo-maintenance/) |
| GitHub access is a GitHub App; BrokerDO mints installation tokens narrowed per binding | [control-plane/durable-objects/broker/](control-plane/durable-objects/broker/) |
| Control-plane upgrades: expand-only schemas, wire formats compatible one version back, deploys at 100%, DO class changes one-way. Hosts upgrade by replacement, brain hosts before sandbox hosts | [control-plane/](control-plane/#upgrades) |
| Runtime metrics go to Workers Analytics Engine (numbers, enums and ids only), read through the `metrics` capability | [control-plane/metrics/](control-plane/metrics/) |
| nest is two systems with one seam: the sandbox system (hosts, VMs, state, fencing, egress, the gateway) and the agent system (agents, runners). Only two protocols cross it: the SandboxDO control API (with its move notices to attached agents) and the gateway's hands data plane. Co-location is never assumed; there is one hands path, and it goes over the network | [architecture/](architecture/), [sandbox/gateway/](sandbox/gateway/) |
| Sandbox hosts accept no inbound connections: each runs cloudflared, and the gateway sits behind the host's tunnel hostname with an Access service token at the edge, a binding at the gateway and the epoch check in the guest. Tunnel-only to start; a VPC endpoint only if a measurement asks for one | [sandbox/gateway/](sandbox/gateway/) |
| The control plane owns each sandbox host's tunnel and DNS record: created at enrollment before the host exists in the fleet, deleted when the host dies, swept daily, matched only by nest's own names; the Access applications are created by hand | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| A brain has its own epoch, issued by AgentDO at each start; platform tool calls and brokered actions carry it, and hands calls carry the sandbox epoch inside the binding | [control-plane/durable-objects/agent/](control-plane/durable-objects/agent/) |
| Hands journal records stay in the guest; after a crash the runner asks `call_status` through the gateway, and nestd relays nothing about agents | [agents/hands/](agents/hands/) |
| Every brain runs on a brain host: the cheapest instance class that runs Claude Code, no KVM, idle 30 min then terminated. An agent without hands is a brain like any other, and the Discord gateway client is a singleton placed on one brain host; no host kind is reserved for brains without sandboxes | [compute/brain-hosts/](compute/brain-hosts/) |
| A release rolls out control plane, then brain hosts, then sandbox hosts, one canary and a probe gate each; FleetDO holds three desired versions per cell (brain host, sandbox host, guest image), and rollback sets a version back | [compute/provisioning/](compute/provisioning/#upgrades) |
| `api-loop` can hold hands through the gateway (a Durable Object opens one WebSocket per call) and is deferred until the API credits are picked up | [agents/backends/api-loop/](agents/backends/api-loop/) |

## Open questions and watch items

- **Not built:** agent events delivered to owners (principle 9). Until then a child's end, sandbox events (ports, egress denials and alerts), orphaned work and quota parking are only logged, and an approval waiting for me is found per agent (`GET /v1/agents/<id>/asks`), with no cell-wide listing or push. See [agents/tools/](agents/tools/#taint-and-sinks).
- **Verify on EC2:** nestd's delegated cgroup and its start-up kill of leftover VMMs (AL2023's systemd 252, the jailer's `--parent-cgroup`), built for restart recovery and tested only off EC2. See [compute/nestd/](compute/nestd/).
- **Verify on EC2:** the gateway's pause mark against Firecracker (only the process driver was checked), and Claude Code's MCP tool timeout against the runner's 120 s wait for a paused VM, which one last bind can stretch to about 130 s (other `busy`s keep 30 s, keyed on the refusal's `reason: paused`). See [agents/runner/](agents/runner/).
- **Verify:** whether Claude Code's stream-json carries a subagent's own messages (`parent_tool_use_id` set). The runner doesn't read that field, so such messages would reach the live trace unmarked, while the trace history leaves sidechains out. See [trace history](control-plane/api/#trace-history).
- **Watch:** `--bare` may become the default for `claude -p`, which would break subscription auth. The mitigation is the `authMethod` startup check. See [agents/runner/](agents/runner/).
- **Verify:** that separate setup tokens can be revoked independently. See [agents/runner/](agents/runner/).
- **Verify:** that `SessionStart` fires after an automatic compaction under `--disable-slash-commands`. `e2e/claude-verify` could trigger compaction only with `/compact`, which needs slash commands. See [agents/](agents/#continuity).
- **Checked against the real binary** (Claude Code 2.1.316, `e2e/claude-verify` items 11 and 12, 2026-10-31): `PostToolUse` `additionalContext` reaches the model mid-turn under `-p` stream-json, after `mcp__nest__*` and built-in tools alike; a `Stop` `block` gives no intermediate `result`, and `Stop` fires again (`stop_hook_active: true`) before the turn's one `result`. Details: [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/#hooks-checked-on-21316).
- **Resolved (2026-10-31):** a subagent's tool call fires `PostToolUse` too, and its `additionalContext` goes to the subagent, not the main loop (on 2.1.316 the subagent ignored it as an injected instruction). The runner hands out no inbox message to a `PostToolUse` whose input has `agent_id`; the message waits for the main loop's next tool boundary or `Stop`.
- **Checked against the real binary** (Claude Code 2.1.301, `e2e/claude-verify` with a real token, 2026-10-16): the token works under `forceLoginMethod: "claudeai"`, and the stdin shape, the MCP tool-use id, cancellation, the env scrub, the transcript path, interrupted-turn resume, `defer` and `SessionStart` after `/compact` all behave as nest assumes. Two don't: `system/init` arrives only after the first user message, and `--restricted` drops `TodoWrite` even when it's named. The designs already account for both. Details: [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/).

- **Verify:** that Amazon Linux 2023 ships ublk, which the lazy disk needs. See [compute/provisioning/](compute/provisioning/).
- **Verify:** that every 8i variant reports the same CPU model (it's part of the restore ABI); and whether S3 Inventory and lifecycle rules work on S3 Express One Zone directory buckets. See [sandbox/state/](sandbox/state/).
- **Verify on a host:** the unchanged-disk check's trust assumption: every write to a sandbox's disk file (Firecracker's `Sync` engine, on the host's kernel and XFS) moves its modification time before the data lands, and nothing but nestd sets it to the sentinel. Tested only on ext4 and tmpfs off EC2; the rollout's cloud check looks for a reused manifest that didn't match. See [sandbox/state/disk/](sandbox/state/disk/#m1-pause-only-to-read-and-never-read-an-unchanged-disk), [verification/nestd/](verification/nestd/#unchanged-disk-m1).
- **Measure before M2 ships:** on a real host (not production), `FICLONE` time on an aged 32 GiB image (the 200 ms p99 gate for the incremental shadow), and whether Firecracker's `Async` io_engine is fit for production (the reflink cut needs it). Which instance-store types carry sandbox state, and their sizes, is the cell stack's to settle with it. See [sandbox/state/disk/](sandbox/state/disk/#m2-cut-with-a-reflink-while-the-vm-runs-designed-not-built).
- **Not built:** the 60 s dirty-disk timer and the 256 MB dirty threshold. Disks commit at turn end, suspend, drain and spot notice only; a timer needs the reflink cut and the extent diff (M2, M3), so a periodic commit costs only what changed. See [sandbox/state/](sandbox/state/#writeback-cadence).
- **Not built:** retrying a failed turn-end commit. One that times out leaves the head where it was, with nothing surfaced until the next turn ends (seen on EC2 with a cold-snapshot AMI). See [sandbox/state/](sandbox/state/).
- **Open:** guest `init_on_free=1` (for compressible memory snapshots) stalled 1-vCPU guest boots past a minute on a nested 8i host, so it's off until snapshots exist; whether nested hosts can afford it then is unmeasured. See [sandbox/drivers/firecracker/](sandbox/drivers/firecracker/).
- **Open:** per-sandbox I/O limits don't make a dense host fair when many sandboxes spend their burst at once. See [sandbox/state/disk/](sandbox/state/disk/#io-limits).
- **Open:** upgrading the guest agent in place by re-exec, which needs a task registry rebuildable from tmpfs. See [sandbox/guest-agent/](sandbox/guest-agent/#versions).
- **Open:** gate new fleet command variants on the host's capabilities, so a nestd one release behind never meets a batch it can't parse (it no longer loses one silently, but the gap that leaves sends it into a reconnect that resends the same batch, so it takes no further commands until upgraded). See [verification/nestd/](verification/nestd/#open-questions).
- **Open:** resolving upstream names with a DNS client instead of getaddrinfo, so TTL and CNAME caps can apply. Which origins honor `X-Forwarded-Host` and similar overrides is unverified (nest strips them regardless). See [sandbox/networking/egress/dns/](sandbox/networking/egress/dns/).
- **Open:** taint is one bit, so it can't tell sandbox output from outside content; auto-merging agents' PRs relies on keeping outside content from the repo's workers. Recording a taint source would let PRs from sessions that read the web wait for me. See [repo maintenance](orchestration/repo-maintenance/#why-auto-merge-is-safe-enough).
- **Not designed yet:** the sandbox-to-sandbox **link** (an opt-in path through the proxy). See [sandbox/](sandbox/).
- **Measure:** the edge round trip a hands call pays over the tunnel, in the remote-brain arm of the fidelity eval (spike item 10). A VPC endpoint for same-cell brain hosts waits on this number. See [sandbox/gateway/](sandbox/gateway/).
- **Measure:** a worker's wall time inside hands calls per turn, before `api-loop` ships: a Durable Object is billed while an outbound WebSocket is open. See [agents/backends/api-loop/](agents/backends/api-loop/).
- **Open:** how the Durable Objects' protocol logic is checked once it moves into pure cores as nestd's did (the direction names a TypeScript explorer, with Rust cores via WASM for protocols spanning both sides; neither is designed), and whether their design models stay in TLA+ (the pilots) or move to Quint (the survey's pick, for model-based tests). See [verification/](verification/#open-questions).
- **Decide:** the no-capacity placement rollback reuses an epoch number, contrary to "an epoch is never retried", and makes the old holder's salvage fail for good. Keep it and authorize that salvage, or spend an epoch per attempt? See [verification/sandbox-lease/](verification/sandbox-lease/), [SandboxDO](control-plane/durable-objects/sandbox/).
- **Not built:** adopting or parking an ended agent's children (the end is final), and budgets (the spawn caps stand in). See [agents/](agents/#lifetimes).
- **Open:** remote MCP capabilities: OAuth step-up (a 403 `insufficient_scope` needs the operator to authorize again; nothing tells them unprompted); per-agent listing for a server whose tool list depends on the session; fair admission. **Checked:** Claude Code lists again on `notifications/tools/list_changed` from a stdio server under `-p` stream-json, and the model can call the new tool in the same session, mid-turn included (observed on 2.1.316 by `claude-verify` item 13). OAuth ([mcp OAuth](agents/capabilities/mcp/#oauth)), the per-server connector (shared list, admission) and `list_changed` up to `nest mcp` are built; AgentDO still forwards every call. See [agents/capabilities/mcp/](agents/capabilities/mcp/#open-questions).
- **Open:** brokered actions find what a redelivered call already posted by a marker in a bounded read (the last hour's comments on an issue, the 50 newest issues, the 100 newest review comments), so a busy target can hide it and the call posts twice. Not built: `email.send` (no provider), `github.review_check`, `dispatch_workflow`, `create_webhook`, a scan of mcp arguments, and a per-grant `when_tainted` for `egress_policy` (always `approve`). See [agents/capabilities/brokered/](agents/capabilities/brokered/#open-questions).
- **Open:** push allowlists guard GitHub only: another forge's pushes are unguarded once its host is allowed, an allowed package registry takes uploads with someone else's token, GraphQL writes rest on GitHub scoping the installation token (unverified), and LFS uploads to an allowed repo may hit the content-host guard (unverified). An upstream pull request for a fork is the operator's click on a compare link: an action would need a classic PAT. See [policy](sandbox/networking/egress/policy/#open-questions), [forks](agents/capabilities/brokered/#forks).
- **Docs ahead of code:** settled above but not built: hands-call journaling (`call_status`, and `executed: false` beyond the gateway's own refusal; it waits for guest protocol v2), the guest flush before commit, per-sandbox disk I/O limits, and the drain gate's upload report. The runner's session receiver has no gap check (FleetDO's and nestd's do). See [verification/](verification/#real-bugs-found), [sandbox/state/](sandbox/state/).

## First spike

On a c8id with nested virtualization and a hugepage pool:
1. Cold boot until the guest agent is ready, against a restore from a base memory generation.
2. Disk-only resume through `claude --resume`.
3. Hugepage UFFD resume from page cache, NVMe and S3 Express (no public benchmark of 2 MB UFFD restores exists). This also qualifies the pinned (Firecracker, guest kernel) pair for memory restore; until it passes, hosts create no memory generations ([restore ABI](sandbox/state/memory/#restore-abi)).
4. Time to write a full snapshot at 2 and 4 GB.
5. A dev server's first response after resume.
6. ublk lazy-disk throughput.
7. Commit latency under write load, including the guest flush and the reflink cut.
8. Forced-partition test: self-fence, then STONITH, then restore.
9. **First real Claude Code run** through the runner (the verification list above). It needs no KVM, so it runs in the cloud dev environment through the e2e harness, with the token as `NEST_CLAUDE_OAUTH_TOKEN`. **Done** (2026-10-16, Claude Code 2.1.301, `NEST_E2E_CLAUDE=real e2e/run.sh`): a real turn ran entirely through `mcp__nest__` hands (Bash, Write, Read, Edit), with no host-side built-ins and the token absent from the sandbox. All 21 checks passed, including self-fencing 20 s after the control plane was cut.
10. **Hands fidelity eval:** the same tasks with native tools (Claude Code inside a VM), with RPC hands from a brain on the same machine, and with hands from a remote brain through the gateway and the tunnel; compare success rate, turns and tokens, and record the per-call round trip of the remote arm. The same eval gates every upgrade of the pinned Claude Code version ([runner](agents/runner/)).
11. **Nested overhead:** CPU and I/O on a nested 8i instance against the same work on `.metal`.
12. **Resume or fresh:** turn cost and quality when resuming a long session after the cache expired, against a fresh session seeded from memory.
13. **The seam:** a brain on a cell host drives its own sandbox through the tunnel: its target is `wss://<host>-gw-nest.<zone>`, so every hands call leaves the host, crosses Cloudflare's edge and Access, and returns down the tunnel into the gateway. Proven on 2026-10-23: a real Claude Code agent in `use1` completed the Python task (F(90)) against `wss://<host>-gw-nest.bitcru.sh`, the host's cloudflared held four QUIC connections to the edge, and the gateway logged every call `bound … via="edge"` (a `cf-ray` header on the upgrade; a direct connection logs `via=direct`); twelve minutes after the sandbox was destroyed the idle host was retired and its tunnel and DNS record were gone from the account. One readiness blip was seen (a single failed `/ready` probe flipped the state to `connecting` for 2 s), so a brain resolving in that window waits one retry. The second half ran the same evening with two cell hosts: the sandbox on one, the brain started on the other (`POST /v1/agents/<id>/start {host}`), `resolve` pointing at the sandbox host's tunnel hostname with the edge credential; the first attempt was refused at the edge (the policy's action was Allow, not Service Auth); with the action fixed on 2026-10-24 the brain on one cell host completed the Python task against the sandbox on the other, every hands call crossing Access and the tunnel. The same with the real brain host kind ran on 2026-10-29: two workers' brains on a brain host each drove its own sandbox on a sandbox host through hands ([gateway](sandbox/gateway/), [brain hosts](compute/brain-hosts/)).

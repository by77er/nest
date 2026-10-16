# nest

A personal platform that combines sandboxes with durable agents. Long-lived Claude Code agents run on my own subscription. Their brains run on hosts, and their hands work in isolated VMs on commodity cloud compute. Agents organize themselves: captains, teams and pipelines are structures they build from a few primitives, not platform features. Everything scales to zero.

**Status:** early implementation. The runtime (control plane, nestd, nest-proxy, guest agent, agent runner, `nest` CLI) exists and is tested locally; each crate or package README says what is built and what is missing. A local end-to-end harness (`e2e/`) runs the real components together. Nothing has run on real hardware yet: there's no KVM here, so Firecracker is untested. Designed but not built: the coordination layer (channels, hooks, grants, capabilities, spawn specs, scheduled wakes), the Discord bot, the autoscaler and the preview router; `control-plane/README.md` lists the gaps.

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
8. **Claude Code runs unmodified, outside the VMs.** The subscription token never enters a sandbox. Agents act on sandboxes only through RPC hands.

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
| `crates/nest-cli` | `nest` binary: `nest hook`, `nest mcp`, in-sandbox commands |
| `protocol/` | Fixtures, tool catalogs, Claude Code reference artifacts |
| `e2e/` | Local end-to-end harness |
| `.github/`, `scripts/` | CI and `CODEOWNERS`; repo checks |
| `dev/` | Developing this repo: CI, deploys, repo settings (outside the design docs) |

UFFD memory snapshots, the ublk lazy disk, the S3 object store and spot-notice handling are designed but not built (see `crates/nestd/README.md`).

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
sandbox         drivers · state · fencing · networking · guest agent                   sandbox/
compute         cells · controller/burst hosts · nestd · autoscaling · provisioning    compute/
control plane   Cloudflare Workers + Durable Objects · API · activator                 control-plane/
cross-cutting   security (authority, model access, identity, credentials) · data      security/  data/
contracts       boundary interfaces (wire protocols, tool schemas)                     interfaces/
```

See [architecture/](architecture/) for the system diagram, components, a turn end to end, failure handling, state and trust boundaries. The layers in detail: [orchestration/](orchestration/), [agents/](agents/), [channels/](channels/), [sandbox/](sandbox/), [compute/](compute/), [control-plane/](control-plane/), [security/](security/), [data/](data/), [interfaces/](interfaces/) and [setup/](setup/).

## Glossary

| Term | Meaning |
|---|---|
| Sandbox | A VM: volumes, processes, network. Holds 0..N attached agents. |
| Agent | A brain (Claude Code on a host, on my subscription) plus optional hands, grants and subscriptions. There are no agent roles. |
| Agent runner | Host component that starts, drives and tails Claude Code processes |
| Hands | `nest` MCP tools modeled on Claude Code's built-ins, executed in a sandbox by the guest agent |
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
| Controller host | A small, always-on, stateless host: nestd (no sandboxes), brains without hands, and the Discord gateway |
| Burst host | A spot VM with nested virtualization running Firecracker sandboxes (all sandboxes live here) |
| Captain | A pattern, not a platform concept: an agent without hands, spawned from the `captain` template, that manages other agents and escalates to me |
| Workstream | A pattern, not a platform concept: a goal plus the channel, sandboxes and agents set up for it, grouped by a label |
| nestd | Per-host daemon |
| nest-proxy | Per-host egress proxy |
| Guest agent | Hands server inside each sandbox VM. Holds no credentials. |
| `nest mcp` / `nest` | `nest mcp`: the host-side stdio MCP bridge that Claude Code spawns. `nest`: the CLI used for hooks and inside sandboxes. |

## Settled decisions

| Decision | Owning doc |
|---|---|
| Rust on the host side (nestd, nest-proxy, guest agent, UFFD/ublk, CLI); TypeScript for the control plane | this file |
| Workers Paid ($5/mo) | [control-plane/](control-plane/) |
| Hosts authenticate with signed instance identity documents; guests can't reach IMDS | [compute/provisioning/](compute/provisioning/) |
| No agent roles. Placement follows hands; an agent without hands needs no machine. The brain backend is pluggable (`claude-code` now, `api-loop` inside the control plane later). | [agents/](agents/) |
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
| New sandboxes restore a base memory generation per (image, ABI), falling back to cold boot; no warm pools | [sandbox/state/memory/](sandbox/state/memory/#base-generations) |
| Placement is a fenced claim in SandboxDO: the epoch is issued at claim, completion is one compare-and-set checked against host evidence, an epoch is never retried, and every loss is recorded | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#placement) |
| One `isRestoreSource` predicate decides resume, the drain gate and GC; deleting a generation is one-way | [sandbox/state/](sandbox/state/#restore-sources) |
| Turn-end generations are always kept; periodic ones thin by tier | [sandbox/state/](sandbox/state/#retention) |
| Drains are gentle (consolidation) or forced (spot notices); a host terminates only after it reports, all or nothing, that its uploads are done | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| A sandbox pauses, then suspends, only with no agent mid-turn, no live ingress and no hold (`nest hold`) | [control-plane/durable-objects/sandbox/](control-plane/durable-objects/sandbox/#activity-and-idle) |
| Every commit, pause and suspend requires a guest `syncfs` | [sandbox/state/disk/](sandbox/state/disk/#flush-before-commit) |
| Per-sandbox disk I/O is limited (10,000 ops/s, 100 MiB/s, 30 s burst) | [sandbox/state/disk/](sandbox/state/disk/#io-limits) |
| The AWS burst fleet is the 8i family only | [compute/](compute/) |
| Placement packs by free hugepages | [control-plane/durable-objects/fleet/](control-plane/durable-objects/fleet/) |
| Claude Code is the only harness; on a rate limit, park and wait for quota | [orchestration/scheduling/](orchestration/scheduling/) |
| The harness runs on the host; hands are RPC into the sandbox; no credentials in VMs | [agents/](agents/) |
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
| Ingress (previews, terminals, port-forwards) goes over vsock through the guest agent | [sandbox/networking/ingress/](sandbox/networking/ingress/) |
| Reliable channels deliver strictly in order: a gap or a processing failure closes the socket and the sender resends. Each peer process has an `instance_id`; a new one resets the lineage. | [interfaces/control-host/](interfaces/control-host/) |
| A fence is terminal for its epoch, applied on arrival, and never waits on the proxy link | [sandbox/fencing/](sandbox/fencing/) |
| Repo maintenance is a pattern: a maintainer, a worker per task, a clean-context reviewer per PR and a monitor, merging through the repo's own GitHub gates (required checks, the review check pinned to the App, `CODEOWNERS`) | [orchestration/repo-maintenance/](orchestration/repo-maintenance/) |
| GitHub access is a GitHub App; BrokerDO mints installation tokens narrowed per binding | [control-plane/durable-objects/broker/](control-plane/durable-objects/broker/) |
| Control-plane upgrades: expand-only schemas, wire formats compatible one version back, deploys at 100%, DO class changes one-way. Hosts upgrade by replacement | [control-plane/](control-plane/#upgrades) |
| Runtime metrics go to Workers Analytics Engine (numbers, enums and ids only), read through the `metrics` capability | [control-plane/metrics/](control-plane/metrics/) |

## Open questions and watch items

- **Watch:** `--bare` may become the default for `claude -p`, which would break subscription auth. The mitigation is the `authMethod` startup check. See [agents/runner/](agents/runner/).
- **Verify:** that separate setup tokens can be revoked independently. See [agents/runner/](agents/runner/).
- **Verify:** that `SessionStart` fires after an automatic compaction under `--disable-slash-commands`. `e2e/claude-verify` could trigger compaction only with `/compact`, which needs slash commands. See [agents/](agents/#continuity).
- **Checked against the real binary** (Claude Code 2.1.301, `e2e/claude-verify` with a real token, 2026-10-16): the token works under `forceLoginMethod: "claudeai"`, and the stdin shape, the MCP tool-use id, cancellation, the env scrub, the transcript path, interrupted-turn resume, `defer` and `SessionStart` after `/compact` all behave as nest assumes. Two don't: `system/init` arrives only after the first user message, and `--restricted` drops `TodoWrite` even when it's named. The designs already account for both. Details: [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/).

- **Verify:** that Amazon Linux 2023 ships ublk, which the lazy disk needs. See [compute/provisioning/](compute/provisioning/).
- **Verify:** that every 8i variant reports the same CPU model (it's part of the restore ABI); that Firecracker's writes pass through the host page cache before ublk; and whether S3 Inventory and lifecycle rules work on S3 Express One Zone directory buckets. See [sandbox/state/](sandbox/state/).
- **Open:** turn-end generations are always kept, so a long-lived sandbox's history grows without bound; it may need a cap. See [sandbox/state/](sandbox/state/#retention).
- **Open:** per-sandbox I/O limits don't make a dense host fair when many sandboxes spend their burst at once. See [sandbox/state/disk/](sandbox/state/disk/#io-limits).
- **Open:** upgrading the guest agent in place by re-exec, which needs a task registry rebuildable from tmpfs. See [sandbox/guest-agent/](sandbox/guest-agent/#versions).
- **Open:** resolving upstream names with a DNS client instead of getaddrinfo, so TTL and CNAME caps can apply. Which origins honor `X-Forwarded-Host` and similar overrides is unverified (nest strips them regardless). See [sandbox/networking/egress/dns/](sandbox/networking/egress/dns/).
- **Open:** taint is one bit, so it can't tell sandbox output from outside content; auto-merging agents' PRs relies on keeping outside content from the repo's workers. Recording a taint source would let PRs from sessions that read the web wait for me. See [repo maintenance](orchestration/repo-maintenance/#why-auto-merge-is-safe-enough).
- **Not designed yet:** the sandbox-to-sandbox **link** (an opt-in path through the proxy). See [sandbox/](sandbox/).

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
9. **First real Claude Code run** through the runner (the verification list above). It needs no KVM, so it runs in the cloud dev environment through the e2e harness, with the token as `NEST_CLAUDE_OAUTH_TOKEN`.
10. **Hands fidelity eval:** the same tasks with native tools (Claude Code inside a VM) and with RPC hands; compare success rate, turns and tokens. The same eval gates every upgrade of the pinned Claude Code version ([runner](agents/runner/)).
11. **Nested overhead:** CPU and I/O on a nested 8i instance against the same work on `.metal`.
12. **Resume or fresh:** turn cost and quality when resuming a long session after the cache expired, against a fresh session seeded from memory.

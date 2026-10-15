# nest

A personal platform that combines sandboxes with durable agents. Long-lived Claude Code agents run on my own subscription. Their brains run on hosts, and their hands work in isolated VMs on commodity cloud compute. Agents organize themselves: captains, teams and pipelines are structures they build from a few primitives, not platform features. Everything scales to zero.

**Status:** early implementation. Every component exists, and each crate or package README says what is built and what is missing. A local end-to-end harness (`e2e/`) runs the real components together. Nothing has run on real hardware yet: there's no KVM here, so Firecracker is untested. Channels, grants and spawn specs are designed but not built (see `control-plane/README.md`). Everything needed to bring nest up (accounts, credentials, where they go) is in [setup/](setup/).

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

UFFD memory snapshots and the ublk lazy disk are designed but not built.

## Primitives

| Primitive | What | Doc |
|---|---|---|
| **Sandbox** | A machine: volumes, processes, network | [sandbox/](sandbox/) |
| **Agent** | A brain with optional hands in one sandbox, plus grants and subscriptions | [agents/](agents/) |
| **Channel** | A named, durable, append-only log that agents, sandbox programs, the platform and I post to, read and subscribe to | [channels/](channels/) |

- **Operations:** create, **attach** (bind an agent's hands to a sandbox), **fork** (copy a sandbox; the only isolation primitive), **spawn** (an agent creates an agent), **post / read / subscribe**, **grant / revoke**.
- **On every resource:** an **owner** (the agent that created it, or me) and **labels** (free-form key/values).
- **Capabilities:** pluggable bundles of tools, grants and prompt instructions (messaging, channels, spawning, memory, …).
- **Templates:** named spawn specs, mostly a list of capabilities, stored as data. `captain` and `worker` are templates.

Captains, workstreams and teams are patterns built from these. See [orchestration/](orchestration/).

## Layers

```
patterns        captains · workstreams (templates + conventions) · quota scheduling  orchestration/
agents          backends · runner · hands · sessions · state tracking · tools          agents/
channels        logs · subscriptions · wakes                                           channels/
sandbox         drivers · state · fencing · networking · guest agent                   sandbox/
compute         cells · controller/burst hosts · nestd · autoscaling                   compute/
control plane   Cloudflare Workers + Durable Objects · API · activator                 control-plane/
cross-cutting   security (authority, model access, identity, credentials) · data      security/  data/
contracts       boundary interfaces (wire protocols, tool schemas)                     interfaces/
```

See [orchestration/](orchestration/), [agents/](agents/), [channels/](channels/), [sandbox/](sandbox/), [compute/](compute/), [control-plane/](control-plane/), [security/](security/), [data/](data/), [interfaces/](interfaces/) and [setup/](setup/).

```
 you / webhooks / email ──► Cloudflare: Worker API + Durable Objects (control plane, R2)
                                   ▲ hibernatable WebSockets (hosts dial out)
                 ┌─────────────────┴──────────────────┐
        controller host (always on,          burst hosts (spot, scale to zero)
        stateless, no sandboxes)              Firecracker sandboxes
        agent runner (brains without hands)   agent runner (brains with hands) · nestd
        Discord gateway                       nest-proxy · cloudflared
                                                      └── S3 (sandbox state, per cell)
```

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
| Subscription | An agent's wake rule on a channel: a filter plus how matches are delivered |
| Grant | Permission for a principal to do an action on a resource. Passed on only by someone who holds it. |
| Owner | Whoever created a resource. Holds every grant on it. |
| Taint | A per-session bit the platform sets when a session reads untrusted content (hands output, the web, other agents' tainted posts) |
| Sink | An action that can send data out or widen authority; from a tainted session it needs approval |
| Capability | A pluggable bundle of tools, the grants they need and prompt instructions, listed in spawn specs |
| Template | A named spawn spec (prompt, capabilities, grants, subscriptions, backend), stored as data |
| Generation | Immutable manifest of a sandbox's disk (and optionally memory) chunks |
| Epoch | Fencing token. It increments each time a sandbox's lease is granted. |
| Cell | A unit of compute plus its object store (e.g. AWS us-east-1 with S3) |
| Controller host | A small, always-on, stateless host: brains without hands, and the Discord gateway. No sandboxes. |
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
| Coordination is one primitive: channels. Inboxes, platform events, questions, shared state and memory are channels. | [channels/](channels/) |
| Authority is grants, attenuated from me and revoked down the chain; there's no built-in scoping unit | [agents/tools/](agents/tools/) |
| When an agent is removed, what it owns is parked (stopped, archived, read-only), adoptable, and destroyed after 30 days | [agents/](agents/) |
| Inspection without hands is a pure pattern: no `delegate` tool or reader template | [orchestration/captains/](orchestration/captains/) |
| A wake resumes the session if the last turn was under an hour ago or the session is under ~50k tokens, otherwise starts fresh from memory | [agents/](agents/) |
| Channel message bodies older than 7 days move to R2; the index and keyed view stay in SQLite | [channels/](channels/) |
| Egress policy is per sandbox (forks inherit); no shared policy objects | [sandbox/networking/egress/policy/](sandbox/networking/egress/policy/) |
| Guardrails start "balanced": 60 subscription-started turns an hour per agent, a 50-delivery backlog, 30-day retention, approval for egress widening and granting sinks | [channels/](channels/) |
| Taint is tracked per session by the platform; sink calls (egress widening, external brokered actions, granting sinks) from a tainted session need approval from me or an untainted holder | [agents/tools/](agents/tools/) |
| A woken turn gets a platform notice; other agents' message bodies reach a model only as `read` results | [channels/](channels/) |
| Budgets (depth, concurrency, spawns, turns) shrink like grants and are enforced per owner subtree; quota is divided by priority and the concurrency cap, not by estimated shares | [orchestration/scheduling/](orchestration/scheduling/) |
| Hands calls are journaled (intent, outcome); after a crash, in-flight calls are reported as unknown, never retried | [agents/hands/](agents/hands/) |
| Memory snapshots carry a restore ABI and restore only on matching hosts; the burst fleet is the 8i family; placement packs | [sandbox/state/memory/](sandbox/state/memory/) |
| Claude Code is the only harness; on a rate limit, park and wait for quota | [orchestration/scheduling/](orchestration/scheduling/) |
| The harness runs on the host; hands are RPC into the sandbox; no credentials in VMs | [agents/](agents/) |
| I reach agents through a Discord bot that bridges Discord channels and threads to nest channels | [control-plane/api/discord/](control-plane/api/discord/) |
| No platform API-key proxy; apps bring their own keys | [security/model-access/](security/model-access/) |
| One session artifact: the native session file, tailed on the host. No proxy decrypts OAuth traffic. | [agents/sessions/](agents/sessions/) |
| Sandbox credentials are injected at the proxy by placeholder; GitHub through a GitHub App; OIDC deferred | [security/identity/](security/identity/) |
| The netns has no uplink: nestd binds nest-proxy's listeners inside it and passes them over; the proxy is unprivileged | [sandbox/networking/egress/](sandbox/networking/egress/) |
| Ingress (previews, terminals, port-forwards) goes over vsock through the guest agent | [sandbox/networking/ingress/](sandbox/networking/ingress/) |
| Reliable channels deliver strictly in order: a gap or a processing failure closes the socket and the sender resends. Each peer process has an `instance_id`; a new one resets the lineage. | [interfaces/control-host/](interfaces/control-host/) |
| A fence is terminal for its epoch, applied on arrival, and never waits on the proxy link | [sandbox/fencing/](sandbox/fencing/) |

## Open questions and watch items

- **Watch:** `--bare` may become the default for `claude -p`, which would break subscription auth. The mitigation is the `authMethod` startup check. See [agents/runner/](agents/runner/).
- **Verify:** that `CLAUDE_CODE_OAUTH_TOKEN` is accepted under `forceLoginMethod: "claudeai"`, and that separate setup tokens can be revoked independently. See [agents/runner/](agents/runner/).
- **Verify against the real Claude Code binary** (never run here; the tests use a fake):
  - whether `system/init` arrives before the first user message (documented as the first event after hook events)
  - the stdin user-message shape without `session_id`
  - the `_meta` key carrying the tool-use id on MCP `tools/call` (undocumented; `PreToolUse` input has `tool_use_id` to correlate instead)
  - that `--restricted` honors the `--tools` built-in list (documented)
  - that `notifications/cancelled` reaches MCP on interrupt
  - the `claude auth status` JSON (`authMethod` and `configDirectory` are documented)
  - that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps `NEST_*`
  - the transcript path encoding (non-alphanumerics become `-`; the hashing of paths over 200 characters is undocumented)
  - `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` and `PreToolUse` `defer` under stream-json input
  - that a `SessionStart` hook fires after compaction (to re-inject the memory index)

  See [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/).

## First spike

On a c8id with nested virtualization and a hugepage pool:
1. Cold boot until the guest agent is ready.
2. Disk-only resume through `claude --resume`.
3. Hugepage UFFD resume from page cache, NVMe and S3 Express (no public benchmark of 2 MB UFFD restores exists).
4. Time to write a full snapshot at 2 and 4 GB.
5. A dev server's first response after resume.
6. ublk lazy-disk throughput.
7. Epoch-flip commit latency under write load.
8. Forced-partition test: self-fence, then STONITH, then restore.
9. **First real Claude Code run** through the runner (the verification list above). It needs no KVM, so it runs in the cloud dev environment through the e2e harness, with the token as `NEST_CLAUDE_OAUTH_TOKEN`.
10. **Hands fidelity eval:** the same tasks with native tools (Claude Code inside a VM) and with RPC hands; compare success rate, turns and tokens.
11. **Nested overhead:** CPU and I/O on a nested 8i instance against the same work on `.metal`.
12. **Resume or fresh:** turn cost and quality when resuming a long session after the cache expired, against a fresh session seeded from memory.

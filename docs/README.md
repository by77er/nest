# nest

A personal platform that combines sandboxes with durable agents. Long-lived Claude Code agents run on my own subscription. Their brains run on hosts, and their hands work in isolated VMs on commodity cloud compute. Captains orchestrate the agents. Everything scales to zero.

**Status:** early implementation. Every component exists, and each crate or package README says what is built and what is missing. A local end-to-end harness (`e2e/`) runs the real components together. Nothing has run on real hardware yet: there's no KVM here, so Firecracker is untested.

## Goals

- Run many agents in parallel, each in an isolated VM, on cheap cloud compute (AWS spot first, with other providers kept possible).
- **Durable:** an agent can wait days for an event at near-zero cost and survive losing its host.
- **Scale to zero:** an idle system costs close to nothing.
- **Captains:** assistants that manage several workstreams, receive their events and escalate to me.
- **Use my Claude Code subscription** (Claude Code is the only harness for now). Apps in sandboxes bring their own API keys; that isn't a platform concern.

## Principles

1. **Mechanism, not policy.** Primitives make no assumptions about the work inside them: no git, no worktrees, no port conventions.
2. **The sandbox is the trust boundary.** Everything inside one sandbox shares a trust domain.
3. **Decisions on the agent's hot path are local; everything else is async.** Hooks never wait on the network.
4. **Each piece of data lives next to its main reader.** Metadata lives in Durable Objects, bookkeeping in R2 and sandbox bytes in S3.
5. **One writer per entity, fenced by epochs.** Each entity has a single Durable Object, and stale writers are rejected.
6. **Claude Code runs unmodified, outside the VMs.** The subscription token never enters a sandbox. Agents act on sandboxes only through RPC hands.

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

**Sandbox** (a machine), **agent** (a Claude Code brain plus optional hands), **attach** (bind an agent's hands to a sandbox) and **fork** (copy a sandbox; this is the only isolation primitive). Workstreams and captains are built on top of these.

## Layers

```
orchestration   captains · workstreams · quota-aware scheduling        orchestration/
agents          runner · hands · sessions · state tracking · tools    agents/
sandbox         drivers · state · fencing · networking · guest agent  sandbox/
compute         cells · controller/burst hosts · nestd · autoscaling  compute/
control plane   Cloudflare Workers + Durable Objects · API · activator control-plane/
cross-cutting   security (model access, identity, credentials) · data security/  data/
contracts       boundary interfaces (wire protocols, tool schemas)  interfaces/
```

See [orchestration/](orchestration/), [agents/](agents/), [sandbox/](sandbox/), [compute/](compute/), [control-plane/](control-plane/), [security/](security/), [data/](data/) and [interfaces/](interfaces/).

```
 you / webhooks / email ──► Cloudflare: Worker API + Durable Objects (control plane, R2)
                                   ▲ hibernatable WebSockets (hosts dial out)
                 ┌─────────────────┴──────────────────┐
        controller host (always on,          burst hosts (spot, scale to zero)
        stateless, no sandboxes)              Firecracker sandboxes
        agent runner (captains)               agent runner (workers) · nestd
        Discord gateway                       nest-proxy · cloudflared
                                                      └── S3 (sandbox state, per cell)
```

## Glossary

| Term | Meaning |
|---|---|
| Sandbox | A VM: volumes, processes, network. Holds 0..N attached agents. |
| Agent | A brain (Claude Code on a host, on my subscription) plus optional hands (RPC tools into one sandbox) |
| Agent runner | Host component that starts, drives and tails Claude Code processes |
| Hands | `nest` MCP tools modeled on Claude Code's built-ins, executed in a sandbox by the guest agent |
| Attach | Bind an agent's hands to a sandbox |
| Fork | Copy-on-write copy of a sandbox (disk only, or live with memory) |
| Generation | Immutable manifest of a sandbox's disk (and optionally memory) chunks |
| Epoch | Fencing token. It increments each time a sandbox's lease is granted. |
| Cell | A unit of compute plus its object store (e.g. AWS us-east-1 with S3) |
| Controller host | A small, always-on, stateless host: the captain runner and the Discord gateway. No sandboxes. |
| Burst host | A spot VM with nested virtualization running Firecracker sandboxes (all sandboxes live here) |
| Captain | An agent with no machine: state and tools live in the control plane, and inference comes from a pluggable backend |
| Workstream | A goal, spec and budget, plus the agents and sandboxes serving it |
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
| Captains have no machine: control-plane state and tools, with a pluggable backend (`claude-code` on the controller host now, `api-loop` on Cloudflare later) | [orchestration/captains/](orchestration/captains/) |
| Claude Code is the only harness; on a rate limit, park and wait for quota | [orchestration/scheduling/](orchestration/scheduling/) |
| The harness runs on the host; hands are RPC into the sandbox; no credentials in VMs | [agents/](agents/) |
| Agents never attach across workstreams; captains inspect through `delegate` (a read-only worker in an ephemeral fork) | [agents/](agents/) |
| I reach captains through a Discord bot | [control-plane/api/discord/](control-plane/api/discord/) |
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
  - whether `system/init` arrives before the first user message
  - the stdin user-message shape without `session_id`
  - the `_meta` key carrying the tool-use id on MCP `tools/call`
  - that `--restricted` honors the worker's built-in tool list
  - that `notifications/cancelled` reaches MCP on interrupt
  - the `claude auth status` JSON
  - that `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` keeps `NEST_*`
  - the transcript path encoding

  See [interfaces/host-internal/runner-claude/](interfaces/host-internal/runner-claude/).

## First spike

On a c8id with nested virtualization and a hugepage pool:
1. Cold boot until the guest agent is ready.
2. Disk-only resume through `claude --resume`.
3. Hugepage UFFD resume from page cache, NVMe and S3.
4. Time to write a full snapshot at 2 and 4 GB.
5. A dev server's first response after resume.
6. ublk lazy-disk throughput.
7. Epoch-flip commit latency under write load.
8. Forced-partition test: self-fence, then STONITH, then restore.
9. **First real Claude Code run** through the runner (the verification list above).
10. **Hands fidelity eval:** the same tasks with native tools (Claude Code inside a VM) and with RPC hands; compare success rate, turns and tokens.

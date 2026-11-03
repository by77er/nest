# Tools

`nest mcp` runs on the brain host next to each brain. An agent's tools come from its [capabilities](../capabilities/), and every call is checked against its grants; there are no role-specific tools.

| Group | Tools | Executes |
|---|---|---|
| **[Hands](../hands/)** | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskOutput`, `TaskStop` | In the bound sandbox, through its [gateway](../../sandbox/gateway/) |
| **Agents** | `agent_spawn`, `agent_stop`, `exit` (end itself; every agent's, never gated), `attach`, `adopt` (take ownership of a parked resource), `wake_at` and `wake_cancel` (scheduled wakes on itself), `read_transcript`, `list` (any resource kind, filtered by labels) | Control plane |
| **Sandboxes** | `sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy` | Control plane |
| **Authority** | `grant`, `revoke` | Control plane |
| **Brokered actions** | `github.create_pr`, `github.review_check`, `github.review_comment`, `github.comment`, `github.create_issue`, `github.dispatch_workflow`, `github.create_webhook`, `email.send`, `http.request(profile)`; each is its own tool (`github_create_pr`, …, `http_request`), and `brokered{action, args}` reaches them all ([brokered](../capabilities/brokered/#tools)) | Control plane, with secrets that never reach a sandbox |
| **Metrics** | `metrics_query` (see [metrics](../../control-plane/metrics/)) | Control plane → Analytics Engine |

**Built:** the table is the design. The registry (`protocol/schemas/control/platform-tools.json`) holds interim tools that predate grants: `read_transcript` (on itself or an agent it owns, transitively), `expose_port` and `egress_policy` work; `fork_sandbox`, `attach`, `checkpoint` and the seeded `management` and `memory` capabilities' tools answer `not_implemented`. `agent_spawn`, `agent_stop` and `exit` are built ([lifetimes](../#lifetimes)). Brokered actions are built except `github.review_check`, `github.dispatch_workflow`, `github.create_webhook` and `email.send` ([brokered](../capabilities/brokered/)). Hands are built ([hands](../hands/)).

**Coordination tools are not platform tools.** Messaging, shared state, memory and external events are external integrations an agent reaches over MCP ([principle 9](../../README.md#principles)); the platform's part is the agent's inbox, which an integration posts to over the public API. A stored spec naming a tool the registry lacks still starts: the tool isn't offered, and a call answers `unknown_tool`.

## Grants

A grant is `(principal, action, resource, limits?, expires?, parent)`. A resource is an id, a label selector (`sandbox{project=auth}`), or `own` (whatever the principal owns, now or later).

- **Attenuation:** an agent can grant, or put in a spawn spec, only grants it holds, with equal or tighter limits. I hold the root, so authority flows down from me and only shrinks.
- **The chain is the revocation list:** each grant records its `parent` and is valid only while every ancestor is. Limits intersect down the chain. Revoking a grant revokes everything derived from it, and the grants an agent issued end when it's removed. Every call is checked online against one store, so no signed tokens are needed; attenuable tokens ([Biscuit](https://doc.biscuitsec.org/reference/specifications), the [IETF attenuating agent tokens draft](https://www.ietf.org/archive/id/draft-niyikiza-oauth-attenuating-agent-tokens-01.html)) solve offline and cross-domain checks, which nest doesn't have.
- **Ownership:** creating a resource gives its creator every grant on it. Built for agents only: the child's `owner`, checked transitively by `agent_stop` ([spawning](../#spawning)). A sandbox `agent_spawn` makes is owned by the child it is made for.
- **Budgets shrink like grants:** see [spawning](../#spawning). An agent over budget is parked and escalates.
- **Checked twice:** AgentDO filters `tools_list` by grants, then checks every `tool_call` again.
- **Approval:** a sink call from a tainted session under `when_tainted: approve` first asks the operator (see [taint and sinks](#taint-and-sinks)).

## Taint and sinks

An agent that reads untrusted content, holds private data and can send data out can be made to leak it: the [lethal trifecta](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) (2025-06), also framed as the [Agents Rule of Two](https://ai.meta.com/blog/practical-ai-agent-security/) (2025-10). Model robustness helps but isn't a boundary: adaptive attacks broke 12 published defenses at over 90% ([2025-10](https://arxiv.org/abs/2510.09023)). So nest tracks what each session has read, the way [CaMeL](https://arxiv.org/abs/2503.18813) and [FIDES](https://arxiv.org/abs/2505.23643) label data, but per session, which is cheap:

- **Taint is one bit per session, kept by AgentDO and set only by the platform.** It's set by hands output, `WebFetch`/`WebSearch` results, `mcp` and `api` capability results, `read_transcript`, a tainted inbox message, and tainted results from an integration. It lasts for the session (a `--resume` keeps it).
- **It propagates:** a spawned agent starts with its spawner's taint, and an inbox message carries its sender's taint.
- **Sinks** are the actions that can send data out or widen authority: widening an egress policy, external brokered actions, `mcp` tools not marked read-only, `api` capabilities with `mode: rw`, and granting a sink action. Each sink grant carries `when_tainted: approve | allow` (default `approve`), and attenuation can only tighten it.
- **A sink call from a tainted session** with `approve` asks for approval. Only I or an untainted holder of that grant can approve it (built: the operator, or the [API client](../../control-plane/api/clients/) whose subtree the agent is in; no agent can answer an ask, and the seeded `approve`/`deny` tools answer `not_implemented`).
- **One gate for every sink (built):** a remote MCP tool, a brokered action and `egress_policy` widening all go through the same gate (`control-plane/src/lib/sinks.ts`, AgentDO's `sinkGate`). A gated call isn't sent: it answers `pending` with an ask id, and the operator is asked once per exact call (the same sink with the same arguments asked again before a decision gets the same ask). **Approvals are a kernel gate:** the held call is recorded in AgentDO, listed by `GET /v1/agents/<id>/asks` (`{ask, question, created_ms, approval?: {name, tool}}`, oldest first) with every other open ask (a call a tool rule in `ask` mode held), and answered by `POST /v1/agents/<id>/asks/<ask>/answer`; the decision arrives as the agent's next turn (`ask_answer`). An API client owner is also sent each one as an `agent.ask` event by webhook ([events to the owner](../../control-plane/api/clients/#events-to-the-owner)); an owner agent is told nothing. An approval lets through **one** call of that sink with exactly those arguments (SHA-256 of their canonical JSON) within an hour, whichever tool reaches it (`github_create_issue` or `brokered{action: github.create_issue}`); the model calls again. A redelivery of the call it was spent on uses it again. The details and the reason it's asynchronous are in [mcp sinks](../capabilities/mcp/#sinks).
- **Built so far:** a conservative stand-in kept by AgentDO: a session is tainted if the agent has hands or a web built-in, or once another agent's text reached it that may be tainted (sticky): an inbox post relayed under another name than `user`, a spawn's task from a tainted spawner, or another agent's transcript. An untrusted [mcp capability](../capabilities/mcp/#taint)'s tool list or results set it too (a `trusted` one's don't). It guarantees that no such text, and nothing from a sandbox, the web or an untrusted MCP server, reaches a session that then posts untainted; the operator's own text never taints. It over-taints freely (a captain that reads a hands worker's result once is tainted for good). The sinks checked: remote MCP tools ([mcp sinks](../capabilities/mcp/#sinks)), brokered actions ([brokered](../capabilities/brokered/#the-pipeline)) and widening egress (`egress_policy`, always `approve`: a per-grant `when_tainted` for it waits for grants). `api` capabilities and granting sinks aren't built.
- **Ways back to clean:**
  - A fresh session starts untainted unless the wake that starts it carries taint, or it then reads tainted content.
  - **Quarantined reports:** a spawn spec can declare a `report_schema` of enums, numbers and ids. A child's final report that validates against it reaches the spawner untainted, even from a tainted child. This is the dual-LLM / map-reduce pattern from [Design Patterns for Securing LLM Agents](https://arxiv.org/abs/2506.08837) (2025-06), and how a captain stays clean while its workers read code.
- **Template defaults ("balanced", tuned from experience):** widening egress and granting sinks are `approve`. Brokered actions already scoped by their binding (e.g. `github.create_pr` to the binding's repos) are `allow`. Management grants stay off agents with hands.

**Brokered actions** run one pipeline in AgentDO (grant, cap, secret scan, sink gate, current external state, a natural idempotency key, journal): see [brokered](../capabilities/brokered/#the-pipeline).

- **Identity:** the runner knows which agent each MCP process belongs to and authenticates to the control plane with its host token. Stale agent epochs are rejected.
- **Never block on a human:** an approval answers `pending` at once, the turn ends, and the decision arrives as a later turn.
- **Inbound messages** are inbox posts: mid-turn they join the running turn, otherwise they queue a turn. One flagged `interrupt` interrupts the current turn (built for the operator's API only).

## The `nest` CLI inside sandboxes

Scripts and programs running in a sandbox can call `nest expose` and `nest hold` through the guest agent over vsock. What they send is **always tainted**. `NEST_AGENT_ID`, set on every hands exec, attributes a call. It isn't a secret, because identity inside a sandbox is attribution only. Everything else needs a brain. The CLI socket takes at most 256 connections ([admission](../../sandbox/guest-agent/#admission)).

`nest hold <duration>` asks to keep the sandbox awake (no pause or suspend) for a background build or a dev server. It's granted up to the sandbox's maximum hold (1 h by default) and prints the granted duration; a later call replaces the hold, and `nest hold 0` ends it ([idle rule](../../control-plane/durable-objects/sandbox/#activity-and-idle)). Nothing inside a sandbox can ask for it to be paused, suspended or shut down.

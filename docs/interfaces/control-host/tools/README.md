# Platform tools

> **Implemented contract.** For the designed catalog, see [agents/tools/](../../../agents/tools/) and [pending contract changes](../../README.md#pending-contract-changes).

**Canonical catalog:** [`protocol/schemas/control/platform-tools.json`](../../../../protocol/schemas/control/platform-tools.json), a list of `ToolDef{name, description, input_schema, requires_approval}`: each tool's arguments and the text the model sees are there, not restated here. The control plane's tool registry and nest-mcp's `tools/list` both come from this file. Every input schema is an object schema with `additionalProperties: false`. Hands tools (`Bash`, `Read`, …) belong to the [host ↔ guest](../../host-guest/) boundary, not this catalog.

- **What an agent gets** is its expanded spec's tools ([CatalogDO](../../../control-plane/durable-objects/catalog/)), plus `exit`, which every agent has and no spec gates.
- **`roles`:** `tools_list` still sends `roles: []` on each definition for one release, since runners of the previous release require the field; the catalog itself has none.
- **Naming:** Claude Code sees them as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

| Tool | Seed capability (templates) | Behaviour beyond the schema |
|---|---|---|
| `agent_spawn` | `spawning` (captain) | A child the caller owns, from a template its capabilities' `spawn` lists; overrides only narrow (`SpawnerOverrides`); `labels` go on the child and a sandbox made for it ([labels](../../../control-plane/api/clients/#labels)); `grants` each attenuate one the caller holds, `forbidden` otherwise ([transcript grants](../../../agents/tools/#built-transcript-grants-2026-11-06)); in an API client's subtree the child joins it, held to its grant. The result's JSON part: `{agent, template, sandbox?, ephemeral?}`. See [lifetimes](../../../agents/#lifetimes) |
| `agent_stop` | `spawning` (captain) | Ownership is transitive. On itself it is `exit`; `forbidden` for an agent the caller doesn't own, `unknown_agent` for an id naming nobody; an agent already ended answers ok, saying so |
| `exit` | every agent | Ends the caller once its turn is done |
| `fork_sandbox` | `sandboxes` (worker, captain) | `not_implemented` |
| `attach` | `management` (captain) | `not_implemented` |
| `read_transcript` | `transcripts` (worker, captain), or a `read_transcript` grant | Its own or an agent's it owns, transitively; any other only through a grant whose chain holds, within its limits (`forbidden` otherwise, and for an id naming no agent). `since_ms` keeps entries at or after a time. Read from R2, never wakes anything; another agent's taints the reader |
| `list` | any grant | The agents its grants cover, one grant per page (`next_cursor`), filtered by labels: `{agents: [{agent, labels, created_ms, ended_ms, actions}], next_cursor}`. Only `kind: agent` |
| `checkpoint` | `hands` (worker) | `not_implemented` |
| `expose_port` | `hands` (worker) | `share: true` is `forbidden` for agents: a public link bypasses Access, so only the operator mints one |
| `egress_policy` | `egress` (no seed template) | Widening is a sink: `pending` from a tainted session until approved; `revoke` is never gated |
| `brokered` | `brokered` (worker, captain) | The actions are the spec's `brokered` grants ([brokered](../../../agents/capabilities/brokered/)). `tools_list` also lists each granted action as its own tool (`github_comment`, `github_create_issue`, `github_create_pr`, `github_review_comment`, `http_request`), not in this file, with schemas from `control-plane/src/lib/brokered.ts` narrowed to the grants. `email.send` answers `not_implemented` |
| `approve`, `deny` | `management` (captain) | `not_implemented` |
| `memory_read`, `memory_write` | `memory` (captain) | `not_implemented` |
| `timer_set`, `timer_cancel`, `timer_list` | `timers` (no seed template) | A named timer fires as an inbox message, 10 s to 30 days ahead; setting a name again replaces its timer; at most 32 live per agent ([timers](../../../agents/capabilities/timers/)) |

The seed column is a new catalog's; an existing catalog's `worker` and `captain` get `spawning` only by the operator's edit ([CatalogDO](../../../control-plane/durable-objects/catalog/)). A stored capability or spec that names a tool the file doesn't have lists a tool its agent is never offered, and a call to it answers `unknown_tool`.

**Grants:**
- AgentDO lists the tools in the agent's expanded spec, plus those its unexpired grants offer (`read_transcript`, `list`), and checks every `tool_call` against that list again, then against the grant's chain.
- A spawning agent can only give the agents it spawns what it holds itself: its overrides only narrow the template, the template must be one its capabilities' `spawn` names, and each grant attenuates one it holds.
- `agent_spawn`, `agent_stop` and `exit` are refused from inside a sandbox (the guest `nest` CLI).
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → refuse arguments holding a stored secret's exact value → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

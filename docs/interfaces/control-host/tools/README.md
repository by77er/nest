# Platform tools

> **Implemented contract.** For the designed catalog, see [agents/tools/](../../../agents/tools/) and [pending contract changes](../../README.md#pending-contract-changes).

**Canonical catalog:** [`protocol/schemas/control/platform-tools.json`](../../../../protocol/schemas/control/platform-tools.json), a list of `ToolDef{name, description, input_schema, requires_approval}`: each tool's arguments and the text the model sees are there, not restated here. The control plane's tool registry and nest-mcp's `tools/list` both come from this file. Every input schema is an object schema with `additionalProperties: false`. Hands tools (`Bash`, `Read`, …) belong to the [host ↔ guest](../../host-guest/) boundary, not this catalog.

- **What an agent gets** is its expanded spec's tools ([CatalogDO](../../../control-plane/durable-objects/catalog/)), plus `exit`, which every agent has and no spec gates.
- **`roles`:** `tools_list` still sends `roles: []` on each definition for one release, since runners of the previous release require the field; the catalog itself has none.
- **Naming:** Claude Code sees them as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

| Tool | Seed capability (templates) | Behaviour beyond the schema |
|---|---|---|
| `agent_spawn` | `spawning` (captain) | A child the caller owns, from a template its capabilities' `spawn` lists; overrides only narrow (`SpawnerOverrides`); `labels` go on the child and a sandbox made for it ([labels](../../../control-plane/api/clients/#labels)); in an API client's subtree the child joins it, held to its grant. The result's JSON part: `{agent, template, sandbox?, ephemeral?}`. See [lifetimes](../../../agents/#lifetimes) |
| `agent_stop` | `spawning` (captain) | Ownership is transitive. On itself it is `exit`; `forbidden` for an agent the caller doesn't own, `unknown_agent` for an id naming nobody; an agent already ended answers ok, saying so |
| `exit` | every agent | Ends the caller once its turn is done |
| `fork_sandbox` | `sandboxes` (worker, captain) | `not_implemented` |
| `attach` | `management` (captain) | `not_implemented` |
| `read_transcript` | `transcripts` (worker, captain) | Its own or an agent's it owns, transitively (`forbidden` otherwise); read from R2, never wakes anything |
| `checkpoint` | `hands` (worker) | `not_implemented` |
| `expose_port` | `hands` (worker) | `share: true` is `forbidden` for agents: a public link bypasses Access, so only the operator mints one |
| `egress_policy` | `egress` (no seed template) | Widening is a sink: `pending` from a tainted session until approved; `revoke` is never gated |
| `brokered` | `brokered` (worker, captain) | The actions are the spec's `brokered` grants ([brokered](../../../agents/capabilities/brokered/)). `tools_list` also lists each granted action as its own tool (`github_comment`, `github_create_issue`, `github_create_pr`, `github_review_comment`, `http_request`), not in this file, with schemas from `control-plane/src/lib/brokered.ts` narrowed to the grants. `email.send` answers `not_implemented` |
| `approve`, `deny` | `management` (captain) | `not_implemented` |
| `memory_read`, `memory_write` | `memory` (captain) | `not_implemented` |

The seed column is a new catalog's; an existing catalog's `worker` and `captain` get `spawning` only by the operator's edit ([CatalogDO](../../../control-plane/durable-objects/catalog/)). A stored capability or spec that names a tool the file doesn't have lists a tool its agent is never offered, and a call to it answers `unknown_tool`.

**Grants:**
- AgentDO lists exactly the tools in the agent's expanded spec, and checks every `tool_call` against it again.
- A spawning agent can only give the agents it spawns what it holds itself. Grants aren't built: today its overrides can only narrow the template, and the template must be one its capabilities' `spawn` names.
- `agent_spawn`, `agent_stop` and `exit` are refused from inside a sandbox (the guest `nest` CLI).
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

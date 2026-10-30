# Platform tools

> **Implemented contract.** For the designed catalog, see [agents/tools/](../../../agents/tools/) and [pending contract changes](../../README.md#pending-contract-changes).

**Canonical catalog:** `protocol/schemas/control/platform-tools.json`, a list of `ToolDef{name, description, input_schema, requires_approval}`. Which tools an agent gets is its spec's ([CatalogDO](../../../control-plane/durable-objects/catalog/)); the column below is what the seed templates give. `tools_list` still carries `roles: []` on each definition for one release (runners of the previous release require the field). Every input schema is an object schema with `additionalProperties: false`. The **control plane's tool registry** and nest-mcp's `tools/list` both come from this file. Hands tools (`Bash`, `Read`, …) are defined by the [host ↔ guest](../../host-guest/) boundary and aren't part of it.

| Tool | Seed templates | Notes |
|---|---|---|
| `notify` | worker, captain | To `captain` (the owner, else the escalation channel's reader), `user` (Discord) or `agt_…`. Doesn't wait for a reply |
| `emit` | worker | Workstream event: `progress`, `blocked`, `pr_opened`, `completed`, `failed`. Decision events wake the workstream channel's subscriber |
| `ask` | worker, captain | To the escalation channel (`captain`, the default) or `user`. Synchronous up to about 2 min, then `pending`. The answer arrives as an `ask_answer` turn |
| `spawn_agent` | captain | New agent in a workstream, optionally bound or with a forked session; its overrides may only narrow (`SpawnerOverrides`, [CatalogDO](../../../control-plane/durable-objects/catalog/)) |
| `fork_sandbox` | worker, captain | `disk_only` (default) or `live`; `read_only` for inspection |
| `attach` | captain | Bind or unbind another agent's hands |
| `read_transcript` | worker, captain | Normalized transcript from R2; never wakes anything |
| `checkpoint` | worker | Commit the bound sandbox now |
| `expose_port` | worker | Preview URL, optionally with a share link |
| `brokered` | worker, captain | `{action, args}`, run outside the sandbox. The available actions depend on grants, and AgentDO's `tools_list` may also expose them as dedicated tools (e.g. `github_create_pr`) |
| `spawn_workstream`, `send`, `list_workstreams`, `get_status`, `wait_events` (≤120 s), `approve`, `deny`, `merge` (approval), `kill`, `delegate`, `memory_read`, `memory_write`, `notify_user` | captain | Return `not_implemented`; the design replaces them with capability tools ([pending contract changes](../../README.md#pending-contract-changes)) |
| `task_list {ledger?, status?, assignee? (me, agt_…, or null: unassigned), label?, text?, parent?, cursor?, limit? ≤200}`, `task_get {ledger?, task}`, `task_create {ledger?, title, description?, status? (backlog, todo), labels?, parent?}`, `task_update {ledger?, task, expected_version?, title?, description?, status?, labels?}`, `task_claim {ledger?, task, expected_version?}`, `task_comment {ledger?, task, body}` | worker, captain (`tasks`) | The [task ledger](../../../control-plane/durable-objects/tasks/) named by the agent's `ledger` param; `task` is `T-<n>` or `tsk_…`. Results carry a text line and the JSON |
| `task_assign {ledger?, task, assignee (agt_… or null), expected_version?}`, `task_update_any {ledger?, task, expected_version?, title?, description?, status?, priority?, labels?, parent? (or null)}`, `task_cancel {ledger?, task, reason?, expected_version?}`, `task_set_watcher {ledger?, watcher (agt_… or null)}` | captain (`tasks-admin`) | A stale `expected_version` is refused with `conflict`, a missing task with `not_found`. A nullable argument's schema type is `["string", "null"]` (AgentDO's argument check takes a type list) |

Only `notify`, `emit`, `ask`, `read_transcript`, `expose_port` and the `task_*` tools run; the rest return `not_implemented`. The seed column is a new catalog's: an existing catalog's `worker` and `captain` get the task capabilities by my edit ([CatalogDO](../../../control-plane/durable-objects/catalog/)).

**Grants:**
- AgentDO lists exactly the tools in the agent's expanded spec, and checks every `tool_call` against it again.
- A spawning agent can only give the agents it spawns what it holds itself (grants aren't built; today its overrides can only narrow the template).
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

**Naming:** MCP exposes these to Claude Code as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

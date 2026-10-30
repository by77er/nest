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
| `channel_create`, `post`, `read`, `subscribe`, `unsubscribe` | the `channels` capability (no seed template) | [Channels](../../../channels/): create a channel (owned), post (`kind`, `data`, `reply_to`, `key` with `if_seq` compare-and-set, `mentions`), read (`since`/`limit`, or the keyed view), subscribe (filter fields flattened: `kinds`, `from`, `keys`, `mentions_me`, `reply_to`; `delivery`, `batch_ms`, `once`). `from` and `taint` are never arguments |
| `message` | the `messaging-tree` capability (no seed template) | `post` to `<agent>/inbox`, within the agent's channel grants |
| `spawn_workstream`, `send`, `list_workstreams`, `get_status`, `wait_events` (≤120 s), `approve`, `deny`, `merge` (approval), `kill`, `delegate`, `memory_read`, `memory_write`, `notify_user` | captain | Return `not_implemented`; the design replaces them with capability tools ([pending contract changes](../../README.md#pending-contract-changes)) |

Only `notify`, `emit`, `ask`, `read_transcript`, `expose_port` and the channel tools run; the rest return `not_implemented`.

**Grants:**
- AgentDO lists exactly the tools in the agent's expanded spec, and checks every `tool_call` against it again.
- A spawning agent can only give the agents it spawns what it holds itself (grants aren't built; today its overrides can only narrow the template).
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

**Naming:** MCP exposes these to Claude Code as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

# Platform tools

> **Implemented contract.** For the designed catalog, see [agents/tools/](../../../agents/tools/) and [pending contract changes](../../README.md#pending-contract-changes).

**Canonical catalog:** `protocol/schemas/control/platform-tools.json`, a list of `ToolDef{name, description, input_schema, roles, requires_approval}`. Every input schema is an object schema with `additionalProperties: false`. The **control plane's tool registry** and nest-mcp's `tools/list` both come from this file. Hands tools (`Bash`, `Read`, …) are defined by the [host ↔ guest](../../host-guest/) boundary and aren't part of it.

| Tool | Roles | Notes |
|---|---|---|
| `notify` | worker, captain | To `captain`, `user` (Discord) or `agt_…`. Doesn't wait for a reply |
| `emit` | worker | Workstream event: `progress`, `blocked`, `pr_opened`, `completed`, `failed`. Decision events wake the captain |
| `ask` | worker, captain | Synchronous up to about 2 min, then `pending`. The answer arrives as an `ask_answer` turn |
| `spawn_agent` | captain | New worker in a workstream, optionally bound or with a forked session |
| `fork_sandbox` | worker, captain | `disk_only` (default) or `live`; `read_only` for inspection |
| `attach` | captain | Bind or unbind a **worker's** hands. Captains never get hands |
| `read_transcript` | worker, captain | Normalized transcript from R2; never wakes anything |
| `checkpoint` | worker | Commit the bound sandbox now |
| `expose_port` | worker | Preview URL, optionally with a share link |
| `brokered` | worker, captain | `{action, args}`, run outside the sandbox. The available actions depend on grants, and AgentDO's `tools_list` may also expose them as dedicated tools (e.g. `github_create_pr`) |
| `spawn_workstream`, `send`, `list_workstreams`, `get_status`, `wait_events` (≤120 s), `approve`, `deny`, `merge` (approval), `kill`, `delegate`, `memory_read`, `memory_write`, `notify_user` | captain | Return `not_implemented`; the design replaces them with capability tools ([pending contract changes](../../README.md#pending-contract-changes)) |

Only `notify`, `emit`, `ask`, `read_transcript` and `expose_port` run; the rest return `not_implemented`.

**Grants:**
- AgentDO filters `tools_list` by role and grants, and checks every `tool_call` again.
- A captain can only give its workers grants it holds itself.
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

**Naming:** MCP exposes these to Claude Code as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

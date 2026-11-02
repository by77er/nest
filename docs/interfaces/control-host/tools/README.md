# Platform tools

> **Implemented contract.** For the designed catalog, see [agents/tools/](../../../agents/tools/) and [pending contract changes](../../README.md#pending-contract-changes).

**Canonical catalog:** `protocol/schemas/control/platform-tools.json`, a list of `ToolDef{name, description, input_schema, requires_approval}`. Which tools an agent gets is its spec's ([CatalogDO](../../../control-plane/durable-objects/catalog/)); the column below is what the seed templates give. `tools_list` still carries `roles: []` on each definition for one release (runners of the previous release require the field). Every input schema is an object schema with `additionalProperties: false`. The **control plane's tool registry** and nest-mcp's `tools/list` both come from this file. Hands tools (`Bash`, `Read`, …) are defined by the [host ↔ guest](../../host-guest/) boundary and aren't part of it.

| Tool | Seed templates | Notes |
|---|---|---|
| `agent_spawn {template, task, sandbox? (new, share), ephemeral?, sandbox_idle_ttl_s?, tools?, repos?}` | captain (`spawning`) | A child the caller owns, from a template its capabilities' `spawn` lists; `task` is its first input; `new` makes a sandbox it owns, `share` attaches the caller's own (the template must allow it); overrides only narrow (`SpawnerOverrides`, [CatalogDO](../../../control-plane/durable-objects/catalog/)). The result's JSON part: `{agent, template, sandbox?, ephemeral?}`. See [lifetimes](../../../agents/#lifetimes) |
| `agent_stop {agent, destroy_sandbox?, reason?}` | captain (`spawning`) | Ends an agent the caller owns (or one they own, and so on) for good; on itself it is `exit`. `forbidden` for anyone else's, `unknown_agent` for an id naming nobody; an agent already ended answers ok, saying so |
| `exit {destroy_sandbox?, reason?}` | every agent (not in its spec: never gated) | Ends the caller once its turn is done |
| `fork_sandbox` | worker, captain | `disk_only` (default) or `live`; `read_only` for inspection |
| `attach` | captain | Bind or unbind another agent's hands |
| `read_transcript` | worker, captain | Normalized transcript from R2, its own or an agent's it owns (transitively; `forbidden` otherwise); never wakes anything |
| `checkpoint` | worker | Commit the bound sandbox now |
| `expose_port` | worker | Preview URL, optionally with a share link |
| `egress_policy` | the `egress` capability (no seed template) | `{}` the effective policy; `{allow: [{host, ports?}], ttl_s?}` widens the bound sandbox's egress (a sink: `pending` from a tainted session until approved); `{revoke: [host]}` narrows, never gated |
| `brokered` | worker, captain | `{action, args}`, run outside the sandbox. The actions are the spec's `brokered` grants ([brokered](../../../agents/capabilities/brokered/)); `tools_list` also lists each granted action as its own tool, not in this file: `github_comment`, `github_create_issue`, `github_create_pr`, `github_review_comment`, `http_request`, with schemas from `control-plane/src/lib/brokered.ts` narrowed to the grants. `email.send` answers `not_implemented` |
| `approve`, `deny`, `memory_read`, `memory_write` | captain | Return `not_implemented`; the design replaces them with capability tools ([pending contract changes](../../README.md#pending-contract-changes)) |

Only `agent_spawn`, `agent_stop`, `exit`, `read_transcript`, `expose_port`, `egress_policy`, `brokered` (and its per-action tools) run; the rest return `not_implemented`. The seed column is a new catalog's: an existing catalog's `worker` and `captain` get the spawning capability by my edit ([CatalogDO](../../../control-plane/durable-objects/catalog/)). Retired, gone from the file: `delegate` (inspecting without hands is a [pattern](../../../orchestration/captains/)), the stubs `spawn_agent` and `kill` (replaced by `agent_spawn` and `agent_stop`), the task ledger's `task_*` tools, the channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`, `message`), and `notify`, `ask`, `emit` and the workstream tools (`spawn_workstream`, `send`, `list_workstreams`, `get_status`, `wait_events`, `merge`, `notify_user`), which left the platform ([principle 9](../../../README.md#principles)); a stored capability or spec that still names one lists a tool its agent is never offered, and a call to it answers `unknown_tool`. `tools_list` adds `exit` to every agent's own tools.

**Grants:**
- AgentDO lists exactly the tools in the agent's expanded spec, and checks every `tool_call` against it again.
- A spawning agent can only give the agents it spawns what it holds itself (grants aren't built; today its overrides can only narrow the template, and the template must be one its capabilities' `spawn` names).
- `agent_spawn`, `agent_stop` and `exit` are refused from inside a sandbox (the guest `nest` CLI).
- `requires_approval` tools always go through the approval gate.

**Brokered action pipeline:** check the grant → rate limit → scan arguments for secrets → approval gate → run with idempotency key `(agent, epoch, call)` → write to the journal.

**Naming:** MCP exposes these to Claude Code as `mcp__nest__<name>`. Names use `[a-z_]` only (`memory_read`, not `memory.read`).

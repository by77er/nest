# Interfaces

Boundary contracts between components. Each boundary has a spec here and Rust types in `crates/nest-protocol`. **JSON fixtures in `protocol/fixtures/` are the cross-language source of truth:** the Rust tests and the control plane's TypeScript tests both round-trip them.

| Boundary | Spec | Rust module |
|---|---|---|
| Control plane ↔ host (WebSocket), shared models, platform tools | [control-host/](control-host/) | `control`, `model` |
| Host ↔ guest agent (vsock), hands tools | [host-guest/](host-guest/) | `guest` |
| Host-internal: nestd ↔ nest-proxy (fd passing), nestd ↔ runner, runner ↔ `nest hook` / Claude Code | [host-internal/](host-internal/) | `host` |

## Conventions

- **JSON, snake_case fields.** Message enums are internally tagged: `{"type": "snake_case_name", ...}`.
- **IDs** are prefixed strings: `hst_`, `sbx_`, `agt_`, `ws_`, `gen_`, `ses_`.
- **Epoch** and **Seq** are u64. Timestamps are `*_ms` (Unix milliseconds).
- **Binary data in JSON** is base64 (standard alphabet). Bulk byte streams use raw framed channels, never JSON.
- **Errors:** `{code, message, retryable}`.
- **Versioning:** every connection starts with a hello that carries `protocol_version`. Unknown fields are ignored and unknown message types are rejected with an error.
- **Anything from a host or guest** that changes state carries `(sandbox, epoch)` and is rejected when the epoch is stale.

## Planned: role-free model

The design moved to role-free agents, grants and channels ([agents/](../agents/), [channels/](../channels/)). The contract below still has the implemented shapes; these change with the code:
- **`AgentRole`** and `AgentStart.role` go. The launch config already carries what the role implied (prompt mode, built-in tools); placement follows `hands`.
- **Workstream fields** (`sandbox_create.workstream`, `sandbox_fork.child_workstream`, `agent_start.workstream`) are replaced by `owner` and `labels`.
- **`WorkstreamEvent`** and the fleet `workstream` host event become platform posts to `<sbx>/events` and `<agt>/events`: `ChannelMessage{seq, ts_ms, from, kind?, text, data?, reply_to?, key?, mentions?}`. The kinds keep their names.
- **`EgressPolicy` layers** `base`/`workstream`/`sandbox` become `base`/`sandbox`/`grant`.
- **The platform tool catalog** is role-filtered today. It becomes grant-filtered, and channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`) plus `grant`/`revoke` replace `notify`, `emit`, `ask` and the captain-only tools.
- **Guest CLI:** `nest notify --to captain` becomes `nest post <channel>`.
- **IDs:** `ws_` goes; `chn_` (channel) and `tpl_` (template) arrive.

## Contract changelog

**2026-10-12** (from the implementation change requests):
- **control-host:**
  - `not_implemented` error code
  - the AWS proof is the `rsa2048` signature form
  - session resume uses Worker-signed URLs; stale-epoch session connections are specified
  - `HostHello.instance_id` (a new nestd process resets both seq lineages and fails unacked commands); `HostToFleet::Hello` is boxed
  - fleet `guest_cli` event + `guest_cli_result` command (guest `nest` CLI relay), `task_exited` event
  - `CommitReason::Archive`
  - `HandsBinding.cwd`
  - `EgressAuditRecord.via`
  - `AgentEvent` gains `escalation`, `capabilities` and `task_exited`
  - `InjectionSecret`'s `Debug` redacts the value
- **host-guest:**
  - guest `hello.instance_id` (restore vs agent restart)
  - documented: the time limit for commands moved to the background, `unknown_task` as an error frame, Grep searches hidden files, lower-epoch `configure` is rejected, `whoami` after a fork, `(no output)`
- **host-internal:**
  - MCP bridge `tools_call.tool_use_id`
  - `RunnerEvent::AgentCapabilities`
  - `RunnerSockets` / cwd parameters on the `claude` builders
  - nest-proxy audit `reason` list, `domain_fronting` scope, resync-count contract

**After the first review pass:**
- `RunnerHello.instance_id` (random per brain process). AgentDO resets the session channel's lineage and event dedup when it changes.
- `ProxyEvent::Alert.binding` (optional). `WorkstreamEventKind::EgressAlert.binding` is now optional; prose stays in `detail`.
- `AgentStart.oauth_token` is a `model::Secret` (redacted `Debug`; the wire format is unchanged). `Secret` moved from `host` to `model`.
- Resume URLs in fixtures are Worker-signed `/v1/blobs/…?exp&sig`.
- Removed the unused `paths::WORKER_PROMPT` / `CAPTAIN_PROMPT` constants: prompts come from the control plane.

**Final integration round:**
- `model::error_codes::OUTCOME_UNKNOWN`.
- Session channel `cancel_call{seq, call, reason}` (runner → AgentDO): an abandoned platform call never runs late. An unacked `tool_call` is replaced in place (same seq), and a fresh cancel follows.
- `AgentEventBody::InboxDelivered{message}`: AgentDO prunes the inbox mirror.
- `EgressAuditRecord.count` (optional): aggregated suppression summaries.
- `Elicitation` is wired as an async tracking hook in `protocol/claude-code/managed-settings.json`.
- Runner error codes are documented in [host-internal/nestd-runner/](host-internal/nestd-runner/).

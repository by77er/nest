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

## Pending contract changes

The design in [agents/](../agents/) and [channels/](../channels/) needs these contract changes; the specs below and the fixtures describe what's implemented until they land:
- **Agents** carry `owner`, `labels` and a spawn spec (with `capabilities`) instead of a role. Placement follows `hands`. Capability definitions are control-plane data, not contract.
- **Sandboxes** carry `owner` and `labels`; sandbox commands carry no grouping field.
- **Platform events** are posts to `<sbx>/events` and `<agt>/events`: `ChannelMessage{seq, ts_ms, from, kind?, text, data?, reply_to?, key?, mentions?}`, with kinds such as `port_opened`, `egress_denied`, `egress_alert` and `orphaned_work`.
- **`EgressPolicy` layers** are `base`, `sandbox` and `grant`.
- **The platform tool catalog** is filtered by grants and has the channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`), `message`, `agent_spawn`, `adopt`, `list`, and `grant`/`revoke`. See [agents/tools/](../agents/tools/).
- **Guest CLI:** `nest post`, `nest read`, `nest expose`.
- **IDs:** `chn_` (channel) and `tpl_` (template).
- **Channel messages** carry `taint`, set by the platform.
- **Session channel:** one stream per file of the session directory, keyed by relative path; `segment_ack` follows the SQLite commit.
- **Hands journal:** guest → nestd → AgentDO intent and outcome events keyed by `(agent, epoch, tool_use_id)`.
- **`GenerationRecord`** gains `restore_abi` and `session{offset, last_tool_use}`.
- **Claude Code invocation** (`runner-claude`): `--system-prompt-snapshot off`, `--max-turns` and `--max-budget-usd` from the budget, no `TodoWrite` or `Agent` in `--tools`, `DISABLE_UPDATES=1`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` (after verification), auto memory off, and `PreToolUse` answering `defer` for approvals.

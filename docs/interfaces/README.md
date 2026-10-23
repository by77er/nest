# Interfaces

Boundary contracts between components. Each boundary has a spec here and Rust types in `crates/nest-protocol`. **JSON fixtures in `protocol/fixtures/` are the cross-language source of truth:** the Rust tests and the control plane's TypeScript tests both round-trip them.

| Boundary | Spec | Rust module |
|---|---|---|
| Control plane ↔ host (WebSocket), shared models, platform tools | [control-host/](control-host/) | `control`, `model` |
| Brain ↔ sandbox gateway (WebSocket through the host's tunnel): bindings, `resolve`, hands, PTY, ingress (designed) | [gateway/](gateway/) | `gateway` (planned) |
| Host ↔ guest agent (vsock), hands tools; nestd and the gateway are the host side | [host-guest/](host-guest/) | `guest` |
| Host-internal: nestd ↔ nest-proxy (fd passing), nestd ↔ runner, nestd ↔ gateway, runner ↔ `nest hook` / Claude Code | [host-internal/](host-internal/) | `host` |

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
- **Agents** carry `owner`, `labels` and a spawn spec (with `capabilities`) instead of a role. A brain is placed on a brain host by backend and capacity, and its hands are a binding to a sandbox anywhere ([gateway](gateway/)). Capability definitions are control-plane data, not contract.
- **Sandboxes** carry `owner`, `labels` and the channels their programs may post to; sandbox commands carry no grouping field. Every `workstream` field goes; grouping is labels.
- **Platform events** are posts to `<sbx>/events` and `<agt>/events`: `ChannelMessage{seq, ts_ms, from, taint, kind?, text, data?, reply_to?, key?, mentions?}`, with kinds such as `port_opened`, `egress_denied`, `egress_alert` and `orphaned_work`.
- **`EgressPolicy` layers** are `base`, `sandbox` and `grant`.
- **The platform tool catalog** is filtered by grants. It has the channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`, `message`), the agent tools (`agent_spawn`, `agent_stop`, `attach`, `adopt`, `list`, `read_transcript`, `wake_at`/`wake_cancel`), the sandbox tools (`sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy`), `hook_create`/`hook_delete`, `grant`/`revoke`, brokered actions, and each `mcp` or `api` capability's tools (`<capability>_<tool>`, `<capability>_request`). `notify`, `emit`, `ask`, `spawn_agent`, `fork_sandbox` and the captain-only tools go. `ToolDef` drops `roles` and `requires_approval`; sinks and `when_tainted` come from grants. See [agents/tools/](../agents/tools/).
- **Guest CLI:** `nest post`, `nest read`, `nest expose`.
- **IDs:** `chn_` (channel), `tpl_` (template) and `hk_` (hook) are added; `ws_` goes.
- **Webhook route:** `POST /v1/hooks/<hk_…>` on the Worker (see [sources](../channels/sources/)). Hook maps produce keys, and subscription filters take `keys` prefixes.
- **Metrics:** hosts send a `metrics` frame on the fleet channel every 60 s; `GET /v1/health` makes one round trip to each DO class (see [metrics](../control-plane/metrics/) and [upgrades](../control-plane/#upgrades)).
- **Session channel:** one stream per file of the session directory, keyed by relative path; `segment_ack` follows the SQLite commit; a `hands_resolve` request (runner → AgentDO → SandboxDO) and its `hands_resolved` reply; the runner's hello carries the agent epoch AgentDO issues per brain start.
- **Hands journal:** records stay in the guest, keyed by `(agent, epoch, tool_use_id)`; the runner's `call_status` lookups go through the gateway, and outcomes reach AgentDO as the runner's canonical events. nestd relays none of it.
- **Gateway** ([gateway/](gateway/)): the binding token, the `bind`/`bound` handshake, `resolve{hostname, epoch, binding, guest}`, and the error codes `unauthorized` and `moved`.
- **`GenerationRecord`** gains `restore_abi` (a `sha256:` reference), `reason`, `state` and `session{offset, last_tool_use}`.
- **Guest protocol version 2** ([host-guest](host-guest/)):
  - the version range and capabilities;
  - `flush`, with the error `sync_failed`;
  - hands `error{call_id?, executed, retry_after_ms}`, with the codes `unsupported`, `duplicate_call` and `unknown_terminal`;
  - `call_status`, the `heartbeat` frame, `detail.exit` and `calls/<id>.json`;
  - `pty_attach`, and `terminal_id` and `attach_token` on `accepted`;
  - `health{drain_log_sites}` and the ready report;
  - the CLI's `hold{duration_s}` → `{granted_s}`.
- **nestd ↔ runner:** `agent_start` loses its `hands` field and `agent_bind` goes (the hands setup arrives from AgentDO inside `agent_start`), `hello_ack` carries `host_kind: brain`, and the `claude_version` error. **nestd ↔ gateway:** the binding verification key, revocations and the VMs' vsock socket paths. **runner ↔ Claude Code:** the version and SHA-256 check.
- **nestd ↔ proxy:** `sandbox_upsert{policy, sha256, secrets}`, `secrets_set{version, sha256, secrets}` and a `policy_ack{sandbox, epoch, version, sha256, outcome}` event. New reasons: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope` and `injection_upgrade`.
- **`InjectionBinding`** gains `methods?`, `path_prefix?` and `wildcard?`; header names are checked against the reserved names.
- **Fleet:**
  - **Policy:** `policy_update` carries the policy's sha256 and its secrets, and `secrets_update` names the policy version and sha256.
  - **Host kinds:** `hello` carries `kind: brain | sandbox`; a brain host reports brain capacity and receives only agent commands; FleetDO holds three desired versions per cell (brain host, sandbox host, guest image). Sandbox hosts receive the binding verification key and revocations the way they receive policy secrets.
  - **Placement:** `hello` and `capacity` carry `restore_abis{create, load}`; `sandbox_create` carries the claim's `attempt`; `sandbox_state` reports the guest's hello and ready as evidence.
  - **Pause and suspend:** a `sandbox_pause` command. Pause and suspend carry `wake_seq` and add the outcomes `superseded` and `busy`; a commit can fail with `guest_flush_failed`.
  - **Drain:** `drain{mode: gentle|forced}`, and an all-or-nothing `pending_uploads` report with each sandbox's last committed generation.
  - **Sandboxes:** ingress-guard `activity` events; `base_prepare` and `from: base`; drive rate limits in `resources`.
  - **CLI and metrics:** `guest_cli` carries `hold`; the metrics frame carries guest log-site counts.
  - **Agents:** `agent_start` goes to a brain host and carries `{hostname, binding, guest{protocol_version, capabilities}}` for an agent with hands; platform tool calls and brokered actions carry the agent epoch.
- **Enrollment:** a fixed-shape CSR, and `proxy_ca` is pathLen 0. A sandbox host's response carries its `tunnel_token`; a brain host's carries none.
- **Operator API:** scoped tokens, never accepted in URLs; the revocation counter goes into share links, terminal sessions and host tokens.
- **Channels:** a loss-record kind on `<sbx>/events`. **Tool schema:** a per-tool list of rejected fields in `hands-tools.json`.
- **Claude Code invocation** (`runner-claude`): `--system-prompt-snapshot off`, `--max-turns` and `--max-budget-usd` from the budget, no `TodoWrite` or `Agent` in `--tools`, `DISABLE_UPDATES=1`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, auto memory off, and `PreToolUse` answering `defer` for approvals. `SessionStart` also returns the memory key index and the recovery context, from the AgentCache.

# Interfaces

Boundary contracts between components. Each boundary has a spec here and Rust types in `crates/nest-protocol`. **JSON fixtures in `protocol/fixtures/` are the cross-language source of truth:** the Rust tests and the control plane's TypeScript tests both round-trip them. Two shared lists sit beside them, asserted equal on both sides: `codes.json` (error codes) and `enums.json` (the members of every string enum both sides define). The admin API's read views (control plane to dashboard) are TypeScript types in `protocol/admin/view.ts`, imported by both.

| Boundary | Spec | Rust module |
|---|---|---|
| Control plane ↔ host (WebSocket), shared models, platform tools | [control-host/](control-host/) | `control`, `model` |
| Brain ↔ sandbox gateway (WebSocket; through the host's tunnel on a real host): bindings, `resolve`, hands (PTY and ingress designed) | [gateway/](gateway/) | `gateway` |
| Host ↔ guest agent (vsock), hands tools; nestd and the gateway are the host side | [host-guest/](host-guest/) | `guest` |
| Host-internal: nestd ↔ nest-proxy (fd passing), nestd ↔ runner, nestd ↔ gateway, runner ↔ `nest hook` / Claude Code | [host-internal/](host-internal/) | `host` |
| Control plane → a remote MCP server (an mcp capability's): transport and the `_meta` keys nest sends | [remote-mcp/](remote-mcp/) | none (control plane only) |

## Conventions

- **JSON, snake_case fields.** Message enums are internally tagged: `{"type": "snake_case_name", ...}`.
- **IDs** are prefixed strings: `hst_`, `sbx_`, `agt_`, `ws_`, `gen_`, `ses_`. Parsing checks the prefix on both sides.
- **Absent, never null.** An unset optional field is left out; neither side sends `null` for it (Rust skips `None`, a test checks every field; TypeScript drops `undefined`). zod rejects `null` there; serde tolerates it.
- **Open enums** for reasons that grow: `agent_exited.reason` and `egress_alert.reason` parse a member they don't know as `unknown`, so a new reason never rejects a message.
- **Epoch** and **Seq** are u64. Timestamps are `*_ms` (Unix milliseconds).
- **Binary data in JSON** is base64 (standard alphabet). Bulk byte streams use raw framed channels, never JSON.
- **Errors:** `{code, message, retryable}`.
- **Versioning:** every connection starts with a hello that carries `protocol_version`. Unknown fields are ignored and unknown message types are rejected with an error.
- **Anything from a host or guest** that changes state carries `(sandbox, epoch)` and is rejected when the epoch is stale.

## Pending contract changes

The design in [agents/](../agents/) and [channels/](../channels/) needs these contract changes; the specs below and the fixtures describe what's implemented until they land:
- **Agents** carry `labels` (pending), and `owner` and a spawn spec (with `capabilities`) instead of a role (built in the control plane: AgentDO stores the expanded spec and `owner`). `agent_start.role` is no longer sent (optional on the wire); `ToolDef.roles` is deprecated, still sent for one release for runners that require it, and goes in the next. Capability definitions are control-plane data, not contract.
- **Sandboxes** carry `owner`, `labels` and the channels their programs may post to; sandbox commands carry no grouping field. Every `workstream` field goes; grouping is labels.
- **Platform events** are posts to `<sbx>/events` and `<agt>/events`: `ChannelMessage{seq, ts_ms, from, taint, kind?, text, data?, reply_to?, key?, mentions?}`, with kinds such as `port_opened`, `egress_denied`, `egress_alert` and `orphaned_work`.
- **`EgressPolicy` layers** are `base`, `sandbox` and `grant`.
- **The platform tool catalog** is filtered by grants. It has the channel tools (`channel_create`, `post`, `read`, `subscribe`, `unsubscribe`, `message`), the agent tools (`agent_spawn`, `agent_stop`, `attach`, `adopt`, `list`, `read_transcript`, `wake_at`/`wake_cancel`), the sandbox tools (`sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy`), `hook_create`/`hook_delete`, `grant`/`revoke`, brokered actions, and each `mcp` or `api` capability's tools (`<capability>_<tool>`, `<capability>_request`). `notify`, `emit`, `ask`, `spawn_agent`, `fork_sandbox` and the captain-only tools go. `ToolDef` drops `roles` and `requires_approval`; sinks and `when_tainted` come from grants. See [agents/tools/](../agents/tools/).
- **Guest CLI:** `nest post`, `nest read`, `nest expose`.
- **IDs:** `chn_` (channel), `tpl_` (template) and `hk_` (hook) are added; `ws_` goes.
- **Webhook route:** `POST /v1/hooks/<hk_…>` on the Worker (see [sources](../channels/sources/)). Hook maps produce keys, and subscription filters take `keys` prefixes.
- **Metrics:** hosts send a `metrics` frame on the fleet channel every 60 s (see [metrics](../control-plane/metrics/)). (`GET /v1/health`'s round trip to each DO class is built: [upgrades](../control-plane/#upgrades).)
- **Session channel:** one stream per file of the session directory, keyed by relative path; `segment_ack` follows the SQLite commit. (`hands_resolve` / `hands_resolved` with a tagged `outcome`, and the agent epoch in the hello, are built.) The next release drops the previous release's shapes kept for one release: `hands_resolved`'s `hands` / `error` / `retry_after_ms`, and `HandsTarget.sandbox` / `.epoch`. (`agent_start.hands.epoch` is no longer sent, and a hello with epoch `0` is stale.)
- **Hands journal:** records stay in the guest, keyed by `(agent, epoch, tool_use_id)`; the runner's `call_status` lookups go through the gateway, and outcomes reach AgentDO as the runner's canonical events. nestd relays none of it.
- **Gateway** ([gateway/](gateway/)): the `/hands` route, bindings, `resolve` and the `edge` credential are built; the `/pty` and `/ingress/<port>` routes are pending.
- **`GenerationRecord`** gains `restore_abi` (a `sha256:` reference), `reason`, `state` and `session{offset, last_tool_use}`.
- **Guest protocol version 2** ([host-guest](host-guest/)):
  - the version range and capabilities;
  - `flush`, with the error `sync_failed`;
  - hands `error{call_id?, executed, retry_after_ms}`, with the codes `unsupported`, `duplicate_call` and `unknown_terminal`;
  - `call_status`, the `heartbeat` frame, `detail.exit` and `calls/<id>.json`;
  - `pty_attach`, and `terminal_id` and `attach_token` on `accepted`;
  - `health{drain_log_sites}` and the ready report;
  - the CLI's `hold{duration_s}` → `{granted_s}`.
- **Mixed-version window (one release):** the fleet hello's `brain_epochs` (built) tells FleetDO a host's nestd keys brains by agent epoch. The window is closed structurally rather than by reasoning about the previous nestd: a host without it never receives a brain (FleetDO refuses the start too), is drained of brains on sight, and a brain still on it is released only by its confirmed death or lease expiry (never by its exits or an unindexed kill), its host wedged at the 15-minute cap like any other, so the window ends with the last such host's loss. The next release drops the field's absence.
- **nestd ↔ runner:** the `claude_version` error. (`agent_start` carries no local hands field and `agent_bind` is gone; `agent_stop{kill}` carries its agent epoch and `agent_started` the start's: built.) **runner ↔ Claude Code:** the version and SHA-256 check.
- **nestd ↔ proxy:** `sandbox_upsert{policy, sha256, secrets}`, `secrets_set{version, sha256, secrets}` and a `policy_ack{sandbox, epoch, version, sha256, outcome}` event. New reasons: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope` and `injection_upgrade`.
- **`InjectionBinding`** gains `methods?`, `path_prefix?` and `wildcard?`; header names are checked against the reserved names.
- **Fleet:**
  - **Policy:** `policy_update` carries the policy's sha256 and its secrets, and `secrets_update` names the policy version and sha256.
  - **Host kinds:** the next release writes `sandbox | brain` everywhere, and a sandbox host refuses `agent_start` ([deploy](../../dev/deploy.md#host-role-names-expandcontract)); FleetDO holds three desired versions per cell (brain host, sandbox host, guest image). (Reading `sandbox | brain` as well as `burst | controller` in `hello`, enrollment and host tokens, a brain host enrolling without a proxy CSR, its refusal of sandbox commands, and FleetDO counting its capacity in brains, are built; this release still writes `burst | controller`. `binding_key{keys}` after `hello_ack`, `gateway_url` in `hello`, `guest` in `SandboxReport` and `sandbox_state`, and `agent_attach`/`agent_detach` are built.)
  - **Placement:** `hello` and `capacity` carry `restore_abis{create, load}`; `sandbox_create` carries the claim's `attempt`; `sandbox_state` reports the guest's hello and ready as evidence.
  - **Pause and suspend:** a `sandbox_pause` command. Pause and suspend carry `wake_seq` and add the outcomes `superseded` and `busy`; a commit can fail with `guest_flush_failed`.
  - **Drain:** `drain{mode: gentle|forced}`, and an all-or-nothing `pending_uploads` report with each sandbox's last committed generation.
  - **Sandboxes:** ingress-guard `activity` events; `base_prepare` and `from: base`; drive rate limits in `resources`.
  - **CLI and metrics:** `guest_cli` carries `hold`; the metrics frame carries guest log-site counts.
  - **Agents:** brokered actions carry the agent epoch. (`agent_start` sent to a brain host chosen by capacity, `agent_start.epoch`, the agent epoch AgentDO issues per start, and a `hands` field naming the sandbox's id only: built.)
- **Enrollment:** a fixed-shape CSR, and `proxy_ca` is pathLen 0. (A sandbox host's response carrying `tunnel_token` and `gateway_url`, a brain host's neither: built.)
- **Operator API:** scoped tokens, never accepted in URLs; the revocation counter goes into share links, terminal sessions and host tokens.
- **Channels:** a loss-record kind on `<sbx>/events`. **Tool schema:** a per-tool list of rejected fields in `hands-tools.json`.
- **Claude Code invocation** (`runner-claude`): `--system-prompt-snapshot off`, `--max-turns` and `--max-budget-usd` from the budget, `DISABLE_UPDATES=1`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1`, auto memory off, and `PreToolUse` answering `defer` for approvals. `SessionStart` also returns the memory key index and the recovery context, from the AgentCache. (No `TodoWrite` or `Agent` in the seeded worker's `--tools`: built, as template data.)

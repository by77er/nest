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
- **IDs** are prefixed strings (`hst_`, `sbx_`, `agt_`, `gen_`, `ses_`, …: [models](control-host/models/)). Parsing checks the prefix on both sides.
- **Absent, never null.** An unset optional field is left out; neither side sends `null` for it (Rust skips `None`, a test checks every field; TypeScript drops `undefined`). zod rejects `null` there; serde tolerates it.
- **Open enums** for reasons that grow: `agent_exited.reason`, `egress_alert.reason` and the gateway `error` frame's `reason` parse a member they don't know as `unknown`, so a new reason never rejects a message.
- **Epoch** and **Seq** are u64. Timestamps are `*_ms` (Unix milliseconds).
- **Binary data in JSON** is base64 (standard alphabet). Bulk byte streams use raw framed channels, never JSON.
- **Errors:** `{code, message, retryable}`.
- **Versioning:** every connection starts with a hello that carries `protocol_version`. Unknown fields are ignored and unknown message types are rejected with an error.
- **Anything from a host or guest** that changes state carries `(sandbox, epoch)` and is rejected when the epoch is stale.

## Pending contract changes

The specs below and the fixtures describe what's implemented. This section lists what the implemented contract still carries for one release, and the changes the design needs.

### Compat windows (built)

Each is dropped once every host and runner runs the release that made it optional ([dev/deploy](../../dev/deploy.md)).

- **`segment.total_bytes`** (2026-11-09): optional on both sides. A runner of the previous release sends none, and AgentDO then commits a rewrite at its first durable segment, as before (the window in which a brain death mid-rewrite can truncate the resumable session). An AgentDO of the previous release ignores the field. Required of runners once every brain host runs this release.
- **Workstream fields:** they stay only so the previous release's hosts, runners and control plane parse what this one sends; nothing reads them, and once they go, sandbox and agent commands carry no grouping field.
  - `sandbox_create.workstream`, `sandbox_fork.child_workstream` and `agent_start.workstream` are optional on both sides; the control plane still sends a `ws_` value (a sandbox's stored one, else `ws_<id suffix>` of the sandbox or agent), since previous hosts and runners require it. nestd passes it on in the proxy's `sandbox_upsert.workstream`.
  - The `host_event` tag `workstream` carries a `SandboxEvent` (`egress_denied`, `egress_alert`, `port_opened`) whose `workstream` is optional and echoes that value. A rename of the tag is two releases of expand/contract.
  - `PolicyLayer`'s wire value `workstream` names the sandbox's operator layer; hosts parse a closed enum, so it keeps the name until the layers change (below).
  - `CliCommand` `notify`, `emit` and `ask` still parse (a previous release's guest sends them); the control plane answers each `unknown_tool` ([CLI relay](host-guest/#cli-relay)).
  - `TurnInputKind` `event_batch` isn't sent; it stays so a turn the previous release queued parses.
- **Roles:** `agent_start.role` is optional and not sent; `ToolDef.roles` is sent as `[]` for runners that require it ([tools](control-host/tools/)).
- **Session channel:** `hands_resolved` also carries the previous shape (`hands` / `error` / `retry_after_ms`), and `HandsTarget` unsigned `sandbox` / `epoch` copies; `HandsBinding.epoch` parses but isn't sent ([session](control-host/session/), [gateway](gateway/#resolve)). The runner's `tools_changed` hello flag is a capability, kept until every runner sends it. `hello_ack.rule_approvals` (2026-11-11) is AgentDO's capability: the runner sends `approval_check` only behind it, and the `escalation` event and AgentDO's plain-question handling of it stay for runners of the previous release and for a runner whose AgentDO was rolled back; both go once every runner checks approvals and no rollback reaches an AgentDO without the flag.
- **Host kinds:** this release reads `sandbox | brain` as well as `burst | controller` in `hello`, enrollment and host tokens, and still writes `burst | controller`; the next writes `sandbox | brain` everywhere, and a sandbox host refuses `agent_start` ([deploy](../../dev/deploy.md#host-role-names-expandcontract)).
- **Fleet hello `brain_epochs`:** a host without it never receives a brain ([fleet](control-host/fleet/#messages)).
- **Fleet hello `guard_bounds`** (2026-11-12): a cell with a sandbox host without it refuses API clients' request guards ([request guards](../control-plane/api/clients/#request-guards)). The window ends when the last such host is replaced; the release after drops the gate.
- **Fleet hello `guard_injected_any`** (2026-11-12; it also covers `RequestMatch.at`): a cell with a sandbox host without it refuses request guards newly using `injected: "*"` or `at`, and such a host gets no sandbox whose guards hold a position where it fails open ([any injected credential](../sandbox/networking/egress/policy/#any-injected-credential)). The window ends when the last such host is replaced; the release after drops the gate. A client's `*` stays refused in a scope until the previous control-plane release reads `*` (the release after this one), since that release sends it as `client:*`.
- **Fleet hello `guard_basic_user`** (2026-11-13; with `InjectionLocation` `authorization_basic_password.username`): a cell with a sandbox host without it refuses a guard newly using `at`, and a Basic password binding added beside one on a live sandbox, and such a host gets no sandbox with both, since its nest-proxy ignores `username` and takes any Basic substitution as written whole ([any injected credential](../sandbox/networking/egress/policy/#any-injected-credential)). The window ends when the last such host is replaced; the release after drops the gate.
- **`EgressPolicy.guards`:** a proxy that predates it ignores the field (serde skips unknown fields), so pushes aren't guarded on that host. Not gated by a hello flag: an old proxy is today's behaviour, never a regression, and nestd and nest-proxy ship in one host image. The window closes when every sandbox host runs a nest-proxy with guards.

### Designed

- **Platform tools:** the catalog becomes the grant-filtered one in [agents/tools/](../agents/tools/), plus each `mcp` or `api` capability's tools (`<capability>_<tool>`, `<capability>_request`). `ToolDef` drops `roles` and `requires_approval`; sinks and `when_tainted` come from grants. Capability definitions are control-plane data, not contract.
- **`EgressPolicy` layers** are `base`, `sandbox` and `grant` (today `base`, `workstream`, `sandbox`).
- **IDs:** `tpl_` (template).
- **Guest CLI:** `nest hold`.
- **Metrics:** hosts send a `metrics` frame on the fleet channel every 60 s ([metrics](../control-plane/metrics/)).
- **Session channel:** one stream per file of the session directory, keyed by relative path; `segment_ack` follows the SQLite commit.
- **Hands journal:** records stay in the guest, keyed by `(agent, epoch, tool_use_id)`; the runner's `call_status` lookups go through the gateway, and outcomes reach AgentDO as the runner's canonical events. nestd relays none of it.
- **Gateway:** the `/pty` and `/ingress/<port>` routes ([gateway](gateway/)).
- **`GenerationRecord`** gains `restore_abi` (a `sha256:` reference), `state` and `session{offset, last_tool_use}`.
- **Guest protocol version 2** ([host-guest](host-guest/)):
  - the version range and capabilities;
  - `flush`, with the error `sync_failed`;
  - hands `error{call_id?, executed, retry_after_ms}`, with the codes `unsupported`, `duplicate_call` and `unknown_terminal`;
  - `call_status`, the `heartbeat` frame, `detail.exit` and `calls/<id>.json`;
  - `pty_attach`, and `terminal_id` and `attach_token` on `accepted`;
  - `health{drain_log_sites}` and the ready report;
  - the CLI's `hold{duration_s}` → `{granted_s}`.
- **nestd ↔ runner:** the `claude_version` error. **runner ↔ Claude Code:** the version and SHA-256 check ([runner-claude](host-internal/runner-claude/#version)).
- **nestd ↔ proxy:** `sandbox_upsert{policy, sha256, secrets}`, `secrets_set{version, sha256, secrets}` and a `policy_ack{sandbox, epoch, version, sha256, outcome}` event ([policy acknowledgement](host-internal/nestd-proxy/#policy-acknowledgement)). New reasons: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope` and `injection_upgrade`.
- **`InjectionBinding`** gains `methods?`, `path_prefix?` and `wildcard?`; header names are checked against the reserved names.
- **Fleet:**
  - **Policy:** `policy_update` carries the policy's sha256 and its secrets, and `secrets_update` names the policy version and sha256.
  - **Versions:** FleetDO holds three desired versions per cell (brain host, sandbox host, guest image).
  - **Placement:** `hello` and `capacity` carry `restore_abis{create, load}`; `sandbox_create` carries the claim's `attempt`; `sandbox_state` reports the guest's hello and ready as evidence.
  - **Pause and suspend:** a `sandbox_pause` command. Pause and suspend carry `wake_seq` and add the outcomes `superseded` and `busy`; a commit can fail with `guest_flush_failed`.
  - **Drain:** `drain{mode: gentle|forced}`, and an all-or-nothing `pending_uploads` report with each sandbox's last committed generation.
  - **Sandboxes:** ingress-guard `activity` events; `base_prepare` and `from: base`; drive rate limits in `resources`.
  - **CLI and metrics:** `guest_cli` carries `hold`; the metrics frame carries guest log-site counts.
  - **Agents:** brokered actions carry the agent epoch.
- **Enrollment:** a fixed-shape CSR.
- **Operator API:** scoped tokens, never accepted in URLs; the revocation counter goes into share links, terminal sessions and host tokens.
- **Tool schema:** a per-tool list of rejected fields in `hands-tools.json`.
- **Claude Code invocation** ([runner-claude](host-internal/runner-claude/)): `--system-prompt-snapshot off`, `--max-turns` and `--max-budget-usd` from the budget, `DISABLE_UPDATES=1`, and `PreToolUse` answering `defer` for approvals. `SessionStart` also returns the memory key index and the recovery context, from the AgentCache.

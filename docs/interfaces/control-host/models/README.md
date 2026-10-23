# Shared models (`nest_protocol::model`)

> **Implemented contract.** See [pending contract changes](../../README.md#pending-contract-changes).

| Model | Shape (JSON) | Notes |
|---|---|---|
| IDs | `hst_`, `sbx_`, `agt_`, `ws_`, `gen_`, `ses_`, plus `trn_` (turn), `cal_` (tool call), `cmd_`, `req_`, `ask_`, `msg_` | Opaque prefixed strings |
| `SandboxState` | `creating restoring running suspending suspended archiving archived fenced destroyed failed` | SandboxDO is authoritative; hosts report transitions |
| `AgentState` | `starting ready working waiting_permission waiting_input compacting idle errored quota_parked stalled needs_attention detached` | From [state tracking](../../../agents/state-tracking/) |
| `EgressPolicy` | `{version, allow[{host, ports=[80,443], layer, expires_ms?}], passthrough[], inject[InjectionBinding], tcp[{host, port}], limits{max_connections, bandwidth_mbps, max_inspected_body_bytes}}` | **Effective** policy, merged from the layers (`base`/`workstream`/`sandbox`) by SandboxDO. `decide(host, port, now)` gives `Deny` / `Passthrough` / `Inspect` (`EgressPolicy::decide`) |
| `HostPattern` | `github.com` or `*.githubusercontent.com` | A wildcard matches subdomains, not the apex. Case-insensitive |
| `InjectionBinding` | `{name, hosts[], placeholder, locations[{type: authorization_bearer \| authorization_basic_password \| header{name}}]}` | Holds no secret value |
| `InjectionSecret` | `{binding, value, expires_ms?}` | Only in `secrets_update`; held in proxy memory only |
| `AgentEvent` | `{agent, epoch, seq, ts_ms, turn?, type, …}`; types `turn_started{input_kind} assistant_text{text} tool_call{call_id, name, input} tool_result{call_id, is_error, summary?} turn_completed{stop_reason, usage?} rate_limited{retry_after_ms?, detail} error{error} usage{usage} state_changed{state, detail?} escalation{call, tool, input} capabilities{capabilities} task_exited{task} inbox_delivered{message}` | `seq` is per agent and monotonic. `escalation`: a `PreToolUse` call matched no grant rule; the runner denied it ("pending approval (request `call`)") and AgentDO handles it like an async `ask`. `capabilities`: Claude Code's `system/init.capabilities`, reported whenever known. `inbox_delivered`: an inbox message reached the model (stdin, or returned by the `Stop` hook); AgentDO marks it consumed and pushes a `cache_update` without it |
| `WorkstreamEvent` | `{workstream, ts_ms, agent?, sandbox?, epoch?, type, …}`; types `started progress needs_input blocked pr_opened completed failed budget_exceeded quota_parked orphaned_work egress_denied egress_alert port_opened port_exposed` | `is_decision()`: `needs_input blocked pr_opened completed failed budget_exceeded orphaned_work egress_alert` wake captains |
| `GenerationRecord` | `{id, sandbox, parent?, epoch, kind: disk_only \| checkpoint, disk_manifest, mem_manifest?, reason, created_ms}` | A memory restore is valid only when the record is the head |
| `Manifest` | `{format: 1, kind: disk \| memory, chunk_size, size_bytes, chunks[blake3:<hex> \| null], prefetch[idx]}` | Stored at `<cell>/manifests/<blake3>`. `null` means an all-zero chunk |
| `CommitReason` | `turn_end timer dirty_threshold suspend drain spot_notice checkpoint fork salvage archive` | `archive`: the final commit before `sandbox_archive` evicts local state |
| `HandsBinding` | `{sandbox, epoch, cwd?}` | `cwd`: initial Bash working directory in the sandbox (absolute; default `/workspace`). Designed: `{hostname, epoch, binding, guest{protocol_version, capabilities}}`, the client side of a [gateway](../../gateway/) binding; the cwd is configured in the guest at `attach` |
| `HostRole` | `burst \| controller` | Designed: `HostKind = brain \| sandbox` ([compute](../../../compute/)) |
| `InjectionSecret` `Debug` | | Redacts `value`: logging a command that carries secrets never leaks them |
| Error codes | `stale_epoch parent_mismatch unknown_sandbox unknown_agent unauthorized forbidden unsupported_protocol_version invalid_message unknown_tool capacity_exhausted rate_limited not_bound internal not_implemented` | `not_implemented`: in the contract but not built yet; hosts and nest-mcp pass it through as an ordinary tool error |

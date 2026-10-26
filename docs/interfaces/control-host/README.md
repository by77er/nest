# Control plane ↔ host

> **Implemented contract.** It still has roles and WorkstreamDO; see [pending contract changes](../README.md#pending-contract-changes).


How hosts (nestd and the agent runner) talk to the Cloudflare control plane. Rust types: `nest_protocol::control` (messages) and `nest_protocol::model` (shared models). Fixtures: `protocol/fixtures/control/<type>/<variant>[.<case>].json`. The Rust tests round-trip every fixture and fail if any message variant lacks one; the control plane's TypeScript tests must do the same.

| Transport | Endpoint | Direction of connect | Spec |
|---|---|---|---|
| Enrollment | `POST /v1/hosts/enroll` (HTTPS) | host → Worker | [enrollment/](enrollment/) |
| Fleet channel | `wss://…/v1/fleet` (one per host) | host → FleetDO | [fleet/](fleet/) |
| Session channel | `wss://…/v1/agents/<agent>/session` (one per active agent) | agent runner → AgentDO | [session/](session/) |
| Object-store GC | `POST /v1/hosts/gc/claim` and `/v1/hosts/gc/report` (HTTPS, host token) | sandbox host → FleetDO | [GC](../../sandbox/state/object-store/#garbage-collection) |

Also: [tools/](tools/) (the platform tool catalog and call semantics) and [models/](models/) (policy, events, generations, states).

## Common rules

- **Hosts always dial out,** sandbox hosts and brain hosts alike. WebSocket upgrades carry `Authorization: Bearer <host_token>`. The first frame is a hello carrying `protocol_version` (currently `1`, `model::PROTOCOL_VERSION`). A version mismatch gets `error{unsupported_version}` and the socket closes.
- **Reliable messages** carry a per-direction `seq` (starting at 1, never reused for a connection lineage) and are acknowledged with a **cumulative** `ack{up_to}`. The sender keeps unacknowledged messages and resends them after reconnect, starting after the `last_*_seq` the peer reported in its hello or hello-ack. Receivers deduplicate by `seq`. Delivery is **at least once, in order**.
- **Unreliable messages:** `heartbeat` and its ack (a missed heartbeat is just a missed renewal), `segment` (ordered and deduplicated by byte offset instead), and `tools_list_request` / `tools_list` (retried by the caller).
- **Batching:** hosts flush `events` every 1–2 s, or sooner when a batch reaches 100 entries. FleetDO batches `commands` the same way.
- **Epoch fencing:** every sandbox-scoped command, event, commit, tool call and session hello carries the epoch. A mismatch gets `stale_epoch`; the host must treat that as a fence for the sandbox.
- **Errors:** `ErrorBody{code, message, retryable}`. Codes are in `model::error_codes` ([models](models/)).

## End-to-end: create a sandbox and run a turn

```
Captain/UI        WorkstreamDO/AgentDO        FleetDO                 host (nestd + runner)          SandboxDO
   │ spawn ────────────►│ place ────────────────►│                              │                           │
   │                    │                        │◄── epoch=1 granted ───────────┼───────────────────────────│
   │                    │                        │ commands[sandbox_create{e1}] ►│ netns+proxy+VM boot       │
   │                    │                        │◄ events[sandbox_state running, command_result ok]          │
   │                    │                        │ commands[agent_start{hands=(sbx,e1), oauth_token}] ►│      │
   │                    │◄─────────────── session WS: hello{agent, epoch 1} ─────────────│ spawn claude      │
   │                    │── hello_ack{durable_bytes}, cache_update, run_turn{trn} ──────►│ stdin user msg    │
   │                    │◄── segment… / events[turn_started, tool_call…] / tool_call ───│                   │
   │                    │── segment_ack / tool_result / ack ───────────────────────────►│                   │
   │                    │◄── events[turn_completed, state_changed idle] ────────────────│ Stop hook         │
   │                    │                        │◄ events[commit_request{turn_end}] ── │ disk writeback    │
   │                    │                        │── CAS ───────────────────────────────┼──────────────────►│
   │                    │                        │ commands[commit_result committed] ──►│                   │
```

`agent_start` names the sandbox only (and the agent epoch of the start); the runner fetches the gateway target over its session channel and its hands calls cross the network to the sandbox's host ([gateway](../gateway/)). In the design `agent_start` goes to a brain host chosen by capacity; the sequence above is the implemented placement, where both commands go to one host.

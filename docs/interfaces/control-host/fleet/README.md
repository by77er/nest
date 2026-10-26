# Fleet channel (host ↔ FleetDO)

> **Implemented contract.** Workstream fields, `role` and `WorkstreamEvent` go; see [pending contract changes](../../README.md#pending-contract-changes).


One WebSocket per host, sandbox hosts and brain hosts alike. It carries lifecycle, leases, commands and host-level events. Per-agent traffic goes over the [session channel](../session/).

> **Designed:** `hello` carries `kind: brain | sandbox`; a brain host reports brain capacity and receives only `agent_start`, `agent_stop` and `fence`; FleetDO holds three desired versions per cell (brain host, sandbox host, guest image). See [pending contract changes](../../README.md#pending-contract-changes). **Built:** `gateway_url` in `hello`, `guest` in sandbox reports, `binding_key` after `hello_ack`, and the `agent_attach`/`agent_detach` commands ([gateway](../../gateway/)).

## Messages

**Host → FleetDO (`HostToFleet`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello` | first frame | `protocol_version`, host, **`instance_id`** (random per nestd process), role, cell, component versions, `gateway_url?` (where clients reach this host's sandbox gateway, from nestd's configuration), `tunnel` (`none` | `connecting` | `connected`; absent from a nestd that predates it, read as `none`), `last_command_seq`, `capabilities?` (optional behaviours this nestd implements: `client_floor`, `stop_kill`; absent from the previous release, which is then sent neither, and a brain is moved off it only once its exit is reported or the host is gone), `cgroup_delegation_error?` (nestd was configured to keep its VMMs in its delegated unit cgroup and that setup failed; FleetDO logs it), and **a full report** of local sandboxes (epoch, state, head, dirty, and `guest{protocol_version, capabilities}` for a running one), agents (state) and capacity. FleetDO reconciles against it: unknown or stale sandboxes are fenced or destroyed. |
| `heartbeat` | no | Every 5 s: `sent_ms` and `leases[(sandbox, epoch)]`. **Renews every listed lease.** |
| `events` | seq | A batch of `HostEvent`s (below) |
| `ack` | — | Cumulative ack of `commands` |
| `ca_renew` | no | CSR for a new proxy intermediate |

**FleetDO → host (`FleetToHost`)**

| `type` | Reliable | Purpose |
|---|---|---|
| `hello_ack` | first frame | `last_event_seq` (host resends after it), lease timings, `host_token_expires_ms` |
| `heartbeat_ack` | no | Echoes `sent_ms`; `revoked[(sandbox, epoch)]` must be fenced now |
| `commands` | seq | A batch of `Command{cmd, issued_ms, type, …}`, applied **in order** |
| `ack` | — | Cumulative ack of `events` |
| `host_token` | no | Rotated bearer token |
| `binding_key` | no | `keys[{kid, public_key}]`: every binding verification key still valid for the cell (ECDSA P-256, the uncompressed point, base64url); sent after `hello_ack` and on rotation; nestd forwards it to the gateway ([gateway](../../gateway/)) |
| `proxy_ca` | no | Renewed intermediate |
| `error` | — | `ErrorBody`. `unauthorized` and `unsupported_version` close the socket (nestd also reads the older name `unsupported_protocol_version`) |

**Process lineage.** Both seq lineages (host events, commands) belong to one nestd process. When `hello.instance_id` differs from the previous connection's, FleetDO **resets both**: it forgets `last_event_seq` (the new process starts its events at 1), drops unacked commands and fails them retryably (`command_result` error, `retryable: true`), and reconciles from the hello report instead of replaying. A reconnect of the same process resumes as usual.

**In-order delivery.** On both channels a reliable message must carry `seq == last + 1`. A gap or a processing failure **closes the socket** instead of answering with an error and continuing. The sender then reconnects and resends everything unacked, so a later batch's cumulative ack can never cover an earlier failed one.

**One bad event never blocks a batch.** FleetDO parses a batch's events one at a time. An event that fails its schema (say, a malformed id that came from inside a sandbox) is **quarantined**: logged and skipped, and the batch is acked with the rest applied. Rejecting the whole frame would make the host resend it forever and stall every sandbox on the host. A processing failure, by contrast, is retryable and closes the socket as above.

## Commands

Every command yields **exactly one** `command_result{cmd, outcome: ok|error}` event. Hosts deduplicate by `cmd`, so a redelivered command just re-sends its stored result. A sandbox-scoped command whose epoch differs from the host's gets `error{stale_epoch}`.

| `type` | Fields | Host behavior |
|---|---|---|
| `sandbox_create` | sandbox, workstream, **epoch**, image, resources, policy, `from?` | **Grants the lease.** Builds the netns, proxy listeners and policy, then boots: fresh from `image`, or restored lazily from `from`. Memory restore happens only if `from.kind = checkpoint`. |
| `sandbox_suspend` | sandbox, epoch, mode (`memory`/`disk_only`) | Commit (`suspend`), then stop the VM. Keeps the netns and local state. |
| `sandbox_resume` | sandbox, epoch | Resume a sandbox suspended on this host |
| `sandbox_archive` | sandbox, epoch | Commit, then evict all local state |
| `sandbox_checkpoint` | sandbox, epoch, reason | Commit now |
| `sandbox_fork` | parent, parent_epoch, child, child_epoch, child_workstream, mode, policy | Same-host fork: commit the parent (`fork`), then create the child from that generation. For a cross-host fork, FleetDO sends `sandbox_checkpoint` to this host and `sandbox_create{from}` to the other. |
| `sandbox_destroy` | sandbox, epoch | Stop and delete local state. Chunks are left for GC. |
| `policy_update` | sandbox, epoch, policy | Applied live by nest-proxy. Ignored if `policy.version` isn't newer. |
| `secrets_update` | sandbox, epoch, secrets | Injection secret values, held in proxy memory only |
| `port_expose` / `port_unexpose` | sandbox, epoch, port, `host_header{mode}` | The gateway's preview mapping |
| `commit_result` | request, sandbox, outcome | Answer to `commit_request` (see the CAS sequence below) |
| `guest_cli_result` | request, result (`guest::CliResult`) | Answer to a `guest_cli` event; nestd relays it to the guest's pending `cli` request. Like `commit_result`, hosts resolve it **on arrival**, not in command order |
| `agent_start` | agent, role, workstream, `epoch`, `resume?`, `hands?{sandbox}`, launch, **oauth_token**, session_ws_url | Rebuild the session file from `resume.segments` (Worker-signed URLs, see the [session channel](../session/)), start Claude Code with the launch config, open the session channel. The token goes **only** into the process env. `epoch` is the agent epoch of this start. `hands` names the sandbox only; the runner fetches the gateway target over its session channel. For one release `hands.epoch` repeats `epoch` for runners of the previous release, which require it. Designed: sent to a brain host chosen by capacity |
| `agent_attach` | sandbox, epoch, agent, `cwd?`, `agent_epoch?` | Configure the agent's slot in the guest (cwd, proxy port, cgroup) on the sandbox's host; idempotent (an existing slot is replaced), `cwd` defaults to `/workspace`. SandboxDO waits for its `ok` before it hands out a binding. `agent_epoch` raises the gateway's floor for the agent first, whatever the slot work answers; SandboxDO re-sends the attach with it before every brain start. Stale epoch → `stale_epoch` |
| `agent_detach` | sandbox, epoch, agent, `kill_processes` | Remove the slot (an unknown agent is `ok`); with `kill_processes`, kill the agent's cgroup first. The gateway then refuses the agent's bindings |
| `agent_stop` | agent, reason, `mode?`, `epoch?` | `graceful` (absent: the previous release's nestd always does this) ends the turn cleanly if possible, then stops the process, in order; `kill` ends it now, applied on arrival like `fence` (AgentDO starts the brain elsewhere; only to hosts with `stop_kill`). `epoch`: the newest agent epoch the stop ends; informational. The `ok` doesn't mean the brain is gone: its `agent_exited` does |
| `client_floor` | sandbox, epoch, agent, agent_epoch | Raise the gateway's agent-epoch floor for the agent (its older bindings refused, open calls below it cut). Applied on arrival, not behind slower commands; the result, in order, is `ok` once the gateway confirmed it (or holds no such sandbox now: the floor comes with its next upsert). Idempotent. Only to hosts with `client_floor` |
| `fence` | sandboxes, reason | Pause VMs, drop listeners and netns. Brains whose hands act in them are not touched: brains are fenced by their own host's lease and agent epoch, hands by the gateway |
| `drain` | reason, deadline_ms | Commit or suspend everything by the deadline, then exit |

## Host events (`HostEvent{ts_ms, type, …}`)

| `type` | Purpose |
|---|---|
| `command_result` | `outcome: {status: ok, detail?}` or `{status: error, error}` |
| `sandbox_state` | Every transition (`model::SandboxState`), with `suspend_mode?`, `detail?` and, for `running`, `guest{protocol_version, capabilities}` (nestd caches the guest's hello, so a resume reports it too; a repeated `running` with a new `guest` is an update). |
| `incarnation_retired` | `sandbox`, `epoch`: a fenced or superseded incarnation is gone from the host (salvaged, nothing to salvage, or refused for good by SandboxDO), its disk deleted. FleetDO marks the stale incarnation clean, so it is destroyed without waiting out the salvage window. A Worker that predates it quarantines the event (logged, skipped, acked with its batch) and only loses that shortcut |
| `commit_request` | Chunks and manifest are already uploaded. Asks for a CAS with `request`, epoch, parent, kind, manifests, reason (`salvage` marks the commit as orphaned work) |
| `workstream` | A host-originated `WorkstreamEvent` (`port_opened`, `port_exposed`, `egress_denied`, `egress_alert`) |
| `egress_audit` | Batches of `EgressAuditRecord` (no secret values, no query strings), written to R2. `via?` names the nest-proxy entry point: `dns http_transparent https_transparent explicit tcp_exception`; `reason` values are listed in [nestd-proxy](../../host-internal/nestd-proxy/). `count?` marks an aggregated record (how many requests it stands for), used for nest-proxy's per-window suppression summaries |
| `capacity` | Free vCPU, memory (`MemAvailable`) and hugepages, the hugepage pool's size (`hugepages_mib_total`; 0 or absent means regular pages), counts, warm generations |
| `tunnel_state` | `state`: the host's tunnel changed to `none`, `connecting` or `connected` (from cloudflared's `/ready`); FleetDO advertises the tunnel hostname only while `connected` |
| `spot_notice` | IMDS interruption notice; the host is draining |
| `agent_exited` | Brain process exit (lifecycle only): `exit_code?`, `signal?`, `reason` (`AgentExitReason`: `idle stopped fenced auth_failed crashed`, the runner's reasons; `host_lost`, the control plane's own for a brain a reconnecting host no longer reports; `unknown`, what any other string parses as, including an older nestd's free text). `epoch?`: the agent epoch the brain ran under; AgentDO and the brain index ignore an exit of an older start. AgentDO restarts the brain at once when work is waiting after `idle`, `crashed`, `fenced` or `host_lost` |
| `guest_cli` | `request, sandbox, epoch, agent?, command` (`guest::CliCommand`): a `nest notify/emit/ask/expose` run by a program in the sandbox, attributed by `NEST_AGENT_ID`. FleetDO runs it on the agent's AgentDO as the platform tool of the same name (`expose` → `expose_port`) **without holding the event batch** (an `ask` waits ≤ 120 s, then returns `pending`), and answers with a `guest_cli_result` command. nestd gives up after `wait_s` + 15 s (`ask`) or 30 s (others) |
| `task_exited` | `sandbox, epoch, agent, task` (`guest::TaskInfo`): a background hands task exited. FleetDO forwards it to the agent's AgentDO (mid-turn it becomes an inbox note) |

## Lease and fence

Lease timings come from `hello_ack.lease`: heartbeat every **5 s**, the host self-fences **20 s** after *sending* the last acknowledged heartbeat, and FleetDO expires a lease **30 s** after the last heartbeat it *received*. Both sides measure durations, never compare clocks.

```
host                                           FleetDO                       EC2
 │ heartbeat{sent_ms=t0, leases} ─────────────►│ last_rx[host]=now
 │◄──────────────── heartbeat_ack{sent_ms=t0}  │
 │ deadline = t0 + 20s (local monotonic)       │
 ╳ partition                                   │
 │ t0+20s: SELF-FENCE                          │ t_rx+30s: lease expired
 │  stop brains, pause VMs,                    │ TerminateInstances(host) ──►│
 │  drop proxy listeners + netns               │◄── state shutting-down ─────│
 │                                             │ epoch+1 → sandbox_create{from=head} on another host
 │ (if it ever reconnects) hello{sandboxes}───►│ stale epochs → commands[fence] / revoked
```

`heartbeat_ack.revoked`, a `fence` command, or a `stale_epoch` error at any point means: fence that sandbox now. Uncommitted work is then offered as a `commit_request{reason: salvage}`.

## Commit (compare-and-set) and stale epochs

```
host                                    FleetDO → SandboxDO
 │ upload chunks + manifest to S3       │
 │ events[commit_request{req, sbx, epoch=4, parent=gen_A, kind, manifests, reason}] ─►│
 │                                      │ epoch == current && parent == head ?
 │                                      │   yes → head = gen_B
 │◄ commands[commit_result{req, outcome: committed{generation: gen_B}}]
 │                                      │   epoch stale → rejected{reason: stale_epoch, head}
 │◄ commands[commit_result{rejected stale_epoch}] → host fences sbx, then may send
 │ events[commit_request{epoch=3, parent=gen_A, reason: salvage}] ─►│ orphaned{generation} (sibling; head unchanged)
 │                                      │ + WorkstreamEvent orphaned_work → captain
```

- **`parent_mismatch`** (same epoch, head moved) doesn't happen with a single writer. If it does, it's a bug: the host re-reads the head from the next `commit_result` and fences.
- **Retries are idempotent:** a host resends a `commit_request` with the same `request` id, and SandboxDO returns the stored outcome.

## Suspend and resume

```
FleetDO                                   host
 │ commands[sandbox_suspend{sbx, e4, memory}] ─►│ wait for brains idle (refcount) → drop_caches
 │                                             │ pause VM → full hugepage snapshot → disk epoch flip
 │◄ events[sandbox_state suspending]           │ upload → commit_request{reason: suspend, kind: checkpoint}
 │ commands[commit_result committed] ─────────►│
 │◄ events[sandbox_state suspended{memory}, command_result ok]
 …
 │ commands[sandbox_resume{sbx, e4}] ─────────►│ restore (UFFD, page cache/NVMe) → guest reconnects vsock
 │◄ events[sandbox_state running, command_result ok]   (or, if evicted: sandbox_create{from: head} anywhere)
```

# nestd ↔ nest-proxy

nestd owns all state. **nest-proxy is a stateless cache:** on every (re)connection it discards everything and nestd resyncs it. On disconnect from nestd the proxy closes all listeners and connections and reconnects with backoff (fail closed).

## Messages

**nestd → proxy (`ProxyCommand`)**

| `type` | fds | Purpose |
|---|---|---|
| `hello_ack` | 0 | Starts a resync |
| `ca_install` | 0 | `ca: control::CaCertificate` (the intermediate: pathLen 0, about 7 days) + `key_pem` (nestd generated the key for the enrollment CSR). Memory only |
| `lease_update` | 0 | `valid_until_ms`, every heartbeat. Past it: refuse new connections and stop injecting for all sandboxes |
| `sandbox_upsert` | 0 | `{sandbox, epoch, workstream?, policy: model::EgressPolicy}`. Ignored unless `version` is newer. Precedes the sandbox's first `listeners_add`. Not acknowledged ([below](#policy-acknowledgement)) |
| `secrets_set` | 0 | `{sandbox, epoch, secrets: model::InjectionSecret[]}`, replace all; checked against the epoch only. Memory only |
| `listeners_add` | **= `listeners.len()`**, same order, ≤ 32 per packet | `ListenerSpec{id, transport, addr, purpose}` |
| `listeners_remove` | 0 | Close listeners; established connections finish |
| `sandbox_drop` | 0 | `reason: teardown \| fence \| moved`. Close listeners **and established connections**, forget policy and secrets. Only `fence` tombstones the epoch: later pushes at or below it are refused, by nestd's mirror and by the proxy alike (`DropReason::tombstones`). A teardown or move leaves none, so a create retried at the same epoch gets its egress back |
| `resync_complete` | 0 | Counts, so the proxy can verify |
| `ping` | 0 | Health |

**proxy → nestd (`ProxyEvent`, never fds)**: `hello`, `resync_ack`, `audit{records: control::EgressAuditRecord[]}` (≤1 s / 128 records; each sets `via`), `alert{kind: placeholder_wrong_host \| domain_fronting \| injection_after_expiry}` (immediate), `listener_failed`, `pong`, `error` (then close). `domain_fronting` covers both `Host` ≠ SNI and a CONNECT tunnel whose SNI ≠ the CONNECT authority.

**Audit record `kind`** (`control::EgressAuditKind`, absent = `request`): `request` is one connection or request; `suppressed{denials, alerts}` is a window's aggregation summary (`host: "*"`, `port: 0`, `count`, `reason: suppressed`); `limit{which: connections}` is a connection refused at `limits.max_connections` (`host: ""`, `port: 0`, `reason: connection_limit`). A proxy one release older sets no `kind`; its aggregates are told apart by `reason`.

**Aggregation is the proxy's** (per sandbox, see [policy](../../../sandbox/networking/egress/policy/#audit)). nestd only rate-limits per sandbox: it raises an `egress_denied` workstream event for a `request` record denied by policy (`not_allowed`, `dns_nxdomain`, `tcp_exception_not_in_policy`: `EgressAuditRecord::is_policy_denial`), and an `egress_alert` for every `alert`, binding included. Everything else stays in the audit log.

**Listener failures.** nestd owns listeners. On `listener_failed` it closes its own copy, binds a fresh socket at the same address in the sandbox's netns and resends it under the same id; after 3 failures of one listener within 10 minutes it drops the listener from its mirror instead (the guest then gets connection refused, not a hang).

**Listener purposes** (`purpose` is flattened into the spec):

| `purpose` | Address | Attribution |
|---|---|---|
| `dns` (udp + tcp) | `172.16.0.1:53` | sandbox |
| `http_transparent` / `https_transparent` | `:80` / `:443` (nft redirect) | sandbox |
| `explicit{agent, slot}` | `:3128 + slot` (= `guest::AgentSlot.proxy_port`) | agent |
| `tcp_exception{rule: "host:port"}` | `:20000 + n` | sandbox; one per `model::TcpException` |

**Ordering.** One connection, processed in order. Each fd belongs to the packet it arrived with, so there's no cross-packet fd bookkeeping. If a packet's fd count ≠ `expected_fds()`, the proxy sends `error{invalid_message}` and closes. nestd resyncs on reconnect.

## Policy acknowledgement

**Not built** ([pending contract changes](../../README.md#pending-contract-changes)). Today nestd sends `sandbox_upsert`, an empty `secrets_set` and the listeners, and boots the VM without waiting; policy and secrets are separate pushes (`policy_update`, `secrets_update`). The design:

- **The proxy acknowledges what it installed:** `policy_ack{sandbox, epoch, version, sha256}` after it recomputes the hash, installs the policy and its secrets together, and re-checks open connections. **nestd starts or resumes the VM only after an `installed` ack** matching what it sent ([steering](../../../sandbox/networking/egress/steering/)).
- **Refused** (with `reason`): a hash mismatch, a secret whose binding isn't in the policy, or a stale or fenced epoch. The proxy keeps its previous policy; nestd fails the command retryably.
- **Secrets travel with the policy they belong to.** `sandbox_upsert` carries both; `secrets_set` (token refresh) names the installed `version` and `sha256`, and is refused if either differs or a binding isn't in that policy.
- **Until a sandbox has an acknowledged policy,** its new connections are held for up to 30 s, then denied (`policy_pending`), and DNS answers SERVFAIL.

## Proxy (re)start: resync

```
nest-proxy                                   nestd
 │ connect /run/nest/proxy.sock ──────────────►│
 │ hello{protocol_version, pid} ──────────────►│
 │◄────────────── hello_ack{host_id, nestd_boot_id}│  proxy: discard all state
 │◄────────────── ca_install{ca, key}          │
 │◄────────────── lease_update{valid_until}    │
 │   for each sandbox:                         │
 │◄────────────── sandbox_upsert{policy}, secrets_set{secrets}
 │◄══ fds ═══════ listeners_add{listeners[≤32]} (repeat)  nestd keeps its own dups, so
 │◄────────────── resync_complete{n, m}        │  connections queue in the kernel meanwhile
 │ resync_ack{n, m, failed} ─────────────────►│  failed listeners → rebound one by one
```

**Resync counts.** `resync_ack` carries the proxy's **own** counts of sandboxes and listeners it now holds, plus `failed: [{sandbox, listener_ids}]`: listeners it was handed during the resync but couldn't serve (no separate `listener_failed` is sent for those; at most 1024 ids). nestd checks `listeners + failed = sent` and handles each failed listener like a `listener_failed`, so one bad sandbox can't make the whole host reconnect in a loop. Only a mismatch the failures don't explain closes the connection for a fresh resync. An older proxy sends no `failed`, which is the plain totals check.

## Sandbox network setup → listener handoff

```
FleetDO         nestd (root)                                      nest-proxy         Firecracker
 │ sandbox_create ►│ ip netns add ns-<id>; tap0 172.16.0.1/30; nft    │                   │
 │                 │ helper thread: setns(ns) → socket/bind/listen ×N │                   │
 │                 │ → setns(back)                                    │                   │
 │                 │ sandbox_upsert{policy}, secrets_set{} ───────────►│                   │
 │                 │ listeners_add + fds ═════════════════════════════►│ accept loops      │
 │                 │ jailer --netns ns-<id> … ──────────────────────────────────────────►│ boot/restore
 │                 │ new agent slot → bind :3128+slot → listeners_add ►│                   │
 │                 │ self-fence → sandbox_drop{fence}; ip netns del   ►│ close everything  │
```

**Suspend** keeps the netns and listeners (no message). **Move/teardown** sends `sandbox_drop`.

## Audit `reason` values

`reason` is one string on the wire: `control::EgressReason`, mirrored in the control plane's zod schema. A unit member is its name; an upstream failure is `<stage>: <detail>`, with the resolver's, socket's or TLS library's own text. A string a reader doesn't know parses as `other` with its text kept. This table lists exactly what nest-proxy emits (a test in `nest-protocol` compares it with the enum). Rows already in R2 stay as written: older ones may hold `suppressed: …` prose, `upstream: …` (now `exchange: …`) or other prose.

| Reason | Verdict | Meaning |
|---|---|---|
| `not_allowed` | deny | Host (or port) not in the effective allowlist. Raises `egress_denied` |
| `dns_nxdomain` | deny | DNS name not allowlisted (`via: dns`, `port: 53`), answered NXDOMAIN. Raises `egress_denied` |
| `tcp_exception_not_in_policy` | deny | A TCP exception listener whose rule is no longer in policy. Raises `egress_denied` |
| `invalid_host` | deny (alert when inspected) | SNI, `Host` or CONNECT authority isn't a DNS name or IP literal (≤ 253 bytes) |
| `not_tls` / `no_sni` | deny | `:443` traffic without a TLS ClientHello / without SNI |
| `no_ca` | deny | No intermediate CA installed yet, so inspection is impossible |
| `connection_limit` | deny | Sandbox at `limits.max_connections` (kind `limit`) |
| `host_mismatch` | deny | Plaintext request whose target or `Host` names another host than the one that routed it |
| `host_sni_mismatch` | alert | Decrypted `Host` or request target ≠ SNI (domain fronting) |
| `duplicate_host` | deny (alert when inspected) | More than one `Host` header |
| `sni_mismatch` | alert | CONNECT tunnel's SNI ≠ the CONNECT authority (domain fronting) |
| `non_tls_tunnel` | deny | CONNECT tunnel to an allowed host that didn't start TLS |
| `placeholder_wrong_host` | alert | A binding's placeholder sent to a host outside the binding |
| `injection_unavailable` | alert | Placeholder present but its secret is missing, expired or fenced |
| `injection_requires_tls` | deny | Placeholder over plain HTTP |
| `trace_with_credential` | deny | TRACE/TRACK on a request carrying an injected credential |
| `tcp_exception` | allow | Spliced TCP exception |
| `upgraded` | allow | Connection upgraded (WebSocket) and spliced after the handshake |
| `suppressed` | deny | A window's aggregation summary (kind `suppressed`) |
| `resolve: …` / `connect: …` / `exchange: …` | deny (allow with `status: 502` mid-request) | Upstream failure: resolving the name; resolving and connecting; or the upstream TLS handshake, certificate check or the request |

**Designed, not emitted yet** (they arrive with their features in the [egress](../../../sandbox/networking/egress/) design, and join the enum then): `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope`, `injection_upgrade`.

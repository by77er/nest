# nestd ↔ nest-proxy

nestd owns all state. **nest-proxy is a stateless cache:** on every (re)connection it discards everything and nestd resyncs it. On disconnect from nestd the proxy closes all listeners and connections and reconnects with backoff (fail closed).

## Messages

**nestd → proxy (`ProxyCommand`)**

| `type` | fds | Purpose |
|---|---|---|
| `hello_ack` | 0 | Starts a resync |
| `ca_install` | 0 | `ca: control::CaCertificate` (the intermediate: pathLen 0, about 7 days) + `key_pem` (nestd generated the key for the enrollment CSR). Memory only |
| `lease_update` | 0 | `valid_until_ms`, every heartbeat. Past it: refuse new connections and stop injecting for all sandboxes |
| `sandbox_upsert` | 0 | `{sandbox, epoch, workstream?, policy: model::EgressPolicy}` (`workstream`: the compat `ws_` value nestd got, unused). Ignored for an older epoch, or unless `version` is newer. A newer epoch (or a `secrets_set` at one) starts the sandbox's view afresh: nothing of the older epoch's policy or secrets carries over. Precedes the sandbox's first `listeners_add`. Not acknowledged ([below](#policy-acknowledgement)) |
| `secrets_set` | 0 | `{sandbox, epoch, secrets: model::InjectionSecret[]}`, replace all; checked against the epoch only. Memory only |
| `listeners_add` | **= `listeners.len()`**, same order, ≤ 32 per packet | `ListenerSpec{id, transport, addr, purpose}` |
| `listeners_remove` | 0 | Close listeners; established connections finish |
| `sandbox_drop` | 0 | `reason: teardown \| fence \| moved`. Close listeners **and established connections**, forget policy and secrets. Only `fence` tombstones the epoch: later pushes at or below it are refused, by nestd (its one tombstone map, recorded before the drop is sent) and by the proxy alike (`DropReason::tombstones`, over the same `nestd_core` `TombstoneMap`). A teardown or move leaves none, so a create retried at the same epoch gets its egress back |
| `resync_complete` | 0 | Counts, so the proxy can verify |
| `ping` | 0 | Health |

**proxy → nestd (`ProxyEvent`, never fds)**: `hello`, `resync_ack`, `audit{records: control::EgressAuditRecord[]}` (≤1 s / 128 records; each sets `via`), `alert{kind: placeholder_wrong_host \| domain_fronting \| injection_after_expiry}` (immediate), `listener_failed`, `pong`, `error` (then close). `domain_fronting` covers both `Host` ≠ SNI and a CONNECT tunnel whose SNI ≠ the CONNECT authority.

**Aggregate audit records** have `port: 0`: a window's suppression summary (`host: "*"`, `count` set, `reason: "suppressed: …"`) and `connection_limit` (`host: ""`). nestd raises an `egress_denied` sandbox event only for one request's denial (deny, no `count`, a real port); aggregates go to the audit log only.

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
 │ resync_ack{n, m} ─────────────────────────►│  mismatch → nestd closes and retries
```

**Resync counts.** `resync_ack` carries the proxy's **own** counts of sandboxes and listeners it now holds. nestd compares them with what it sent; on a mismatch nestd closes and resyncs (the proxy only logs it).

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

`reason` is a string on the wire. nest-proxy emits these; the ones marked **designed** come with the [pending](../../README.md#pending-contract-changes) proxy work and aren't emitted yet:

| Reason | Verdict | Meaning |
|---|---|---|
| `not_allowed` | deny | Host not in the effective allowlist |
| `not_tls` / `no_sni` | deny | `:443` traffic without a TLS ClientHello / without SNI |
| `invalid_host` | deny | The SNI, CONNECT authority or `Host` isn't a valid hostname |
| `no_ca` | deny | No intermediate CA installed yet, so inspection is impossible |
| `dns_nxdomain` | deny | DNS name not allowlisted (`via: dns`, `port: 53`) |
| `dns_non_public` (designed) | deny | Every address in the DNS answer was non-public, so it became SERVFAIL |
| `connection_limit` | deny | Sandbox at `limits.max_connections` (`host: ""`) |
| `handshake_limit` (designed) | deny | TLS handshake or leaf signing over the proxy-wide or per-sandbox bound |
| `policy_pending` (designed) | deny | No acknowledged policy within 30 s |
| `policy_changed` (designed) | deny | Closed by a re-check after a policy version or grant expiry, or failed the final check before the headers went upstream |
| `invalid_headers` (designed) | deny | Smuggling-shaped request (`Connection` naming a protected field, a transfer coding other than `chunked`, a protected `Trailer`) or over the header limits |
| `host_sni_mismatch` | alert | Decrypted `Host` ≠ SNI (domain fronting) |
| `sni_mismatch` | alert | CONNECT tunnel's SNI ≠ the CONNECT authority (domain fronting) |
| `placeholder_wrong_host` | alert | A binding's placeholder sent to a host outside the binding |
| `injection_unavailable` | deny | Placeholder present but its secret is missing, expired or fenced |
| `injection_requires_tls` | deny | Placeholder over plain HTTP |
| `trace_with_credential` | deny | `TRACE` or `TRACK` with a placeholder substituted (the upstream would echo the secret) |
| `injection_out_of_scope` (designed) | deny | Placeholder on a method or path outside the binding |
| `injection_upgrade` (designed) | deny | Protocol upgrade on a request that had a placeholder substituted |
| `tcp_exception_not_in_policy` | deny | A TCP exception listener whose rule is no longer in policy |
| `non_tls_tunnel` | deny | CONNECT tunnel to an inspected host that didn't start TLS |
| `guard: <name>` | deny | A [request guard](../../../sandbox/networking/egress/policy/#request-guards) refused the request (403 `request_denied`, with `guard` and `reason`) |
| `upgraded` | allow | Connection upgraded (WebSocket) and spliced after the handshake |
| `tcp_exception` | allow | Spliced TCP exception |
| `upstream: …` / `connect: …` / `resolve: …` | deny | Upstream failure (TLS verification, connect or resolution), with detail |

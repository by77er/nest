# nestd ↔ nest-proxy

nestd owns all state. **nest-proxy is a stateless cache:** on every (re)connection it discards everything and nestd resyncs it. On disconnect from nestd the proxy closes all listeners and connections and reconnects with backoff (fail closed).

## Messages

**nestd → proxy (`ProxyCommand`)**

| `type` | fds | Purpose |
|---|---|---|
| `hello_ack` | 0 | Starts a resync |
| `ca_install` | 0 | `ca: control::CaCertificate` + `key_pem` (nestd generated the key for the enrollment CSR). Memory only |
| `lease_update` | 0 | `valid_until_ms`, every heartbeat. Past it: refuse new connections and stop injecting for all sandboxes |
| `sandbox_upsert` | 0 | `model::EgressPolicy` (ignored unless `version` is newer). Precedes the sandbox's first `listeners_add` |
| `secrets_set` | 0 | `model::InjectionSecret[]` for the sandbox's bindings (replace all). Memory only |
| `listeners_add` | **= `listeners.len()`**, same order, ≤ 32 per packet | `ListenerSpec{id, transport, addr, purpose}` |
| `listeners_remove` | 0 | Close listeners; established connections finish |
| `sandbox_drop` | 0 | `reason: teardown \| fence \| moved`. Close listeners **and established connections**, forget policy and secrets |
| `resync_complete` | 0 | Counts, so the proxy can verify |
| `ping` | 0 | Health |

**proxy → nestd (`ProxyEvent`, never fds)**: `hello`, `resync_ack`, `audit{records: control::EgressAuditRecord[]}` (≤1 s / 128 records; each sets `via`; aggregated suppression summaries set `count`), `alert{kind: placeholder_wrong_host \| domain_fronting \| injection_after_expiry}` (immediate), `listener_failed`, `pong`, `error` (then close). `domain_fronting` covers both `Host` ≠ SNI and a CONNECT tunnel whose SNI ≠ the CONNECT authority.

**Listener purposes** (`purpose` is flattened into the spec):

| `purpose` | Address | Attribution |
|---|---|---|
| `dns` (udp + tcp) | `172.16.0.1:53` | sandbox |
| `http_transparent` / `https_transparent` | `:80` / `:443` (nft redirect) | sandbox |
| `explicit{agent, slot}` | `:3128 + slot` (= `guest::AgentSlot.proxy_port`) | agent |
| `tcp_exception{rule: "host:port"}` | `:20000 + n` | sandbox; one per `model::TcpException` |

**Ordering.** One connection, processed in order. Each fd belongs to the packet it arrived with, so there's no cross-packet fd bookkeeping. If a packet's fd count ≠ `expected_fds()`, the proxy sends `error{invalid_message}` and closes. nestd resyncs on reconnect.

## Proxy (re)start: resync

```
nest-proxy                                   nestd
 │ connect /run/nest/proxy.sock ──────────────►│
 │ hello{protocol_version, pid} ──────────────►│
 │◄────────────── hello_ack{host_id, nestd_boot_id}│  proxy: discard all state
 │◄────────────── ca_install{ca, key}          │
 │◄────────────── lease_update{valid_until}    │
 │   for each sandbox:                         │
 │◄────────────── sandbox_upsert{policy}       │
 │◄────────────── secrets_set{secrets}         │
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
 │                 │ sandbox_upsert / secrets_set ───────────────────►│                   │
 │                 │ listeners_add + fds ═════════════════════════════►│ accept loops      │
 │                 │ jailer --netns ns-<id> … ──────────────────────────────────────────►│ boot/restore
 │                 │ new agent slot → bind :3128+slot → listeners_add ►│                   │
 │                 │ self-fence → sandbox_drop{fence}; ip netns del   ►│ close everything  │
```

**Suspend** keeps the netns and listeners (no message). **Move/teardown** sends `sandbox_drop`.

## Audit `reason` values

`reason` is a string on the wire. nest-proxy emits:

| Reason | Verdict | Meaning |
|---|---|---|
| `not_allowed` | deny | Host not in the effective allowlist |
| `not_tls` / `no_sni` | deny | `:443` traffic without a TLS ClientHello / without SNI |
| `no_ca` | deny | No intermediate CA installed yet, so inspection is impossible |
| `dns_nxdomain` | deny | DNS name not allowlisted (`via: dns`, `port: 53`) |
| `connection_limit` | deny | Sandbox at `limits.max_connections` (`host: ""`) |
| `host_sni_mismatch` | alert | Decrypted `Host` ≠ SNI (domain fronting) |
| `sni_mismatch` | alert | CONNECT tunnel's SNI ≠ the CONNECT authority (domain fronting) |
| `placeholder_wrong_host` | alert | A binding's placeholder sent to a host outside the binding |
| `injection_unavailable` | deny | Placeholder present but its secret is missing, expired or fenced |
| `injection_requires_tls` | deny | Placeholder over plain HTTP |
| `tcp_exception_not_in_policy` | deny | A TCP exception listener whose rule is no longer in policy |
| `non_tls_tunnel` | deny | CONNECT tunnel to an inspected host that didn't start TLS |
| `upgraded` | allow | Connection upgraded (WebSocket) and spliced after the handshake |
| `tcp_exception` | allow | Spliced TCP exception |
| `upstream: …` / `connect: …` / `resolve: …` | deny | Upstream failure (TLS verification, connect or resolution), with detail |

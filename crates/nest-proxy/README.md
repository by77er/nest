# nest-proxy

The only way out of a sandbox. It's an unprivileged Rust process, one per host. nestd binds listening sockets inside each sandbox netns and hands them over SEQPACKET + `SCM_RIGHTS`. **The proxy never calls `setns` and needs no capabilities.**

- **Design docs:** `docs/sandbox/networking/egress/` (steering, dns, tls, policy, injection)
- **Protocol:** `docs/interfaces/host-internal/nestd-proxy/` and `nest_protocol::host::proxy`

```
nest-proxy [--nestd-sock /run/nest/proxy.sock] [--extra-root FILE.pem]... [--no-webpki-roots]
NEST_LOG=debug   # tracing filter
```

## Modules

| Module | Role |
|---|---|
| `control` | nestd connection: hello / resync, commands, events back. Reconnects with backoff; **every session starts empty**. |
| `listener` | Turns handed fds into accept loops (checks the socket type); fail-closed gate on each accept |
| `dns` | Answers only allowlisted names (NXDOMAIN otherwise, never forwarded); records answers per sandbox (60 s TTL cap); ≤32 queries in flight per sandbox |
| `http` | Transparent `:443` (SNI) and `:80` (Host); explicit proxy (CONNECT + absolute-form); deny / passthrough / inspect; upgrades; TCP exceptions; upstream connections |
| `tls` | Leaf certificates minted on the fly from the installed intermediate (ECDSA P-256, cached); upstream verification against webpki roots plus extra roots |
| `sni` | Minimal ClientHello parser (SNI + ALPN, fragmented records) |
| `inject` | Placeholder substitution (bearer / basic password / named header). Blocks on wrong host, expired or fenced secret, or plaintext. |
| `guard` | Request guards: generic host / method / path / query / JSON-field / injected-binding (named, or `*` for any) rules, evaluated after injection; knows no service ([request guards](../../docs/sandbox/networking/egress/policy/#request-guards)) |
| `audit` | Per-request and per-connection records, batched ≤1 s / 128, split to fit one packet; string caps for every event |
| `state` | Per-session and per-sandbox state: policy, secrets, listeners, connection limit, DNS record, drop tombstones, deny/alert aggregation, bounded upstream resolution |

## Behavior worth knowing

- **Fail closed:**
  - If nestd disconnects, every listener and connection is closed.
  - If the lease mirror lapses, new connections are dropped, DNS returns REFUSED, and nothing is injected.
- **Upstreams** are always re-resolved by the proxy from SNI / Host / CONNECT authority, **never** from the IP the guest dialed.
- **Non-public upstream addresses are refused:** loopback, private ranges, link-local/IMDS, CGNAT, ULA. `Config::allow_private_upstreams` turns this off for tests only.
- **Decisions:**
  - **Deny:** after TLS termination, a JSON 403 with a hint to use `egress_policy`.
  - **Passthrough:** spliced, never decrypted.
  - **Inspect:** the upstream TLS connection comes first (its ALPN is mirrored to the client). The request target's authority and the single `Host` header must both equal the routed host; the h1 upstream always gets a `Host` set by the proxy.
- **CONNECT:** tunnels must carry TLS with SNI equal to the authority; plaintext tunnels are denied (`non_tls_tunnel`). A denied CONNECT is accepted and answered inside the tunnel with the readable 403 (over our TLS, or plaintext).
- **Guest-controlled names** are validated (DNS name or IP literal, ≤253 bytes) before policy. Every event to nestd has its strings capped, and an event that would still exceed `MAX_PACKET_FROM_PROXY` is dropped rather than breaking the link.
- **Dropped sandboxes stay dropped:** a `sandbox_drop` is remembered per epoch, so a late upsert, secrets or listener push for that epoch is refused.
- **Deny/alert aggregation per sandbox:** one record per distinct key per minute, capped (128 denials, 32 alerts), with a `suppressed: …` summary record.
- **Injection** only happens over TLS, and only to the binding's own hosts. A placeholder seen anywhere in the headers or URI for another host is blocked and raises `placeholder_wrong_host`. On substituted requests, TRACE/TRACK are refused, and the secret is masked (length-preserving) in response headers and uncompressed bodies.
- **Non-public upstreams** also cover NAT64 / 6to4 / IPv4-compatible IPv6 (judged by the embedded IPv4), local-use NAT64, site-local, Teredo and 192.0.0.0/24.
- **`te: trailers`** is kept on h2 upstreams (gRPC).
- **Hop-by-hop headers and `Proxy-Authorization` are never forwarded.**

## Tests

```
CARGO_TARGET_DIR=target/nest-proxy cargo test -p nest-proxy
```

- **Unit tests:** SNI parsing (real rustls ClientHellos, fragmented), leaf certificates chaining to the root, injection cases, the DNS allowlist, address filtering, header and URI handling, audit batching.
- **End-to-end tests (`tests/egress.rs`):**
  - Setup: a real proxy driven by a fake nestd over SEQPACKET with fds bound on 127.0.0.1, a TLS echo upstream (h1/h2/WebSocket), a plaintext upstream and a TCP echo.
  - Covered:
    - injection (bearer, git basic, h1 and h2)
    - readable 403s, passthrough without decryption
    - Host≠SNI and placeholder-exfil alerts, expired secrets
    - private-upstream refusal
    - DNS allow and NXDOMAIN over UDP and TCP
    - lease-lapse fail-closed and recovery
    - nestd restart → resync, with a connection queued during the gap being served
    - explicit CONNECT inject / deny / absolute-form, transparent `:80`
    - TCP exception splice, and `sandbox_drop` killing established connections
    - fd-count protocol errors
    - stale policy pushes ignored
    - WebSocket through inspection
    - h2 multiplexing
- **Request guards:** the evaluator with made-up rules (`guard.rs` unit tests; `tests/guards.rs` through the real proxy: refusal before the upstream, a judged body replayed whole, the injected-credential exceptions, named and `*` (any binding), guarded hosts never spliced or TCP exceptions, a target past the guarded bounds refused), its cost (`tests/guard_cost.rs`: the worst matcher shapes within the bounds against a time budget, and oversized targets refused before any matcher), the once-per-request decoding against the evaluator before it (`tests/guard_equivalence.rs`, generated requests and guards, with `injected: "*"` decided as the binding the request carries, and the previous evaluator failing closed on an exception's `*` and open on a scope's), the seam with API clients' guards (`tests/client_guards.rs` on `egress_policy.client_guards.json`), the seam for `injected: "*"` (`tests/injected_any.rs` on `egress_policy.injected_any.json`), and the seam with the control plane's GitHub constructor (`tests/github_rules.rs` evaluates its output, the fixtures `egress_policy.github.json` and, with a read-only repo, `egress_policy.github_read.json`, against GitHub's request shapes).
- **Security regression tests (`tests/review_regressions.rs`):** absolute-form/Host fronting with injection, duplicate Host, upstream Host rewrite, explicit-proxy fronting, plaintext CONNECT tunnels (incl. passthrough hosts), denied CONNECT answered in-tunnel, a 70 KB Host not breaking the nestd link, pushes after `sandbox_drop`, DNS-flood aggregation, TRACE with a credential, `te: trailers` over h2.

## Gaps

- Request **bodies** aren't scanned for placeholders, only headers and the URI. A placeholder is worthless outside the proxy, so this is low risk.
- **Compressed response bodies** aren't scanned for reflected secrets (headers still are).
- The aggregation summary is emitted lazily, on the first deny/alert after a window ends.
- **Bandwidth shaping** lives on the tap device (nestd), not here. Limits enforced here: connection count and inspected request body size.
- **The upstream resolver** is the host's (getaddrinfo). A dedicated upstream DNS server isn't configurable yet.
- No **metrics** endpoint. No h2c or HTTP/3 (UDP is blocked by design).
- **Behind the design** ([egress](../../docs/sandbox/networking/egress/)): routing-override stripping and smuggling checks ([inspection](../../docs/sandbox/networking/egress/inspection/)), policy versions with re-checks of open connections and the `policy_ack`, the hard-deny list, binding `methods`/`path_prefix` and the no-upgrade rule, DNS answer hygiene, and the per-sandbox handshake and leaf-signing limits aren't built.

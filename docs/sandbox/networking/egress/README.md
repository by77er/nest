# Egress (nest-proxy)

The only way out of a sandbox. **nest-proxy** is one **unprivileged** Rust process per sandbox host (tokio, hyper, rustls). **nestd** does all namespace setup and hands it pre-bound sockets.

Sandboxes hold **no credentials** and never talk to model providers. Brains go directly to Anthropic from their brain hosts through a plain host allowlist, with nothing decrypted; a sandbox host's own egress needs no Anthropic hosts.

```
accept (listener ⇒ sandbox [, agent])
  → policy acknowledged? (no: hold ≤ 30 s, then deny)
  → read SNI / CONNECT target / Host → validate the name → policy(sandbox, agent?, host:port)
      deny        → HTTP 403 + JSON reason (over our TLS, or plaintext), `egress_denied` event
      passthrough → splice TCP without decrypting (pinned clients; SNI only, so no injection,
                    no inspection)
      inspect     → terminate TLS → the request target and the single Host must name the routed
                    host (no domain fronting) → strip routing overrides, reject smuggling →
                    credential injection → request guards → re-check policy → upstream with a Host
                    the proxy sets
                    (proxy re-resolves the name, refuses non-public addresses and verifies the
                    upstream certificate)
  open connections: re-checked on every policy version and grant expiry; closed once denied
```

- **Explicit proxy CONNECT:** every tunnel must carry TLS whose SNI matches the CONNECT authority. Plaintext tunnels are denied (plain HTTP goes as absolute-form requests, which get the same Host checks). A denied CONNECT is still accepted and answered *inside* the tunnel with the readable 403, because clients like curl hide a CONNECT error body.
- **Guest-controlled names** (SNI, Host, CONNECT authority) are validated as DNS names or IP literals (≤253 bytes) before policy, and every string the proxy reports to nestd is length-capped. An oversized event is dropped, never sent: it would take down the control link for the whole host.
- **Non-public addresses are refused twice:** by the proxy before any policy applies, and by a kernel rule on the proxy's uid, since the proxy runs where IMDS is reachable ([policy](policy/#hard-deny), [steering](steering/#kernel-backstop)).
- **One proxy, many sandboxes:** TLS handshakes and leaf signing are bounded per sandbox as well as globally, and request headers per connection, so one sandbox can't starve the others ([tls](tls/#shared-proxy-fairness), [inspection](inspection/)).

| Component | Doc |
|---|---|
| Listeners, fd passing, nft rules, policy acknowledgement, kernel backstop, attribution | [steering/](steering/) |
| Resolver: allowlisted names only, filtered and bounded answers | [dns/](dns/) |
| CA chain (root in KMS), on-the-fly leaf certificates, handshake fairness, upstream verification | [tls/](tls/) |
| Request checks after decryption: routed name, routing overrides, smuggling, limits, final re-check | [inspection/](inspection/) |
| Hard deny, policy layers, live re-checks, temporary grants, TCP exceptions, request guards, repo allowlists, limits, audit | [policy/](policy/) |
| Placeholder credential injection, binding scope, GitHub App | [injection/](injection/) |

**Late pushes can't revive a dropped sandbox:** the proxy remembers `sandbox_drop` per epoch and refuses policy, secrets and listeners for that epoch or older, so a fence racing sandbox setup stays fenced. A newer epoch (re-placement) is accepted.

**Fails closed:** if nest-proxy dies, sandboxes have no egress. systemd restarts it, and nestd hands back every listener (connections wait in the kernel's accept queue meanwhile).

**No LLM API-key proxy.** Apps that call model APIs bring their own keys and need, for example, `api.anthropic.com` in their allowlist. A personal key proxy would be allowed by the terms, but it's left out by choice.

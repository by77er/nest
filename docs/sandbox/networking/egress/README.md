# Egress (nest-proxy)

The only way out of a sandbox. **nest-proxy** is one **unprivileged** Rust process per host (tokio, hyper, rustls). **nestd** does all namespace setup and hands it pre-bound sockets.

Sandboxes hold **no credentials** and never talk to model providers. Brains on the host go directly to Anthropic through a plain allowlist, with nothing decrypted.

```
accept (listener ⇒ sandbox [, agent])
  → read SNI / CONNECT target / Host → validate the name → policy(sandbox, agent?, host:port)
      deny        → HTTP 403 + JSON reason (over our TLS, or plaintext), `egress_denied` event
      passthrough → splice TCP without decrypting (pinned clients; no injection, no inspection)
      inspect     → terminate TLS → the request target and the single Host must name the routed
                    host (no domain fronting) → credential injection → upstream with a Host the
                    proxy sets (proxy re-resolves the name and verifies the upstream certificate)
```

- **Explicit proxy CONNECT:** every tunnel must carry TLS whose SNI matches the CONNECT authority. Plaintext tunnels are denied (plain HTTP goes as absolute-form requests, which get the same Host checks). A denied CONNECT is still accepted and answered *inside* the tunnel with the readable 403, because clients like curl hide a CONNECT error body.
- **Guest-controlled names** (SNI, Host, CONNECT authority) are validated as DNS names or IP literals (≤253 bytes) before policy, and every string the proxy reports to nestd is length-capped. An oversized event is dropped, never sent: it would take down the control link for the whole host.

| Component | Doc |
|---|---|
| Listeners, fd passing, nft redirect, attribution | [steering/](steering/) |
| Resolver: allowlisted names only | [dns/](dns/) |
| CA hierarchy, on-the-fly leaf certificates, upstream verification | [tls/](tls/) |
| Policy layers, temporary grants, TCP exceptions, limits, audit | [policy/](policy/) |
| Placeholder credential injection, GitHub App | [injection/](injection/) |

**Late pushes can't revive a dropped sandbox:** the proxy remembers `sandbox_drop` per epoch and refuses policy, secrets and listeners for that epoch or older, so a fence racing sandbox setup stays fenced. A newer epoch (re-placement) is accepted.

**Fails closed:** if nest-proxy dies, sandboxes have no egress. systemd restarts it, and nestd hands back every listener (connections wait in the kernel's accept queue meanwhile).

**No LLM API-key proxy.** Apps that call model APIs bring their own keys and need, for example, `api.anthropic.com` in their allowlist. A personal key proxy would be allowed by the terms, but it's left out by choice.

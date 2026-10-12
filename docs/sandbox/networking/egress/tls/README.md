# TLS

- **Root CA:** its key stays in the control plane, and the root certificate is baked into the image (plus `NODE_EXTRA_CA_CERTS` for tools that need it).
- **Per-host intermediate CA:** short-lived (about 7 days), issued at host enrollment, and used to sign leaf certificates on the fly, cached per SNI (ECDSA P-256). A compromised host's intermediate expires on its own and is never reissued.
- **Upstream verification:** the proxy validates server certificates against the standard public roots (webpki-roots) and **fails closed**. Sandboxes depend on it for this.
- **Upstream addressing:** the proxy **re-resolves the SNI name** for the upstream connection, never using the IP the guest dialed.
- **After decrypting, the routed name is the only name:** an absolute-form request target and the `Host` header must both equal the SNI. A second `Host` header is rejected, and the h1 upstream always gets a `Host` the proxy sets itself, so a Host-routing CDN can never be steered to another origin.
- **Non-public upstream addresses are refused:** loopback, private, link-local/IMDS, CGNAT, 192.0.0.0/24, unique-local and site-local IPv6, Teredo, discard-only. IPv6 forms that embed an IPv4 address (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`, IPv4-mapped) are judged by the embedded address; local-use NAT64 `64:ff9b:1::/48` is always refused.
- **Protocols:** the client is offered the same ALPN the upstream negotiated, so HTTP/1.1, h2, gRPC and WebSocket upgrades all work. `te: trailers` is kept on h2 for gRPC; other hop-by-hop headers are stripped. HTTP/3 is blocked, since UDP is.
- **Pinned clients** go on the SNI-passthrough list. They get no injection and no inspection.

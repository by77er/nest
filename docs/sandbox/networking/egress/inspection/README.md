# Inspected requests

What nest-proxy enforces on every request it parses (decrypted TLS, plaintext `:80`, absolute-form) before anything goes upstream. A violation is answered with the readable 403 or a 400, and audited.

**The routed name is the only name:**
- An absolute-form request target and the `Host` header must both equal the SNI (or the CONNECT authority / plaintext `Host` the request was routed by).
- A second `Host` header is rejected.
- The h1 upstream always gets a `Host` the proxy sets itself, so a Host-routing CDN can never be steered to another origin.

**Routing overrides are stripped,** from headers and trailers, because some edges route on them instead of `Host`:
- **`Fastly-*`, except `Fastly-Key`** (it authenticates Fastly API calls and doesn't route). Fastly prefers `Fastly-Host` over `Host` when picking the service for a request ([Fastly special headers](https://www.fastly.com/documentation/reference/vcl/special-headers/)), and `pypi.org` and `files.pythonhosted.org`, both in the base allowlist, are served by Fastly ([PyPI](https://pypi.org/sponsors/)). Without stripping, an allowed PyPI connection could reach any Fastly service.
- **Generic overrides:** `Forwarded`, `X-Forwarded-Host`, `X-Host`, `X-Original-URL`, `X-Rewrite-URL`. Some origin frameworks and CDN configurations treat them as the authority or path; which ones do is configuration-specific (unverified per host). A sandbox has no reason to send them to a third party.
- Another CDN that routes on guest-supplied headers is added to this denylist.

**Request smuggling is rejected** (400, `invalid_headers`):
- A `Connection` header that names a protected field: `host`, `authorization`, `proxy-authorization`, `content-length`, `transfer-encoding`, `trailer`, `sec-websocket-key` or `sec-websocket-version`. A later hop would drop the field after the proxy checked it.
- Any `Transfer-Encoding` other than exactly `chunked`. The proxy decodes only chunked framing, so `gzip, chunked` would reach the upstream mislabeled.
- A `Trailer` declaration that names a protected field. Trailer frames arrive after the headers have gone upstream, so instead of rejecting, the proxy drops protected, hop-by-hop and routing fields from them.
- The proxy sets upstream framing itself (`Content-Length` or `chunked` on h1). Other hop-by-hop headers and `Proxy-Authorization` are never forwarded; `te: trailers` is kept on h2 for gRPC.

Source for the protected fields and the `Fastly-*` rule: [SPACE's routing_headers.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/tcp_proxy/routing_headers.rs).

**Limits per connection** (the same as [SPACE's tls_http.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/tcp_proxy/tls_http.rs)):

| Limit | Value |
|---|---|
| Request headers | ≤ 128, ≤ 32 KiB in total |
| Time to read the headers | 30 s |
| Concurrent h2 streams | ≤ 32 |
| Request body | `limits.max_inspected_body_mb` ([policy](../policy/)) |

**Per-request decision (built).** Each request, before injection, is decided again against the sandbox's current policy, the clock and the lease; a denied host gets 403 `egress_denied` (audited as `not_allowed`). So a push or a grant's expiry stops the next request on a held h1 or h2 connection.

**Final check before the headers leave (designed, not built).** The upstream connect and TLS handshake can take seconds, and a policy push, grant expiry, secret expiry or lease lapse can land meanwhile. Just before the request headers go upstream, after injection, the proxy checks again that the sandbox's current policy version still allows the host, the binding is still in that policy, its secret is current and unfenced, and the lease is valid. Otherwise: 403 with `policy_changed` (or `injection_unavailable`). See [SPACE's forward.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/tcp_proxy/tls_http/forward.rs).

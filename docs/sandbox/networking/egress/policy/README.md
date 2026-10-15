# Policy

Policy is layered and pushed by SandboxDO through nestd to nest-proxy. Changes apply live.

```yaml
base:        # image defaults
  allow: [registry.npmjs.org, pypi.org, files.pythonhosted.org, crates.io, static.crates.io,
          index.crates.io, github.com, "*.githubusercontent.com", deb.debian.org]
sandbox:     # set by whoever holds egress_policy on the sandbox (its owner, or me); forks inherit it
  allow: [api.stripe.com]
  inject: [github]   # needs a grant on the binding
  passthrough: []
  tcp: []      # e.g. ["db.example.com:5432"]
grants:
  allow: [{host: example.com, expires: 2h}]   # temporary
limits: {connections: 256, bandwidth_mbps: 200, max_inspected_body_mb: 512}
```

- **Agents can ask for more access.** A denial comes back as a 403 with a readable reason. The agent posts a question to its escalation channel; whoever holds `egress_policy` on the sandbox (its owner, a captain, or me in Discord) can approve, and the rule is added live, optionally with an expiry.
- **Inspected hosts can carry method and path rules** (e.g. `GET` only, or `/repos/me/*`), since the proxy already decrypts them. Vercel's sandbox firewall offers the same matchers ([docs](https://vercel.com/docs/vercel-sandbox/concepts/firewall)); its plain allow rules match SNI only, while nest-proxy also requires Host to equal SNI.
- **TCP exceptions** each get their own listener port. The proxy connects only to IPs its own resolver returned for that host, and passes the bytes through uninspected. There's no raw ssh by default.
- **Bandwidth** is shaped on the tap device. The other limits are enforced in the proxy.
- **Audit:** every connection or request is logged with sandbox, agent (if known), entry point (`via`), SNI/host, method, path (no query string), status, bytes, the decision, and the *name* of any binding used (never its value). Records are batched through nestd to the control plane and written to R2. Denials and alerts are also posted to the sandbox's `events` channel.
- **Deny and alert records are aggregated per sandbox,** so a guest can't flood nestd, the control plane or its subscribers:
  - one record per distinct `(host, port, reason)` per minute, at most 128 distinct ones per minute
  - one alert per distinct `(kind, host, binding)` per minute, at most 32 per minute
  - when a new minute starts, a summary record (host `*`, reason `suppressed: …`) reports what was dropped

  Allowed traffic isn't aggregated; it's bounded by the connection limit.
- **Reason values** in audit records include: `not_allowed`, `invalid_host`, `no_sni`, `not_tls`, `no_ca`, `dns_nxdomain`, `connection_limit`, `host_mismatch` (plaintext), `host_sni_mismatch` and `duplicate_host` (inspected TLS, alert), `sni_mismatch` (CONNECT authority ≠ SNI, alert), `non_tls_tunnel`, `placeholder_wrong_host`, `injection_unavailable`, `injection_requires_tls`, `trace_with_credential`, `tcp_exception_not_in_policy`, `tcp_exception`, `upgraded`, `suppressed: …`, plus `upstream: …` / `connect: …` / `resolve: …` errors.

## Open questions

- **Shared policies:** policy is per sandbox (an owner updates each of its sandboxes, and forks inherit). Named policies shared by many sandboxes would make one edit apply to all, at the cost of another object.

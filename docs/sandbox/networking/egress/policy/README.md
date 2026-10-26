# Policy

Policy is layered and pushed by SandboxDO through nestd to nest-proxy. Changes apply live, to open connections too.

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

## Hard deny

**Non-public addresses are refused before policy is consulted.** No allow rule, grant, TCP exception or IP-literal host can override this:
- loopback, private, link-local (including IMDS `169.254.169.254` and the ECS credentials endpoint `169.254.170.2`), CGNAT, `192.0.0.0/24`, documentation, benchmarking, multicast, reserved and unspecified
- unique-local IPv6 (including IPv6 IMDS `fd00:ec2::254`, [EC2 docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)), link-local and site-local IPv6, Teredo, discard-only
- IPv6 forms that embed an IPv4 address (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`, IPv4-mapped) are judged by the embedded address; local-use NAT64 `64:ff9b:1::/48` is always refused.

It applies to every upstream connect (inspect, passthrough, TCP exceptions) and to [DNS answers](../dns/). nest-proxy runs on the host, where IMDS and the instance role's credentials are reachable, so a kernel rule on the proxy's uid backs it up ([steering](../steering/#kernel-backstop)). nest's list is broader than SPACE's ([`PLATFORM_EGRESS_HARD_DENY_CIDRS`](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)).

**Test:** with `169.254.169.254` explicitly allowed (as a host, a grant and a TCP exception), and with an allowed name that resolves to it, every request still fails; on a real host it fails at the kernel rule too, with the proxy's own check disabled. SPACE has the same case ([08-guardrails.toml](https://github.com/perplexityai/space/blob/main/scripts/netgtw/traffic/cases/08-guardrails.toml)).

## Changes

- **Every policy carries a `version`** that increases per sandbox; the proxy ignores one that isn't newer. Designed, not built: the proxy acknowledges each one by `(sandbox, epoch, version, sha256)` before nestd boots or resumes the VM ([steering](../steering/)).
- **Open connections are re-checked.** Each connection records the policy version it was admitted under. When a new version arrives, or a grant expires (the proxy arms a timer for the earliest `expires`), the proxy re-evaluates every open connection of the sandbox and closes the ones the policy now denies (`policy_changed`):
  - h1 and h2 keep-alive connections (h2 gets `GOAWAY`), and upgraded WebSockets
  - passthrough splices, which are also closed when the host now requires inspection: opaque TLS can't become inspected on the same connection
  - TCP exceptions whose rule is gone
- **The DNS record is pruned** to names the new policy still allows ([dns](../dns/)).
- **The last check is per request:** just before request headers go upstream ([inspection](../inspection/)).
- **While a policy loads** (listeners installed, no acknowledged policy), new connections are held for up to 30 s, then denied with `policy_pending`. SPACE holds them for 31 s, its 30 s policy-load deadline plus 1 s ([state.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/state.rs)).

Sources for the re-check: [SPACE's state/egress.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/state/egress.rs) (`reconcile_policy`) and [egress/tcp.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/egress/tcp.rs) (`revalidate_tcp`).

## Rules

- **Agents can ask for more access.** A denial comes back as a 403 with a readable reason. The agent posts a question to its escalation channel; I, or an untainted holder of `egress_policy` on the sandbox (its owner or a captain), can approve, and the rule is added live, optionally with an expiry.
- **Inspected hosts can carry method and path rules** (e.g. `GET` only, or `/repos/me/*`), since the proxy already decrypts them. Vercel's sandbox firewall offers the same matchers ([docs](https://vercel.com/docs/vercel-sandbox/concepts/firewall)); its plain allow rules match SNI only, while nest-proxy also requires Host to equal SNI.
- **Passthrough is SNI-only.** The proxy can't see `Host` inside a spliced connection, so a passthrough host on a shared CDN allows fronting to anything on that CDN that accepts a `Host` different from the SNI. Use it only for pinned clients that need it.
- **TCP exceptions** each get their own listener port. The proxy connects only to IPs its own resolver returned for that host, and passes the bytes through uninspected. There's no raw ssh by default.
- **Bandwidth** is shaped on the tap device. The other limits are enforced in the proxy, alongside the proxy-wide fairness bounds ([tls](../tls/#shared-proxy-fairness), [inspection](../inspection/)).

**Policy is per sandbox:** forks inherit it, and an owner updates each of its sandboxes itself. There are no shared policy objects: the blast radius of an edit is one sandbox, and a loop over sandboxes is the agent's job.

## Audit

- **Every connection or request is logged** with sandbox, agent (if known), entry point (`via`), SNI/host, method, path (no query string), status, bytes, the decision, and the *name* of any binding used (never its value). Records are batched through nestd to the control plane and written to R2 per sandbox and day, kept 90 days ([data](../../../../data/)). Policy denials and alerts are also posted to the sandbox's `events` channel.
- **Deny and alert records are aggregated per sandbox,** so a guest can't flood nestd, the control plane or its subscribers:
  - one record per distinct `(host, port, reason)` per minute, at most 128 distinct ones per minute
  - one alert per distinct `(kind, host, binding)` per minute, at most 32 per minute
  - when a new minute starts, a summary record of kind `suppressed` (with the dropped deny and alert counts) reports what was dropped

  Allowed traffic isn't aggregated; it's bounded by the connection limit. The proxy is the one place that aggregates; nestd only rate-limits per sandbox.
- **Only a denial by policy** (`not_allowed`, `dns_nxdomain`, `tcp_exception_not_in_policy`) becomes an `egress_denied` event: someone can grant it. Protocol refusals, upstream failures, limits and summaries stay in the audit log.
- **Reason values** are a closed list, `EgressReason`, defined once in `nest-protocol` and mirrored in the control plane; the table is in [nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#audit-reason-values).

# egress-policy audit

Doc: docs/sandbox/networking/egress/policy/README.md

## Corrections

| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| policy:3 | Changes apply live, to open connections too | Each request is re-decided against the current policy; closing open connections (re-check) has no code | crates/nest-proxy/src/http.rs:369-375 (per-request `decide`); no `policy_changed` in crates/nest-proxy/src |
| policy:15 (YAML) | sandbox layer without `read_repos` | `SandboxPolicyLayer` has `read_repos` (and `github_push`) | control-plane/src/do/sandbox.ts:69-82 |
| policy:19 (YAML) | `limits: {connections: 256, bandwidth_mbps: 200, max_inspected_body_mb: 512}` | wire fields `max_connections`, `bandwidth_mbps`, `max_inspected_body_bytes`; always `DEFAULT_LIMITS`, no layer sets them | crates/nest-protocol/src/model.rs:390-394; control-plane/src/do/sandbox.ts:42,1190 |
| policy:26 | "A reader no longer has to subtract…" (tombstone wording) | reworded: "so a reader needn't subtract…" | n/a |
| policy:42 | Non-public addresses refused "before policy is consulted" | Refused at dial time, after the policy decision, whatever the policy says | crates/nest-proxy/src/http.rs:840-846, 140-152 |
| policy:47 | Hard deny applies to DNS answers; a kernel rule on the proxy's uid backs it up | DNS answers are not filtered (any resolved address is returned); no `skuid`/root-namespace nft rule exists in crates/ or deploy/. Both marked designed, not built | crates/nest-proxy/src/dns.rs:55-72; crates/nestd/src/net.rs:204-245 (netns ruleset only); `grep -r skuid` hits docs only |
| policy:49 | Test: 169.254.169.254 allowed as host/grant/TCP exception; kernel rule with proxy check disabled | Built only: `is_public` unit test and `private_upstream_addresses_are_refused` (allowed name resolving to loopback). Marked designed, naming what is built | crates/nest-proxy/src/http.rs:1131-1145; crates/nest-proxy/tests/egress.rs:129-136 |
| policy:61 | While a policy loads, connections held 30 s then `policy_pending` (unmarked) | Not built: no policy means max_connections 0, so `connection_limit` at once; DNS REFUSED | crates/nest-proxy/src/state.rs:331-339; listener.rs:92-95; dns.rs:46 |
| policy:72 | Bandwidth is shaped on the tap device | Nothing reads `bandwidth_mbps` (only test fixtures); no tc/rate limiter. Marked designed, not built; named the two enforced limits | crates/nest-proxy/src/http.rs:497; state.rs:333; `grep bandwidth_mbps crates/` |
| policy:148 | Reason list includes `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope`, `injection_upgrade` as emitted | None is emitted by nest-proxy; moved to "Designed, not emitted yet" (matches the nestd-proxy interface table) | grep of crates/nest-proxy/src: 0 hits each |

## Parent summary lines to update

- docs/sandbox/networking/egress/README.md:20 — current: "open connections: re-checked on every policy version and grant expiry; closed once denied" — suggested: "open connections: every request re-decided against the current policy; re-checking and closing open connections on a policy version or grant expiry is designed, not built".
- docs/sandbox/networking/egress/README.md:16 — "… → re-check policy → upstream …": the per-request policy decision is built (before the host check, http.rs:369); the "final re-check just before headers go upstream" is designed. Suggest "(designed)" after "re-check policy".
- docs/sandbox/networking/egress/README.md:25 — current: "**Non-public addresses are refused twice:** by the proxy before any policy applies, and by a kernel rule on the proxy's uid, since the proxy runs where IMDS is reachable" — suggested: "**Non-public addresses are refused** by the proxy on every upstream connect, whatever the policy allows; a kernel rule on the proxy's uid, since the proxy runs where IMDS is reachable, is designed, not built".

## Unconfirmed claims

- policy:22 — "no client rule allows what the operator's policy refuses" — compileEgress only drops client rules overlapping the operator's passthrough (do/sandbox.ts:1177); the operator layer has no deny rules, so the meaning is unclear. Left.
- policy:38 — what a client reads (never a secret reference or another client's binding) — `policy()` returns the full sourcedPolicy including operator bindings (no values); not traced through client auth.
- policy:68 — GraphQL exception details for operator bindings — readBindings' `taken` also covers an operator binding named `github` (control-plane/src/lib/rules/github.ts:120-127); consistent in effect, not exhaustively checked.
- policy:133/156 — where GitHub LFS upload URLs point (doc already says unverified).

## Suspected code bugs

- Kernel backstop absent: docs/sandbox/networking/egress/steering/README.md:34-41 describes an nft `output` rule on the proxy's uid (`meta skuid`) installed by nestd; no such rule exists in crates/nestd (net.rs installs only the netns ruleset). Compounded by nest-proxy running as root (deploy/host/install.sh:90-104, no User=), so a uid match would hit all of root's traffic. The parent logged the root issue; this confirms the rule itself is missing.
- DNS answers are not hard-denied (dns.rs:55-72): an allowed name resolving to 169.254.169.254 is answered to the guest. Connects still refuse it (http.rs:843), so the effect is information only; `dns_non_public` designed, not built.

## Drift outside the area

- docs/sandbox/networking/egress/steering/README.md:34-41 "Kernel backstop" is written as built; no code. Should be marked designed, not built.
- docs/interfaces/host-internal/nestd-proxy/README.md (reason table): `injection_unavailable` listed with verdict `deny`; nest-proxy audits it as `Alert` (crates/nest-proxy/src/http.rs:416).

## Docs with no drift (other claims confirmed)

- BASE_ALLOW list (sandbox.ts:44-47); `layer`/`source` values and routes (sandbox.ts:50-58,1143-1200; index.ts:795-845); hard-deny ranges incl. NAT64/6to4/IPv4-compatible/Teredo/site-local/discard-only (http.rs:861-909); not-newer version ignored (state.rs:285-293); per-request re-decision incl. passthrough-only (http.rs:369-375); egress_policy tool (ttl_s 60..86400 default 3600, maxItems 16, host regex without IP literals, revoke ungated: agent.ts:3611-3650,3920-3940; protocol/schemas/control/platform-tools.json:346-375); RequestGuard/RequestMatch fields (model.rs:396-454); guard body 64 KiB / 30 s / 3 decode rounds (http.rs:43,968-1003; guard.rs:21); guarded host never spliced or TCP (model.rs:491,506); repos regex, no wildcard or .git (lib/repos.ts); GitHub guard table, bindings and placeholders (lib/rules/github.ts); tests and fixtures named (tests/guards.rs, tests/github_rules.rs, test/repos.test.ts, protocol/fixtures/control/egress_policy/egress_policy.github*.json, e2e/run.py:1245 run_repos); audit aggregation 128/32 per 60 s plus summary (state.rs:34-39,240-270,404-410); audit fields, path without query (audit.rs); audit to R2 (fleet.ts:1396).

# egress-injection findings

Doc: docs/sandbox/networking/egress/injection/README.md

## Corrections

| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| injection/README.md:22-23 | yaml `methods`, `path_prefix` "optional" (as if available) | No such fields on the binding anywhere (Rust, TS, wire); annotated "designed, not built" | crates/nest-protocol/src/model.rs:346-352; control-plane/src/protocol/model.ts:150-155 |
| injection/README.md:29 | substitution only for the binding's own hosts, methods and path | Only hosts are checked; methods/path marked designed, not built | crates/nest-proxy/src/inject.rs:50-71 |
| injection/README.md:30 | `*.` refused unless `wildcard: true` (unqualified) | Enforced only for API clients' bindings (`ClientInjection`); the operator layer's `inject` is plain `InjectionBinding` (no `wildcard` field, `*.` accepted) and HostPattern matches wildcards | control-plane/src/lib/client-secrets.ts:90-93; control-plane/src/do/sandbox.ts:75; crates/nest-protocol/src/model.rs:286-293 |
| injection/README.md:31-35 (new line before) | `methods`, `path_prefix` safe paths, `injection_out_of_scope` 403 stated as behaviour | Not built: no method/path matching, no `injection_out_of_scope` anywhere in code; added a "Designed, not built" lead-in bullet | grep of crates/, control-plane/src/ (no hits); crates/nest-proxy/src/http.rs:408-424 |
| injection/README.md:37 | `header{name}` can't name reserved headers (all bindings) | Checked only for API clients' bindings (`RESERVED_HEADERS` + Fastly-* in client-secrets.ts); operator bindings unchecked | control-plane/src/lib/client-secrets.ts:65-70; control-plane/src/do/sandbox.ts:75 |
| injection/README.md:46 | substituted request can't upgrade: 403 `injection_upgrade` | Not built: h1 `Upgrade` forwarded regardless of substitution; no `injection_upgrade`; h2 server never enables extended CONNECT | crates/nest-proxy/src/http.rs:467-535; crates/nest-proxy/tests/egress.rs:339 |
| injection/README.md:50 | (only passthrough mentioned) | Added: plaintext HTTP placeholder refused 403 `credential_requires_tls` | crates/nest-proxy/src/inject.rs:59-61; crates/nest-proxy/src/http.rs:419-421 |

## Parent summary lines to update

- docs/README.md:178 — current: "...(built: exact hosts with opt-in wildcards; methods, path prefixes and the upgrade refusal are designed)". Suggested: "...(built: exact hosts, with opt-in wildcards for API clients' bindings; the operator's take `*.` unchecked; methods, path prefixes and the upgrade refusal are designed)".

## Unconfirmed claims

- injection/README.md:42 — "Built (2026-11-02)" date for API clients' bindings — code exists (client-secrets.ts, sandbox.ts pushSecrets, broker.ts clientInjectionRefs); date not checked against git history.
- injection/README.md:55 — "(2026-11-02)" date for unresolved-reference drop — behaviour confirmed (control-plane/src/do/fleet.ts:986-994), date not checked.
- injection/README.md:47 — never-indexed on h2: code sets `HeaderValue::set_sensitive(true)` (inject.rs:149-152); relies on hyper/h2 encoding sensitive values as never-indexed (h2 crate behaviour, not checked in-repo).

## Suspected code bugs

- Upgrade after substitution: doc's decision (no WebSocket upgrade once a credential was substituted, since masking only covers HTTP responses) is not enforced; an h1 Upgrade with a substituted credential is forwarded and the upgraded stream is spliced unmasked (crates/nest-proxy/src/http.rs:467-535). Marked not built in the doc; flagging as a security gap.
- Operator layer bindings: no `wildcard` opt-in and no reserved-header check (control-plane/src/do/sandbox.ts:75 uses bare `InjectionBinding`), so an operator binding can inject into `host`, `transfer-encoding`, `Fastly-*` etc. or onto `*.` hosts. Comment at control-plane/src/lib/client-secrets.ts:82 claims "`wildcard` (a `*.` host needs it, as the operator's do)" which is false for operator bindings.
- control-plane/src/lib/client-secrets.ts:61-63 comment says nest-proxy strips the routing overrides; nest-proxy has no such stripping (already logged per brief).

## Drift outside the area

- None new. docs/interfaces/README.md:66-67 and docs/interfaces/host-internal/nestd-proxy/README.md:103-104 describe `methods?`/`path_prefix?`/`wildcard?` and the two reasons as pending/designed (consistent). docs/sandbox/networking/egress/policy/README.md:148 reason list consistent with code.

## Docs with no drift

- Remaining sections of injection/README.md (API clients' bindings, response masking, TRACE/TRACK 405, secret key precedence `inject:<binding>:<sandbox>`/`:<workstream>`/`inject:<binding>`, `secrets_set` epoch-only check, fencing via lease + drop, alert binding names, GitHub token permissions `contents: write`+`pull_requests: write` / read `contents: read`+`metadata: read`, INJECT_REFRESH_BEFORE_MS = 15 min, `workflows: write` opt-in, guest `git-credential-nest` and `GITHUB_TOKEN=nest-ph-github`, reserved env names) match code: control-plane/src/do/sandbox.ts:260-265,1349-1430; control-plane/src/do/broker.ts:291-338,713-721; control-plane/src/lib/github.ts:24; control-plane/src/lib/rules/github.ts:27,108-119; images/guest/build.sh:83-85; control-plane/src/lib/sandbox-env.ts:27-36; crates/nest-proxy/src/http.rs:455-463,545-552; crates/nest-proxy/src/state.rs:312,393-395. All relative links/anchors resolve.

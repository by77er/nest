# Audit notes (scratch; becomes the PR body; deleted before the PR)

Base: origin/main 6bbf64f.

## Suspected code bugs (doc left unchanged)
- credentials L9 "Pushed with the policy hash": no policy hash on a secrets push. `InjectionSecret` is `{binding, value, expires_ms}` (crates/nest-protocol/src/model.rs:352-357); nestd forwards `SecretsUpdate` without one (crates/nestd/src/host.rs:1581-1584).
- credentials L9 "the proxy refuses one whose binding isn't in the installed policy": the proxy stores every pushed secret (crates/nest-proxy/src/control.rs:169-177, state.rs:312-315); one with no binding just goes unused (inject.rs:52,62). No refusal.
- credentials L9 "Every push and refusal is audited": operator static secret pushes (`inject:<binding>[:<scope>]`, broker.ts:289-303) have no audit record; only GitHub mints (broker.ts:443,946) and API clients' secrets (broker.ts:717) are audited; no refusal exists to audit.

## Corrections
- security/README L22: "audited by BrokerDO (not built)" -> partly built: GitHub mints/refusals (broker.ts:389-443, 875, 946, 1044), API clients' injected secrets (broker.ts:717), MCP OAuth (broker.ts:200, lib/mcp-auth.ts). Not built: operator secret pushes, binding mints (broker.ts:1163-1174 no audit).
- credentials L8: push token also gets `workflows: write` when asked (broker.ts:332-336).
- credentials L12: intermediate CA key also in nestd's root-only `<state_dir>/host-credentials.json` (crates/nestd/src/credentials.rs:5-6,109-113; docs/compute/provisioning/ L49).
- credentials L14: host token also persisted by nestd in that file, rewritten on rotation (credentials.rs:1-9,99-104).

## Confirmed (credentials L5-16)
- L5 setup token `claude_oauth_token[:<name>]` (protocol/control.ts:199-207), templates worker/captain (lib/spec.ts:221,230), FleetDO refuses agent_start to a non-brain host (fleet.ts:1596-1598).
- L6 github_app JSON validated at PUT /v1/admin/secrets/:secret (index.ts:614-624), narrowed tokens (github.ts:339-342), audited (broker.ts:441,945).
- L7 github_user refusal (broker.ts:643-646), never resolvable (broker.ts:1230).
- L8 keys `inject:${binding}:${sandbox}` (broker.ts:338), bindings github/github_read (rules/github.ts:26,33), github_tokens reuse 50 min (broker.ts:26-27), perms (github.ts:24,31), hosts (rules/github.ts:110).
- L10 http: secrets only via brokeredSecret (broker.ts:653-656), masking (agent.ts:3537,3541).
- L11 ECC_NIST_P256 (deploy/lean/Cell/Stack.lean:596), kms Sign (kms.ts:27-28, fleet.ts:827), root cert by FleetDO (fleet.ts:816-836).
- L12 7 days (fleet.ts:847), pathLen 0 (ca.ts:111), key on host (nestd enroll.rs:35-41), leaf <=24h (nest-proxy tls.rs:24,76).
- L13 Ed25519 rotating (identity.ts:21-25), identity_keys (broker.ts:185), Nest-Identity (identity.ts:14), jwks route (index.ts:669).
- L14 FleetDO issues at enrollment w/ identity proof (fleet.ts:580-588), rotated (fleet.ts:2053-2059), runner memory (runtime.rs:41); revocation counter not built (tokens.ts).
- L15 binding_key:<cell> (broker.ts:109,533), pushed over fleet channel (fleet.ts:2015-2018).
- L16 claims + 1h (sandbox.ts:1886-1888, protocol/gateway.ts:13), detach/epoch (nest-gateway verify.rs:115-124).

## Unconfirmed
- L5 "1 year, model requests only": property of Anthropic's token; no code.
- L11 "non-exportable", "CloudTrail logs each issuance": AWS properties.
- L9 "Per host and grant": lookup is per binding and sandbox/workstream/global (broker.ts:289-303); no per-host keying found.

## Outside drift
- docs/control-plane/durable-objects/broker/ L49/L53 say static secret pushes aren't audited and "Nothing else is audited yet", but API clients' secret injections are (broker.ts:717).

## TODO
- security/README (trust boundaries, defense layers), credentials L17-36, identity, model-access, fence map, manager leads.

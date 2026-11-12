# Audit notes (scratch; becomes the PR body; deleted before the PR)

Base: origin/main 6bbf64f.

## Suspected code bugs (doc left unchanged)
- README L20 "request sanitizing": per #251, routing-override stripping and request-smuggling checks are not in the code; nest-proxy strips hop-by-hop headers only (crates/nest-proxy/src/http.rs:45-53,693-706). Not re-verified beyond that.
- security/README L13 and L20, credentials L27, egress README L25, steering "Kernel backstop": "kernel rule on [nest-proxy's] uid" blocking IMDS and non-public addresses. No such rule exists: no `skuid` anywhere in crates/ or deploy/; nestd's nft ruleset (crates/nestd/src/net.rs:96-110) is the sandbox tap/netns one. And nest-proxy runs as root (deploy/host/install.sh:90-104: no `User=`), so a uid rule couldn't single it out from nestd. Only the proxy's own check remains (crates/nest-proxy/src/http.rs:859).
- credentials L9 "Pushed with the policy hash": no policy hash on a secrets push. `InjectionSecret` is `{binding, value, expires_ms}` (crates/nest-protocol/src/model.rs:352-357); nestd forwards `SecretsUpdate` without one (crates/nestd/src/host.rs:1581-1584).
- credentials L9 "the proxy refuses one whose binding isn't in the installed policy": the proxy stores every pushed secret (crates/nest-proxy/src/control.rs:169-177, state.rs:312-315); one with no binding just goes unused (inject.rs:52,62). No refusal.
- credentials L9 "Every push and refusal is audited": operator static secret pushes (`inject:<binding>[:<scope>]`, broker.ts:289-303) have no audit record; only GitHub mints (broker.ts:443,946) and API clients' secrets (broker.ts:717) are audited; no refusal exists to audit.

- identity L19 "only on each binding's exact hosts (and methods and path prefix, when set)": `InjectionBinding` has only name, hosts, placeholder, locations (crates/nest-protocol/src/model.rs:346-351); inject.rs:50-70 checks host and TLS only. No method or path scope. (Also reported by #251.)

## Corrections
- security/README L9: gVisor has no driver (crates/nestd/src/driver/: access, firecracker, process, supervise, tree) -> "gVisor, not built".
- security/README L15: control-plane role has `kms:Sign` and `kms:GetPublicKey` on the root key (deploy/lean/Cell/Stack.lean:380); credentials L28 already says so.
- security/README L22: "audited by BrokerDO (not built)" -> partly built: GitHub mints/refusals (broker.ts:389-443, 875, 946, 1044), API clients' injected secrets (broker.ts:717), MCP OAuth (broker.ts:200, lib/mcp-auth.ts). Not built: operator secret pushes, binding mints (broker.ts:1163-1174 no audit).
- credentials L8: push token also gets `workflows: write` when asked (broker.ts:332-336).
- credentials L12: intermediate CA key also in nestd's root-only `<state_dir>/host-credentials.json` (crates/nestd/src/credentials.rs:5-6,109-113; docs/compute/provisioning/ L49).
- credentials L14: host token also persisted by nestd in that file, rewritten on rotation (credentials.rs:1-9,99-104).

- credentials L20: `ADMIN_TOKEN` is compared as the token itself (control-plane/src/index.ts:95-98, timingSafeEqual against env.ADMIN_TOKEN), not a hash; doc's "not built" now says so.
- credentials L24: `CLOUDFLARE_API_TOKEN` is also used by `.github/workflows/deploy-projects.yml:38`.
- credentials L34: `cap:metrics` / `metrics_query` has no code (no `metrics_query` or `analytics_engine/sql` in control-plane/src); docs/control-plane/metrics/ L3 says not built -> row marked not built.

## Confirmed (credentials L17-33)
- L17 Worker secret put at deploy (dev/deploy-use1.sh:53-54, deploy.yml:119), daily sweep alarm (fleet.ts:279-280,1894-1899), tunnelConfig (lib/cloudflare.ts:27).
- L18 credentials file 0600 (nestd credentials.rs:53), TUNNEL_TOKEN env not argv (cloudflared.rs:7,258).
- L19 edge only for a tunnel target (sandbox.ts:1891-1895), access:gateway (broker.ts:613-625).
- L21 token format and SHA-256 (lib/clients.ts:295-311). L22 whsec_ (do/client.ts:679), Nest-Signature (lib/client-events.ts:92).
- L23 GET only (dashboard/src/worker.ts:96), RS256 Access JWT (dashboard/src/access.ts:65-80).
- L25 CLOUDFLARE_ACCESS_API_TOKEN in deploy.yml and deploy-projects-infra.yml.
- L26 nest-<cell>-deploy, OIDC sub repo:<repo>:environment: (Stack.lean:640-646).
- L28 IAM user nest-<cell>-control-plane (Stack.lean:602), nest=true tag condition (Stack.lean:376), kms (Stack.lean:380), AWS_CELL_CREDENTIALS (lib/cells.ts:6).
- L30 cap: never resolvable (broker.ts:1230), lib/mcp.ts:43. L31-32 oauth_grants/oauth_clients (lib/mcp-auth.ts:550,555), one refresh at a time (mcp-auth.ts:715-718), refused refresh -> markReauthorize (mcp-auth.ts:788), /v1/oauth/client.json auth none (index.ts:735).
- L33 api-loop: no code, marked deferred.

- identity L5: the guest image installs nest-guest, init, git-credential-nest and the proxy root CA (images/guest/build.sh:76-91) but no `nest` CLI (crates/nest-cli/README.md:3 says it should be) -> "not built into the image yet".
- identity L15: `BindingScope` has hands/pty/ingress (control-plane/src/protocol/gateway.ts:42) but SandboxDO mints only `hands` (sandbox.ts:1886-1888) and the gateway admits only `Hands` (crates/nest-gateway/src/verify.rs:97); docs/sandbox/gateway/ L24 lists /pty and /ingress as not built -> "only `hands` is built".

## Confirmed (identity)
- Proxy CA cert baked (images/guest/build.sh:87-91); guest re-checks epoch (crates/nest-guest/src/state.rs:85-126); NEST_AGENT_ID for attribution (crates/nest-cli/src/guest_cli.rs:1-3,18); agent epoch (control-plane/src/do/agent.ts:487-516); proxy substitutes only on binding hosts and TLS (crates/nest-proxy/src/inject.rs:50-70); jwks route auth none (index.ts:732); `nest token` absent from crates/nest-cli (deferred).

- model-access L11: "enforced server-side since early 2026" has no source: the linked legal page says only "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice" -> marked unverified (AGENTS.md Docs rule).
- model-access L18: the scheduler's concurrency cap is not built (docs/orchestration/scheduling/ L15); what exists is a per-brain-host cap, `max_brains_per_host`, enforced in FleetDO (control-plane/src/do/fleet.ts:1600-1606) -> "not built; today brain placement caps brains per brain host".

## Confirmed (model-access)
- Token only on brain hosts: FleetDO refuses agent_start to a non-brain host (fleet.ts:1596-1598); env only in Claude Code's (crates/nest-protocol/src/host.rs:1052).
- Launch: `-p --input-format stream-json --output-format stream-json --verbose --restricted --tools <no Bash/Read/Write/Edit> --strict-mcp-config --mcp-config --permission-mode dontAsk --permission-prompts none --allowedTools --disable-slash-commands --append-system-prompt-file|--system-prompt-file [--model] [--effort] --session-id|--resume [--fork-session]` (host.rs:994-1028, 1350-1356); env cleared (nest-runner agent.rs:250); managed settings forceLoginMethod claudeai, allowedProviders [anthropic], allowManagedHooksOnly, disableBypassPermissionsMode (protocol/claude-code/managed-settings.json).
- No nest-proxy on brain hosts (deploy/host/install.sh:110 "a brain host has none"); tls-interception fence.
- External: legal-and-compliance supports Allowed/Not allowed; authentication page: setup-token is one year and "can only make model requests" (also confirms credentials L5); agent-sdk/overview says third-party products use API keys.

## Confirmed (security/README)
- L11 brain: `--tools` lists no Bash/Read/Write/Edit (crates/nest-protocol/src/host.rs:1000,1351), `--restricted` (host.rs:999), env cleared (crates/nest-runner/src/agent.rs:250); host allowlist marked not built on main.
- L13 gateway as nest-gw, empty CapabilityBoundingSet, IPAddressAllow=localhost (deploy/host/install.sh:59-72,136-178); cloudflared as nest-cf (install.sh:55-56).
- L13/L14 S3: sandbox whole cell (Stack.lean:330-335), brain releases/* (Stack.lean:318-320).
- L15 control plane EC2 scoped (Stack.lean:357-377).

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

## Invariant-to-fence map (scripts/fences.toml unchanged)
| Invariant (where stated) | Fence | Code that enforces it |
|---|---|---|
| The subscription token never enters a VM (AGENTS.md; model-access L17; credentials L5; README L11, L13) | `subscription-token` (only broker.ts, agent.ts, protocol/control.ts, nest-protocol control.rs/host.rs, nestd runner_link.rs, nest-runner may name it); `guest-holds-no-credentials`; `gateway-holds-no-token` | FleetDO refuses `agent_start` to a non-brain host (control-plane/src/do/fleet.ts:1596-1598); only `claude_oauth_token*` resolves into agent_start (broker.ts:1203-1220) |
| Claude Code runs unmodified, with documented flags only (AGENTS.md; model-access L14-15) | `claude-launch` (only nest-runner spawns `claude`); `no-permission-bypass` | Args built in crates/nest-protocol/src/host.rs:994-1028; managed settings `disableBypassPermissionsMode` |
| No proxy decrypts OAuth traffic (AGENTS.md; model-access L16) | `tls-interception` (only nest-proxy terminates TLS) | No nest-proxy on brain hosts (deploy/host/install.sh:110). The fence doesn't stop nest-proxy itself from intercepting an Anthropic host; that rests on brain hosts not having one |
| Credentials never enter sandboxes: injected at the egress proxy (AGENTS.md; README L9, L19; identity L3-5, L19) | `guest-holds-no-credentials` covers only crates/nest-guest naming tokens; no fence on the image or on what reaches a VM | Placeholders in the image (control-plane/src/lib/rules/github.ts:28); substitution in crates/nest-proxy/src/inject.rs:50-70 |
| Gateway / hands path holds no model credential (README L12) | `gateway-holds-no-token` | crates/nest-gateway, crates/nest-hands-client |
| Agent logic lives only in the control plane (AGENTS.md) | none | — |
| Runner reaches a sandbox only through the seam (AGENTS.md; README L12) | none (`claude-launch` only fences who spawns `claude`) | FleetDO refuses brains on sandbox hosts (fleet.ts:1596-1598); binding check in crates/nest-gateway/src/verify.rs:97-124 |
| Nothing app-specific in the platform (AGENTS.md) | none | — |
| Non-public destinations hard-denied by proxy and kernel (README L13, L20; credentials L27) | none | Proxy: crates/nest-proxy/src/http.rs:859. Kernel: missing (see suspected bugs) |
| Every credential issuance, push and refusal audited (README L22; credentials L6, L9) | none | broker.ts `auditMint` (broker.ts:1150) |
| Host roles / control plane hold no S3 for the control plane, cell-scoped KMS (README L13-15; credentials L27-28, L36) | none (IAM in deploy/lean/Cell/Stack.lean, proved there, not by fences) | Stack.lean:318-380 |
| DO schema expand-only, metrics vocabulary, nestd-core purity | `do-schema-expand-only`, `metrics-vocabulary`, `nestd-core-purity` | not stated in docs/security/ |

## Unconfirmed
- model-access L15 "Only documented flags": the CLI reference page (https://code.claude.com/docs/en/cli-reference) was too large to read through the fetch tool and curl from the sandbox got 403; flags listed above not each checked against it. `--restricted` and `--permission-prompts` in particular.
- credentials L29 "no R2 S3 credentials exist", hosts use Worker-signed URLs only: blob signing found (lib/tokens.ts:77); absence of R2 keys not provable from code.
- L11 "non-exportable", "CloudTrail logs each issuance": AWS properties.
- L9 "Per host and grant": lookup is per binding and sandbox/workstream/global (broker.ts:289-303); no per-host keying found.

## Outside drift
- docs/architecture/README.md L60 (Guest agent: "the in-sandbox `nest` CLI") and crates/nest-cli/README.md:3 ("installed ... in guest images"): images/guest/build.sh installs no `nest` binary. Map / sandbox areas.
- docs/sandbox/networking/egress/injection/ and steering/ still describe method/path scope and the kernel backstop; per #251 those are now marked designed; not re-checked here.
- docs/control-plane/durable-objects/broker/ L49 "Not built: ... the audit of static secret pushes" vs L53 "Also audited: an API client's secret push": consistent once read as operator pushes; worth one wording pass by the broker owner.
- docs/control-plane/durable-objects/broker/ L49/L53 say static secret pushes aren't audited and "Nothing else is audited yet", but API clients' secret injections are (broker.ts:717).

## TODO
- security/README (trust boundaries, defense layers), credentials L17-36, identity, model-access, fence map, manager leads.

# Policy

Policy is layered and pushed by SandboxDO through nestd to nest-proxy. Changes apply live: every request, on an open connection too, is decided against the current policy (closing open connections the policy now denies is designed, not built: [changes](#changes)).

```yaml
base:        # image defaults
  allow: [registry.npmjs.org, pypi.org, files.pythonhosted.org, crates.io, static.crates.io,
          index.crates.io, github.com, "*.githubusercontent.com", deb.debian.org]
sandbox:     # the operator's (designed: also the sandbox's owner); forks inherit it
  allow: [api.stripe.com]
  inject: [stripe]   # needs a grant on the binding
  passthrough: []
  tcp: []      # e.g. ["db.example.com:5432"]
  repos: [by77er/nest]   # the push allowlist: the GitHub constructor turns it into guards, a binding, a token
  read_repos: []         # repos it may only read
  guards: []   # request guards written by hand, layered with the constructed ones
grants:
  allow: [{host: example.com, expires: 2h}]   # temporary
limits: {max_connections: 256, bandwidth_mbps: 200, max_inspected_body_bytes: 512 MiB}   # fixed defaults; no layer sets them
```

**Built:** the `sandbox` layer is the operator's (`POST /v1/sandboxes {policy}`, `PUT /v1/sandboxes/:id/policy`), and its rules reach hosts tagged `layer: workstream`, the layer's wire name, which hosts parse as a closed enum ([pending contract changes](../../../../interfaces/README.md#pending-contract-changes)); grants are tagged `sandbox`. **API clients' rules** (built 2026-11-02, [egress](../../../../control-plane/api/clients/#egress)) join the same layer on the wire: allow rules only, within the client's grant's `egress_hosts`, from its templates (while their agents are attached), its sandbox specs and the sandbox's client layer. Allow rules only add, so the guards below and the hard deny apply to whatever they open, and no client rule allows what the operator's policy refuses.

## Sources

**Decided (2026-11-03):** the effective policy the API shows (`GET /v1/sandboxes/<id>/policy`, and the answers of `PUT …/policy` and `PUT …/client-policy`) marks each allow rule with its `source`, so a reader needn't subtract one layer from another to tell them apart.

| `source` | What it is |
|---|---|
| `base` | nest's built-in defaults (the image's allowlist) |
| `operator` | the operator's policy layer |
| `repos` | rules the GitHub constructor derives from the push and read allowlists |
| `client` | the sandbox's API client's own rules: its client layer, its sandbox spec, and its attached agents' specs |
| `grant` | temporary grants (an approved `egress_policy`, or `POST …/grants`), with `expires_ms` |

- **`layer` stays beside it for one release:** the wire's value (`base`, `workstream` for every rule that is neither base nor a grant, `sandbox` for grants). Readers move to `source`; `layer` leaves the API view in the release after.
- **`source` never reaches a host:** the policy nest-proxy gets (`policy_update`, `sandbox_create`) is unchanged, its rules tagged only with the closed `layer` enum hosts parse. So there is no wire change and no fixture.
- **What a client reads** of its sandbox: the operator's rules, the constructed ones, its own marked `client`, and its own bindings with their placeholders. Never a secret, a secret reference, or another client's binding.

## Hard deny

**Non-public addresses are refused whatever the policy says:** the proxy checks every address it is about to dial. No allow rule, grant, TCP exception or IP-literal host can override this:
- loopback, private, link-local (including IMDS `169.254.169.254` and the ECS credentials endpoint `169.254.170.2`), CGNAT, `192.0.0.0/24`, documentation, benchmarking, multicast, reserved and unspecified
- unique-local IPv6 (including IPv6 IMDS `fd00:ec2::254`, [EC2 docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html)), link-local and site-local IPv6, Teredo, discard-only
- IPv6 forms that embed an IPv4 address (NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`, IPv4-mapped) are judged by the embedded address; local-use NAT64 `64:ff9b:1::/48` is always refused.

It applies to every upstream connect (inspect, passthrough, TCP exceptions; `is_public` in `crates/nest-proxy/src/http.rs`). Filtering [DNS answers](../dns/) by it is designed, not built: the proxy's DNS answers an allowed name with whatever addresses it resolves to. nest-proxy runs on the host, where IMDS and the instance role's credentials are reachable, so a kernel rule on the proxy's uid is to back it up ([steering](../steering/#kernel-backstop)); designed, not built. nest's list is broader than SPACE's ([`PLATFORM_EGRESS_HARD_DENY_CIDRS`](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)).

**Test** (designed; built: the `is_public` unit test and `private_upstream_addresses_are_refused` in `tests/egress.rs`, an allowed name resolving to loopback): with `169.254.169.254` explicitly allowed (as a host, a grant and a TCP exception), and with an allowed name that resolves to it, every request still fails; on a real host it fails at the kernel rule too, with the proxy's own check disabled. SPACE has the same case ([08-guardrails.toml](https://github.com/perplexityai/space/blob/main/scripts/netgtw/traffic/cases/08-guardrails.toml)).

## Changes

- **Every policy carries a `version`** that increases per sandbox; the proxy ignores one that isn't newer. Designed, not built: the proxy acknowledges each one by `(sandbox, epoch, version, sha256)` before nestd boots or resumes the VM ([steering](../steering/)).
- **Every request is decided again** against the current policy and clock (built): a request on an inspected or plaintext connection whose host a push revoked, or whose grant expired, gets 403 `egress_denied` (audited as `not_allowed`), and so does an inspected one whose host became passthrough-only.
- **Open connections are re-checked** (designed, not built). Each connection records the policy version it was admitted under. When a new version arrives, or a grant expires (the proxy arms a timer for the earliest `expires`), the proxy re-evaluates every open connection of the sandbox and closes the ones the policy now denies (`policy_changed`):
  - h1 and h2 keep-alive connections (h2 gets `GOAWAY`), and upgraded WebSockets
  - passthrough splices, which are also closed when the host now requires inspection: opaque TLS can't become inspected on the same connection
  - TCP exceptions whose rule is gone
- **The DNS record is pruned** to names the new policy still allows ([dns](../dns/)). Designed, not built.
- **A final check runs just before request headers go upstream** ([inspection](../inspection/)). Designed, not built.
- **While a policy loads** (listeners installed, no acknowledged policy), new connections are held for up to 30 s, then denied with `policy_pending`. Designed, not built. Today a sandbox without a policy has a connection limit of 0, so its connections are refused at once (`connection_limit`) and its DNS queries get REFUSED. SPACE holds them for 31 s, its 30 s policy-load deadline plus 1 s ([state.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/state.rs)).

Sources for the re-check: [SPACE's state/egress.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/state/egress.rs) (`reconcile_policy`) and [egress/tcp.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/egress/tcp.rs) (`revalidate_tcp`).

## Rules

- **Agents can ask for more access.** A denial comes back as a 403 with a readable reason. The agent asks for it (`egress_policy`, a sink); I, or an untainted holder of `egress_policy` on the sandbox (its owner), can approve, and the rule is added live, optionally with an expiry.
- **Built: `egress_policy` on the agent's own bound sandbox** (the `egress` capability). No arguments: the effective policy. `allow: [{host, ports?}]` with `ttl_s` (60 s to 24 h, default 1 h) adds expiring grants (the `grants` layer, one policy version per call, ids derived from the call key so a re-run adds nothing). Widening is a [sink](../../../../agents/tools/#taint-and-sinks): from a tainted session it waits for my approval of that exact request (always `approve`; any agent with hands is tainted, so in practice every widening). `revoke: [host]` drops that host's temporary grants and is never gated. Hosts are DNS names or `*.` and one, lowercased; no IP literals. Approving an untainted holder's answer, method and path rules, and the `sandbox` layer by an owner (only the operator's `PUT /v1/sandboxes/:id/policy` sets it) aren't built.
- **Inspected hosts can carry method and path rules** (e.g. `GET` only, or `/repos/me/*`), since the proxy already decrypts them. Vercel's sandbox firewall offers the same matchers ([docs](https://vercel.com/docs/vercel-sandbox/concepts/firewall)); its plain allow rules match SNI only, while nest-proxy also requires Host to equal SNI.
- **Passthrough is SNI-only.** The proxy can't see `Host` inside a spliced connection, so a passthrough host on a shared CDN allows fronting to anything on that CDN that accepts a `Host` different from the SNI. Use it only for pinned clients that need it.
- **TCP exceptions** each get their own listener port. The proxy connects only to IPs its own resolver returned for that host, and passes the bytes through uninspected. There's no raw ssh by default.
- **Bandwidth** is to be shaped on the tap device (designed, not built: nothing reads `bandwidth_mbps`). The other limits are enforced in the proxy (`max_connections` per sandbox, `max_inspected_body_bytes` per request body), alongside the proxy-wide fairness bounds ([tls](../tls/#shared-proxy-fairness), [inspection](../inspection/)).

**Policy is per sandbox:** forks inherit it, and an owner updates each of its sandboxes itself. There are no shared policy objects: the blast radius of an edit is one sandbox, and a loop over sandboxes is the agent's job.

## Request guards

**Built.** A request guard is a generic rule nest-proxy evaluates on every inspected or plaintext request, after credential injection and before anything goes upstream (`crates/nest-proxy/src/guard.rs`; the wire type is `RequestGuard` in [models](../../../../interfaces/control-host/models/)):

```yaml
- name: store-write          # 403 {"error": "request_denied", "guard": name, "reason"}; audited as `guard: <name>`
  hosts: [files.example.com]
  scope: [{methods_except: [GET, HEAD]}]        # what it covers: any matcher
  allow:                                        # exceptions inside the scope: any matcher
    - {path: /store/mine/**}
    - {methods: [POST], path: /batch, body_json: {pointer: /op, values: [read]}}
    - {methods: [POST], path: /query, injected: svc}   # only with the proxy's own credential for binding `svc`
  ignore_case: true
```

- **A matcher** is `methods`, `methods_except`, `path` (segments: a literal, `*` for one segment, `**` for any number), `query` (`[{name, values}]`), `body_json` (`{pointer, values}`, RFC 6901) and `injected` (the binding whose credential the proxy substituted). Every field given must match.
- **Every guard must let a request through.** Guards only take away, so layers compose by intersection and no layer can undo another's guard.
- **Scopes err towards refusing; exceptions towards not matching.** A scope matches the path as sent *or* decoded and normalized (percent-decoding up to three rounds, `\` as `/`, `;params` cut, empty and dot segments applied), and query names and values decoded. An exception matches only a clean path as sent ([injection](../injection/#scope)'s safe-path rules, plus no segment that decodes to a dot segment), compared as sent, so an encoded or `;`-suffixed name never equals a literal. A body the proxy can't read (encoded, over 64 KiB, slower than 30 s, not JSON, or the field missing) is in a `body_json` scope and never a `body_json` exception. The body is read only when a matcher on the request's host needs it, then replayed to the upstream whole.
- **A guarded host is always inspected:** never spliced (a passthrough entry for it is ignored) and never a TCP exception, so no layer can route around a guard.
- **Decided (2026-11-01, the owner): rules are built by constructors that sit apart from the evaluator.** The proxy knows hosts, methods, paths, queries, one body field and bindings, never a service. What a service's rules mean is a constructor's: a pure function in the control plane (`control-plane/src/lib/rules/`) that turns an intent into generic guards, layered into the policy like any operator-written rule. **Why:** another git host or a registry's publish endpoint is a new constructor, with no change to the proxy; an operator can write the same rules by hand and get the same enforcement; and the evaluator is tested with made-up rules, the constructors from intent to rules, and one seam test through both ([testing](#tests)).

## Repo allowlists

**Built.** A sandbox may push only to repos explicitly on its **push allowlist**, enforced by nest-proxy whatever credential a push carries, so a prompt-injected agent can't push to an attacker's repo with the attacker's own token.

- **What it is:** exact `owner/name` names, compared without case (`control-plane/src/lib/repos.ts`). **No `owner/*`:** a wildcard covers repos created later, forks an agent made included, and can't narrow a token (GitHub's token request names repos). No name ending in `.git` (git's URL suffix). Default: none, so no push anywhere.
- **Where it comes from:** the sandbox layer's `repos` (`POST /v1/sandboxes {policy}`, `PUT /v1/sandboxes/:id/policy`), plus the `repos` of every agent attached to the sandbox while attached (its spec's: the template's, replaced by the operator's `overrides.repos`). Everything in a sandbox shares a trust domain, so its agents share the union. A spawner (`agent_spawn`, or an [API client](../../../../control-plane/api/clients/#clients-and-grants)) may only narrow it (`SpawnerOverrides.repos`): to a subset of the template's, not of its own, because the spawn grant on the template is the operator's authorization for what it gives. An operator-approved [`github.fork`](../../../../agents/capabilities/brokered/#forks) adds the fork to the forking agent's part. Forks of a sandbox inherit the layer (the control plane doesn't fork yet).
- **Read access** to public repos is unchanged. Private repos are readable only with the sandbox's tokens, which cover only its allowed and [read-only](#read-only-repos) repos.
- **What it builds,** through the GitHub constructor (`lib/rules/github.ts`, [below](#github)): the guards always, and with any repo `api.github.com` in the allow list and the `github` [injection binding](../injection/#github) whose token BrokerDO mints for exactly those repos ([BrokerDO](../../../../control-plane/durable-objects/broker/#injection-minting)).

## Read-only repos

**Built (2026-11-02).** A sandbox may also have repos it may **only read** (`read_repos`): private repos its agents fetch but never push to (an agent reviewing a pull request, say), so it holds no write it doesn't need.

- **What it is:** a second list of exact `owner/name` names, as the allowlist. A repo on both lists is on the allowlist (push implies read), so the read-only repos are the read list less the allowlist (`readOnlyRepos` in `lib/repos.ts`).
- **Where it comes from,** exactly as the allowlist: the sandbox layer's `read_repos`, plus each attached agent's while attached (its spec's: the template's `read_repos`, replaced by the operator's `overrides.read_repos`, narrowed by a spawner or an [API client](../../../../control-plane/api/clients/#clients-and-grants), each only to the template's read-only repos or its allowlist). A spawner can move a repo from the allowlist to the read list (less access), never the other way; a spawner narrowing the allowlist to none drops the unscoped GitHub grants it would have scoped, which would otherwise reach every repo. An override replacing or narrowing the allowlist leaves the template's read-only repos readable, those it also listed in `repos` included. They scope no [brokered action](../../../../agents/capabilities/brokered/#repo-allowlists): those write.
- **A second token, not one token for both lists.** An installation token's permissions apply to every repo it names ([GitHub](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)), so one token for both would let the read-only repos be written through GraphQL, which the guards let through with the sandbox's own token. So BrokerDO mints the allowlist's token as before (`contents: write`, `pull_requests: write`) and a read-only one for exactly the read-only repos (`contents: read`, `metadata: read`: `SANDBOX_READ_TOKEN_PERMISSIONS`).
- **Three bindings:** `github` (`nest-ph-github`, the guest image's default) carries the push token, only with an allowlist, as before. `github_read` (`nest-ph-read-github`) always carries the read-only token. With no allowlist, `github_read_default` carries it too, under the default placeholder, so a read-only sandbox needs nothing in the guest. **Why not `github` for that:** a token change and a policy change reach nest-proxy as two commands. SandboxDO sends the secrets first, so a push token for repos that just became read-only is gone before the policy that makes them so (a new token under the old policy is held to the old guards and GitHub's own scope; if the secrets can't be read, the proxy's set is emptied instead). Under its own name the read-only token also never shares a binding, or a GraphQL exception, with a push token the proxy might still hold. With both lists, a read-only repo is fetched with the read-only placeholder (`git clone https://x-access-token:nest-ph-read-github@github.com/<repo>`, `GH_TOKEN=nest-ph-read-github gh …`); the default one's token doesn't cover it.
- **Why not route by repo in nest-proxy:** a binding chosen by path would be a new wire field old proxies ignore, and still couldn't route GraphQL (no repo in its path). With two bindings nest-proxy is unchanged: it substitutes whichever placeholder a request carries, and each token's scope is GitHub's to enforce. The read-only placeholder doesn't contain the default one, since nest-proxy looks for a placeholder as a substring before it substitutes an exact match.
- **The guards** name the read-only repos in their reasons and give them no exception: pushes and REST writes to them are refused whatever credential a request carries ([GitHub](#github)); fetches stay open, as for every repo. GraphQL is let through with the read-only bindings only when nest mints their token (it can't write): an operator's own binding named `github_read` or `github_read_default`, or one taking the default placeholder, gets no exception from read-only repos (no `github_read_default` is made beside it), and `github` keeps today's rule (an exception only with an allowlist). So an operator's own `github` credential beside an allowlist can write through GraphQL wherever that credential reaches, read-only repos included: an operator who wants them read-only gives that binding a credential that can't write them. A push token nest minted earlier is forgotten whenever none is minted, before the operator's static secret is looked up, so the operator's binding never resolves to it.
- **Old sandboxes and specs** have none: a stored layer, spec or grant without `read_repos` reads as an empty list, and a sandbox without read-only repos gets exactly the rules, binding and token it did before.

## GitHub

The constructor's guards (`githubGuards`), each with `ignore_case`:

| Guard | Hosts | Refuses | Except |
|---|---|---|---|
| `github-push` | `github.com` | `/**/git-receive-pack`, and its discovery `/**/info/refs?service=git-receive-pack` ([git smart HTTP](https://git-scm.com/docs/http-protocol)) | `/<repo>/**`, `/<repo>.git/**` |
| `github-write` | `github.com` | every method but `GET`/`HEAD`: web forms (someone's cookie), LFS uploads and locks | `POST /**/git-upload-pack` (a fetch is a POST); `POST /**/info/lfs/objects/batch` with `operation: download` ([LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)); the allowed repos |
| `github-api-write` | `*.github.com` (api, uploads, www, …) | every method but `GET`/`HEAD` | `/repos/<repo>/**`; `POST /graphql` only with the sandbox's own tokens (`github` with an allowlist; `github_read` and `github_read_default` when nest mints them) |
| `gist-write` | `gist.github.com` | writes and push discovery (each gist is a git repo) | none |
| `githubusercontent-write` | `*.githubusercontent.com` | writes (signed upload URLs) | none |

- **GraphQL decided:** one POST endpoint whose target isn't in the path, so the guard can't scope it by repo. It is let through only with the proxy's own substituted credential (`injected: github`), which is minted for the allowed repos only, so GitHub's own scoping confines its writes; any other credential, or none, is refused. Refusing all mutations would need a GraphQL parser in the proxy and break `gh pr create`.
- **Redirects:** the proxy never follows them; each hop is a new request, checked again. A renamed allowed repo that redirects elsewhere is refused at the new name until that is allowed.
- **Other git hosts and ssh: out of scope, and closed by default.** Only GitHub has a constructor. Another forge is reachable only after its host is allowed (an approved widening); its pushes are then not guarded until a constructor exists for it (an open question). Raw ssh has no route: base ports are 80 and 443, `:443` must be TLS with SNI, and a guarded host can't be a TCP exception.
- **LFS uploads to an allowed repo** go where GitHub's batch answer points. If that is a `*.githubusercontent.com` host, the content-host guard refuses them (unverified where GitHub's upload URLs point).

### Tests

The evaluator with made-up hosts (`guard.rs` unit tests, `tests/guards.rs` through the real proxy: refusals before the upstream, body replay, the injected-credential exception, passthrough and TCP); the constructor from allowlist to rules (`test/repos.test.ts`); the seam: the constructor's output for two repos is the fixture `egress_policy.github.json`, and with a read-only repo `egress_policy.github_read.json`, which a vitest asserts the constructor still produces and `tests/github_rules.rs` evaluates against GitHub's real request shapes; and the e2e harness's `run_repos` (a refused `git push` and receive-pack, an allowed discovery reaching GitHub, the audit record).

## Audit

- **Every connection or request is logged** with sandbox, agent (if known), entry point (`via`), SNI/host, method, path (no query string), status, bytes, the decision, and the *name* of any binding used (never its value). Records are batched through nestd to the control plane and written to R2.
- **Deny and alert records are aggregated per sandbox,** so a guest can't flood nestd or the control plane:
  - one record per distinct `(host, port, reason)` per minute, at most 128 distinct ones per minute
  - one alert per distinct `(kind, host, binding)` per minute, at most 32 per minute
  - when a new minute starts, a summary record (host `*`, reason `suppressed: …`) reports what was dropped

  Allowed traffic isn't aggregated; it's bounded by the connection limit.
- **Reason values** in audit records include: `not_allowed`, `invalid_host`, `no_sni`, `not_tls`, `no_ca`, `dns_nxdomain`, `connection_limit`, `host_mismatch` (plaintext), `host_sni_mismatch` and `duplicate_host` (inspected TLS, alert), `sni_mismatch` (CONNECT authority ≠ SNI, alert), `non_tls_tunnel`, `placeholder_wrong_host`, `injection_unavailable`, `injection_requires_tls`, `trace_with_credential`, `tcp_exception_not_in_policy`, `tcp_exception`, `upgraded`, `guard: <name>`, `suppressed: …`, plus `upstream: …` / `connect: …` / `resolve: …` errors. Designed, not emitted yet: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope`, `injection_upgrade`. The wire list is in [nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#audit-reason-values).

## Open questions

- **Other forges:** a push to another git host is possible once its host is allowed (an approved widening) and unguarded until it has a constructor.
- **Publishing as exfiltration:** an allowed package registry takes uploads with someone else's token (`npm publish`, PyPI uploads). A constructor for registries' publish endpoints is the next candidate.
- **GraphQL** writes rest on GitHub applying the installation token's repo scope to GraphQL mutations (unverified). Refusing mutations outright needs a GraphQL parser in the proxy.
- **Ref-aware pushes:** the guards see a push's repo, never its refs or whether it's a fast-forward, so a sandbox that may push a repo may push or force-push every branch the repo doesn't protect. Apps whose agents force-push their own branches as routine (the projects app's workers rebase theirs: [PR upkeep](../../../../../projects/README.md#pr-upkeep)) rely on prompts to stay on them. A generic fix: a push allowlist naming refs (`owner/name:refs/heads/task/*`), checked against the ref updates in receive-pack's request, which the proxy would have to parse.
- **LFS uploads** to an allowed repo: where GitHub's batch answer points them is unverified; if at `*.githubusercontent.com`, the content-host guard refuses them.

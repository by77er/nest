# Policy

Policy is layered and pushed by SandboxDO through nestd to nest-proxy. Changes apply live: every request, on an open connection too, is decided against the current policy (closing open connections the policy now denies is designed, not built: [changes](#changes)).

```yaml
base:        # the cell's, operator data (seeded with these); every sandbox of the cell
  allow: [registry.npmjs.org, pypi.org, files.pythonhosted.org, crates.io, static.crates.io,
          index.crates.io, github.com, "*.githubusercontent.com", deb.debian.org]
  guards: []
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

**Built:** the `sandbox` layer is the operator's (`POST /v1/sandboxes {policy}`, `PUT /v1/sandboxes/:id/policy`), and its rules reach hosts tagged `layer: workstream`, the layer's wire name, which hosts parse as a closed enum ([pending contract changes](../../../../interfaces/README.md#pending-contract-changes)); grants are tagged `sandbox`. **API clients' rules** (built 2026-11-02, [egress](../../../../control-plane/api/clients/#egress)) join the same layer on the wire: allow rules only, within the client's grant's `egress_hosts`, from its templates (while their agents are attached), its sandbox specs and the sandbox's client layer. Allow rules only add, so the guards below and the hard deny apply to whatever they open, and no client rule allows what the operator's policy refuses. **API clients' [request guards](#client-guards)** (built 2026-11-12) come from the same places and only refuse.

## Base layer

**Decided (2026-11-12, [principle 10](../../../../README.md#principles)): the base layer is operator data, one per cell.** It used to be a list built into the control plane.
- **`GET /v1/admin/egress/base?cell=<cell>`** answers `{allow, guards, version, pending}`: `version` 0 is the seed, never written, and `pending` is how many live sandboxes of the cell haven't taken the latest version yet.
- **`PUT /v1/admin/egress/base?cell=<cell>`** with `{"allow": [{"host", "ports"?}], "guards"?: [RequestGuard]}` replaces it whole as the next version. It is checked with the operator layer's own allow and [guard](#request-guards) schemas (a rule's host non-empty, ports 1-65535, at most 64 guards); `allow` is required and an unknown field is refused (400), so a typo can't empty it. Admin only.
- **The seed** is the list nest had built in, on ports 80 and 443, with no guards: nothing changes until the operator edits it. Trimming it, with apps adding their own hosts in their client layers, is the operator's later step.
- **Its rules reach hosts tagged `layer: base`** and show as `source: base` ([sources](#sources)). Its guards join every guard of the sandbox's policy (each must let a request through), ahead of the constructed and operator ones. They are the operator's, as the operator layer's are: never named `client:` (the operator layer's schema refuses that), so they count against no sandbox's [client guard](../../../../control-plane/api/clients/#request-guards) limit and don't keep a sandbox off a host whose nest-proxy doesn't bound client guards. Unlike a client's guards, they aren't dropped for a host an operator layer passes through or routes as a TCP exception: a cell-wide base guard on such a host forces it to be inspected or refuses it, the operator's base overriding the operator's own layer.
- **Stored once per cell, in FleetDO** (kv `egress_base`). Why FleetDO and per cell:
  - FleetDO already holds the cell's sandbox registry, which a change walks. A global store would have to enumerate cells, which nest doesn't list (`CELLS` is optional).
  - A cell is the unit of rollout and failure: a change can be tried on one cell first, and a cell elsewhere may need other mirrors.
  - The cost is one `PUT` per cell; there is one cell today.
- **A change reaches every live sandbox of the cell:**
  1. The write queues one notice per live sandbox in the registry (`egress_base_notices`), in the same step.
  2. FleetDO's alarm tells at most 50 a run, each call bounded at 10 s, and runs again at once while more are due. A sandbox that doesn't answer is told again after 2 s, doubling, at most every 10 minutes, until it answers. A notice goes only on its own version's answer, so a newer write's notice stays.
  3. SandboxDO holds the newer version (versions only grow; kv `egress_base`) and, whenever the version it holds is at least the one told (a retried create may have taken it from `registerSandbox` already), sends a new policy version through `policyChanged` from its own alarm (`egress_base`), so the fan-out never waits on a command back into FleetDO.
  4. A sandbox created later gets the layer in `registerSandbox`'s answer, read in the step that registers it; a write after that finds it registered and tells it.
- **Rollback:** a previous release ignores the stored layer and uses its constant (today's list), in FleetDO and SandboxDO alike ([rollout](../../../../../dev/rollout/2026-11-12-egress-base-layer.md)).

## Sources

**Decided (2026-11-03):** the effective policy the API shows (`GET /v1/sandboxes/<id>/policy`, and the answers of `PUT …/policy` and `PUT …/client-policy`) marks each allow rule with its `source`, so a reader needn't subtract one layer from another to tell them apart.

| `source` | What it is |
|---|---|
| `base` | the cell's [base layer](#base-layer) (operator data, seeded with nest's former built-in list) |
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
    - {methods: [POST], path: /upload, injected: "*", at: authorization}  # only when Authorization is nest's, any binding's
  ignore_case: true
```

- **A matcher** is `methods`, `methods_except`, `path` (segments: a literal, `*` for one segment, `**` for any number), `query` (`[{name, values}]`), `body_json` (`{pointer, values}`, RFC 6901) `injected` (the binding whose credential the proxy substituted, or `*` for any binding's) and `at` (the header that substitution must have written whole): [below](#any-injected-credential). Every field given must match.
- **Every guard must let a request through.** Guards only take away, so layers compose by intersection and no layer can undo another's guard.
- **Scopes err towards refusing; exceptions towards not matching.** A scope matches the path as sent *or* decoded and normalized (percent-decoding up to three rounds, `\` as `/`, `;params` cut, empty and dot segments applied), and query names and values decoded. An exception matches only a clean path as sent ([injection](../injection/#scope)'s safe-path rules, plus no segment that decodes to a dot segment), compared as sent, so an encoded or `;`-suffixed name never equals a literal. A segment that holds `/` or `\` once decoded (`%2F`, `%5C`) matches only under `**`, never as a `*` or a literal (built 2026-11-14): a server that decodes it reads more segments there than the pattern saw, while an API's encoded parameter under `**` stays one. A nest-proxy from before that matches it as one segment. A body the proxy can't read (encoded, over 64 KiB, slower than 30 s, not JSON, or the field missing) is in a `body_json` scope and never a `body_json` exception. The body is read only when a matcher on the request's host needs it, then replayed to the upstream whole.
- **A guarded host is always inspected:** never spliced (a passthrough entry for it is ignored) and never a TCP exception, so no layer can route around a guard.
- **Bounded per request (built 2026-11-12):** guards run on the proxy's workers, which every sandbox on the host shares. So a request to a guarded host is decoded and normalized once, not per matcher (`Req::prepare`), and one whose path is over 4096 bytes or 256 segments (as sent or normalized) or whose query is over 8192 bytes or 256 parameters is refused, not decided (414 `request_target_too_long`, audited `guard_target_too_long`). A pattern with one `**` tries only the split its tail fits (a tail without `**` matches exactly as many segments as it has), so each matcher costs time linear in the bounded target. The body pre-pass reads a body only for a guard whose scope can match the request whatever its body. `tests/guard_equivalence.rs` checks this decides exactly as the previous evaluator did, on 40,000 generated requests; unit tests pin that matching decodes nothing again and that one `**` tries one split.
  - **Measured worst case** (`tests/guard_cost.rs`, release build, one request, the per-sandbox bounds on client guards below): **about 1 ms** (0.87 ms here; 0.80 ms in the review of 2026-11-12), 14 scope matchers of one query parameter with 16 values against 256 same-name pairs, every value a near miss, so every comparison runs to its end and none matches, ignoring case. Paths: 0.04 ms (64 scope matchers `/**/<literal>/<literal>/<literal>/b` against 255 near-matching segments). The previous evaluator, decoding per matcher on targets of any length, took about 0.2 s for one request at the longest URI hyper accepts (64 KiB; the review of 2026-11-12).
  - **The bounds can refuse real requests:** percent-encoding triples a non-ASCII byte, so a `raw.githubusercontent.com` or contents-API path naming files with long non-ASCII names can pass 4096 bytes and get a 414.
- **Who writes them:** the operator (its layer's `guards`), the rule constructors (below), and API clients for their own sandboxes ([client guards](#client-guards)). nest-proxy gets them all as one list: the constructed ones, the operator's, then the clients'.
- **Decided (2026-11-01, the owner): rules are built by constructors that sit apart from the evaluator.** The proxy knows hosts, methods, paths, queries, one body field and bindings, never a service. What a service's rules mean is a constructor's: a pure function in the control plane (`control-plane/src/lib/rules/`) that turns an intent into generic guards, layered into the policy like any operator-written rule. **Why:** another git host or a registry's publish endpoint is a new constructor, with no change to the proxy; an operator can write the same rules by hand and get the same enforcement; and the evaluator is tested with made-up rules, the constructors from intent to rules, and one seam test through both ([testing](#tests)).

### Client guards

**Built (2026-11-12).** An API client writes request guards for its own sandboxes in the same shape, so an app expresses a service's rules (a push allowlist, a read-only API) as data, with no constructor in the kernel ([where and how](../../../../control-plane/api/clients/#request-guards)).
- **They can only refuse.** nest-proxy refuses a request when any guard refuses it, and consults a guard's `allow` only for that guard's own scope (`refusing` in `guard.rs`). So a client's exception never exempts a request from the operator's guards, the constructed ones or another layer's: adding a client's guards to a policy never lets through a request the policy without them refused. Shown by `tests/client_guards.rs` on the fixture `egress_policy.client_guards.json`, which a vitest asserts the control plane produces.
- **On the wire** a client's guard is an ordinary `RequestGuard` named `client:<name>`, after the operator's (a request both refuse names the operator's), and every named `injected` in it names the client's own binding (`client:<binding>`). An exception's `injected: "*"` stays `*`: [any injected credential](#any-injected-credential). The operator's layer can't name a guard `client:…`. No host change.
- **They never change routing the operator chose:** a guarded host is always inspected, never spliced and never a TCP exception, so a client's guard drops any host the operator marks passthrough or routes as a TCP exception (equal to, under or covering one). Otherwise the operator's splice or TCP exception would stop working, and an operator binding on a spliced host would become injectable.
- **Bounded,** for nest-proxy's packet and its per-request work: at most one `**` in a path pattern and a few segments after it (nest-proxy tries every split of a path at a `**`), and per-list and per-sandbox bounds on guards, scope matchers and matcher work, exceptions with their query parameters, body fields and values included ([limits](../../../../control-plane/api/clients/#request-guards)). With the proxy's per-request bounds above, a sandbox's guards cost the shared proxy at most about a millisecond a request (measured above).
- **Only where every host bounds them:** a cell with any sandbox host whose nest-proxy predates these bounds (its fleet hello lacks `guard_bounds`) refuses new client guards (409), never drops them, and a sandbox with client guards is placed only on a host that bounds them: with none free it waits, unplaced ([request guards](../../../../control-plane/api/clients/#request-guards)).
- **Who else writes them:** guards in the operator's templates and spawn overrides are client guards too: named `client:<name>`, with `injected` naming the sandbox's client's binding (`client:<b>`), and applied in any sandbox.

### Any injected credential

**Built (2026-11-12, [principle 10](../../../../README.md#principles)).** Two matcher fields let a guard ask about nest's own credentials without naming any app's binding (`injected_matches` in `guard.rs`; `INJECTED_ANY` in both protocol copies; what the injector wrote whole is `inject::apply_whole`):
- **`injected: "*"`** holds when the proxy substituted a credential anywhere in the request, whichever binding's (the operator's, a client's or a constructed one), and never when it substituted none. Only `*` itself: any other value is a binding's name. The operator layer refuses a binding named `*` or the empty name.
- **`at: <header>`** (owner's decision, 2026-11-12) names where that credential must be. It holds only when the request as forwarded carries exactly one field of that header (any case), and the proxy's substitution wrote that field's whole value: `Bearer <secret>` or `Basic <user:secret>` in `Authorization`, or a named header that was exactly the placeholder. The substitution must be by `injected`'s binding, or any binding when `injected` is absent or `*`. It works with a named binding too: `{injected: svc, at: x-api-key}`.

**What each form guarantees:**

| Matcher | Holds when | Doesn't guarantee |
|---|---|---|
| `{injected: "*"}` | some binding's credential was substituted somewhere in the request | anything about the request's other headers: a request with nest's credential in one header (say a client binding at `x-app-key`) and a credential the sandbox planted in `Authorization` passes, and the planted one goes upstream |
| `{injected: "*", at: authorization}` | the one `Authorization` field the upstream gets was written whole by nest's substitution, whichever binding's | other places a service may also take a credential (a second header, a cookie, the query): name each one the service authenticates by |
| `{injected: svc, at: <h>}` | as above, by binding `svc` only | as above |

- **Cases it is checked on** (`inject.rs` tests, `tests/guards.rs` through the real proxy on h1 and h2):
  - a substituted `Authorization` with a second, planted `Authorization` field after it: the substitution replaces every field, so the upstream gets nest's alone;
  - the planted field first: nothing replaces it, so `at` doesn't hold;
  - one field naming both (`Bearer <ph>, Bearer planted`), or the placeholder beside other text in a named header (partly substituted): not whole;
  - h2 sends repeated `authorization` fields, decided as the h1 case.

  A later substitution into a field another binding wrote whole unmakes it.
- **The guards see what is forwarded.** Hop-by-hop headers, including any the `Connection` header names (so `Connection: authorization` drops `Authorization`), are taken out before injection and the guards decide. Injection still looks for placeholders there, to block or alert on them, but never substitutes into them. A guarded host gets no request trailers, since a trailer (an `Authorization` one, say) would reach it undecided. An h2 upstream would otherwise get them; hyper's h1 client sends none here.
- **What it's for:** an operator floor in the [base layer](#base-layer), for example `scope: [{path: /**/git-receive-pack}]`, `allow: [{injected: "*", at: authorization}]`: a push passes only when its `Authorization` is nest's credential, never one planted in the sandbox. This replaces the GitHub constructor's `injected: github` exception once apps bind their own tokens. Without `at`, the floor is the weaker first row. The seam is the fixture `egress_policy.injected_any.json`: a base floor with `at`, an operator scope, and a client exception. A vitest asserts the control plane produces it, and `tests/injected_any.rs` evaluates it.
- **"Came through nest" includes apps' bindings** (owner's decision, 2026-11-12). A client's own binding satisfies an operator's `*`. What `*` guarantees is that the credential came through nest's injection: the operator's own, or a client's on a host the operator granted that client in `inject_hosts`. An operator who wants only their own bindings names each one (`injected: <binding>`, with `at`).
- **Who writes it:**
  - The operator, in the base and operator layers, in a scope or an exception.
  - An API client: `at` anywhere, and `*` in an exception (`allow`) only, where it means any binding, the operator's included. A guard only refuses, and its exceptions apply only within its own scope. So `*` there only narrows when the client's own guard lets a request through; it never exempts a request from another guard (`tests/injected_any.rs`). In a client's scope `*` is refused (400): a control plane rolled back to the previous release sends a client's `*` as `client:*`, which matches nothing, and a scope that matches nothing fails open.
- **Mixed versions, gated by one fleet hello flag** (`guard_injected_any`, [fleet](../../../../interfaces/control-host/fleet/#messages)), which covers `at` too. Both are new in this release, so no host advertises the flag without knowing both. A nest-proxy of the previous release reads `*` as a binding's name and ignores `at` (an unknown field). So with a named `injected` it compares against the last binding substituted, not the header's writer. With no binding named `*`, `tests/guard_equivalence.rs` shows on generated guards and requests against the previous evaluator:
  - **fail closed** (refuses at least what this release refuses): `*` in an exception, with or without `at` (the floor's form); `at` with no binding named, in a scope;
  - **fail open** (can let through what this release refuses): `*` in a scope; `at` with a binding named, in a scope; `at` without `*`, in an exception. Each is shown to occur, and so is a binding named `*` opening even the fail-closed positions.

  So:
  - **Writes wait for every host:** a guard newly using `*` or `at` is refused (409) while any sandbox host of the cell, any not dead, lacks the flag. This covers the base layer, the operator layer, a client's layer or create, and an attaching agent's spec. A write whose such guards are all already stored goes through. This keeps a floor from silently failing closed, or a scope open, on part of the cell.
  - **Placement keeps fail-open positions off old hosts:** a sandbox whose guards hold one is placed only on a host with the flag; with none free it waits, unplaced. FleetDO checks its own copy of the base layer as well as the sandbox's policy, which may predate a base-layer write. Fail-closed positions are placed anywhere: on an old host (one launched later, say by a host rollback) the floor only refuses more, so a push needing nest's credential fails there rather than passing without one.
- **Rollout:** [the rule](../../../../../dev/rollout/2026-11-12-injected-any.md).

## Repo allowlists

**Moving out (decided 2026-11-12, not built):** repo allowlists, read-only repos and the [GitHub](#github) constructor leave the kernel; an app builds the same from its own secrets, bindings and request guards in a sandbox's client layer, and the base layer's allowlist becomes operator data ([built](#base-layer); [principle 10](../../../../README.md#principles)). Until then these sections describe what runs.

**Built.** A sandbox may push only to repos explicitly on its **push allowlist**, enforced by nest-proxy whatever credential a push carries, so a prompt-injected agent can't push to an attacker's repo with the attacker's own token.

- **What it is:** exact `owner/name` names, compared without case (`control-plane/src/lib/repos.ts`). **No `owner/*`:** a wildcard covers repos created later, forks an agent made included, and can't narrow a token (GitHub's token request names repos). No name ending in `.git` (git's URL suffix). Default: none, so no push with any credential but one nest injected ([without nest's own token](#github)).
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
| `github-write` | `github.com` | every method but `GET`/`HEAD`: web forms (someone's cookie), LFS uploads and locks | `POST /<owner>/<repo>/git-upload-pack` (a fetch is a POST); `POST /<owner>/<repo>/info/lfs/objects/batch` with `operation: download` ([LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)); the allowed repos. Anchored at the repo (`/*/*/…`, `.git` or not): the web editor's routes end in a path the user chooses (`/<o>/<r>/tree-save/<branch>/<path>`), so a pattern open in front (`/**/git-upload-pack`, until 2026-11-13) let a cookie-authenticated web write through |
| `github-api-write` | `*.github.com` (api, uploads, www, …) | every method but `GET`/`HEAD` | `/repos/<repo>/**`; `POST /graphql` only with the sandbox's own tokens (`github` with an allowlist; `github_read` and `github_read_default` when nest mints them) |
| `gist-write` | `gist.github.com` | writes and push discovery (each gist is a git repo) | none |
| `githubusercontent-write` | `*.githubusercontent.com` | writes (signed upload URLs) | none |

**Where nest injects no GitHub token of its own** (decided 2026-11-12, for apps that bind their own GitHub token: [principle 10](../../../../README.md#principles)): no push allowlist, no read-only repos, and no operator binding that is a GitHub credential (by a GitHub binding's name, `github`, `github_read` or `github_read_default`; by a GitHub placeholder; or by injecting into `github.com` or any `*.github.com` host, an operator's PAT under any name). There the guards above would refuse every write, an app's own GitHub binding's included, so they take one more exception instead of the repo ones: the request's one `Authorization` field is a credential nest's injection wrote whole, whichever binding's (`{injected: "*", at: authorization}`, [any injected credential](#any-injected-credential)):
- **`github-push`:** for receive-pack; its discovery (`GET …/info/refs?service=git-receive-pack`) goes through bare, since git asks its credential helper only after that request's 401.
- **`github-write`:** for github.com's git and Git LFS writes, which authenticate by the request's own credential, at the repo: `POST /<owner>/<repo>/git-receive-pack` and Git LFS's API (`/<owner>/<repo>/info/lfs/objects/batch`, `…/info/lfs/locks`, `…/locks/verify`, `…/locks/<id>/unlock`), each `/*/*/…` (an open front would take the web editor's routes, which end in a path the user chooses). Every other github.com write is a web route a session cookie authenticates (`tree-save`, `/upload/…`, `/_graphql`, a `DELETE`), and `at` never sees a planted `Cookie`: those stay refused. A `/*/*/` segment with an encoded slash (`/o/r%2Ftree-save%2Fmain/git-receive-pack`) matches no exception, so a server that decodes it can't be handed the editor's route; a nest-proxy from before 2026-11-14 lacks that. Residual: a glob can't say `*.git`, so the LFS exceptions also match `/<owner>/<repo>/info/lfs/…` without `.git`, which github.com serves from its web app; no write route is known there (unverified).
- **`github-api-write`:** on every `*.github.com` host. An exception can't name a host, and splitting the guard by host can't leave the others refusing (a `*.github.com` guard covers api and uploads too). It is bounded instead by where nest injects at all: nest-proxy refuses a request carrying a placeholder on a host its binding doesn't name, so the exception holds only on hosts a binding names (an app's within its grant's `inject_hosts`); an operator binding on any of them counts as nest's own token, above.
- `gist-write` and `githubusercontent-write` are unchanged.
- **So a credential planted in the sandbox still writes nowhere** on GitHub, and an app that binds its own GitHub token (a [client binding](../../../../control-plane/api/clients/#injection) on a host the operator granted it) writes where that token and the app's own [client guards](#client-guards) let it. Its guards narrow further; they can't widen these.
- **Fails closed on an old nest-proxy** (one without `guard_injected_any`, which reads `*` as a binding's name): such a write is refused there. Only exceptions use `*`, so placement isn't constrained.
- **A sandbox that has nest's token** keeps exactly the guards above: `*` would also accept that token, which reaches every repo it was minted for, where the path exceptions are narrower.
- **The seam:** the fixture `egress_policy.github_none.json` (`githubEgress([])`'s guards), which `tests/github_rules.rs` evaluates with and without a substitution written whole into `Authorization` (or another header), the web routes included.

- **GraphQL decided:** one POST endpoint whose target isn't in the path, so the guard can't scope it by repo. It is let through only with the proxy's own substituted credential (`injected: github`), which is minted for the allowed repos only, so GitHub's own scoping confines its writes; any other credential, or none, is refused. Refusing all mutations would need a GraphQL parser in the proxy and break `gh pr create`.
- **Redirects:** the proxy never follows them; each hop is a new request, checked again. A renamed allowed repo that redirects elsewhere is refused at the new name until that is allowed.
- **Other git hosts and ssh: out of scope, and closed by default.** Only GitHub has a constructor. Another forge is reachable only after its host is allowed (an approved widening); its pushes are then not guarded until a constructor exists for it (an open question). Raw ssh has no route by default: the seeded [base layer](#base-layer) opens ports 80 and 443 only (an operator may open others there), `:443` must be TLS with SNI, and a guarded host can't be a TCP exception.
- **LFS uploads to an allowed repo** go where GitHub's batch answer points. If that is a `*.githubusercontent.com` host, the content-host guard refuses them (unverified where GitHub's upload URLs point).

### Tests

The evaluator with made-up hosts (`guard.rs` unit tests, `tests/guards.rs` through the real proxy: refusals before the upstream, body replay, the injected-credential exceptions, named and `*`, passthrough and TCP); the constructor from allowlist to rules (`test/repos.test.ts`); the seam: the constructor's output for two repos is the fixture `egress_policy.github.json`, with a read-only repo `egress_policy.github_read.json`, and with neither `egress_policy.github_none.json`, which a vitest asserts the constructor still produces and `tests/github_rules.rs` evaluates against GitHub's real request shapes; and the e2e harness's `run_repos` (a refused `git push` and receive-pack, an allowed discovery reaching GitHub, the audit record).

## Audit

- **Every connection or request is logged** with sandbox, agent (if known), entry point (`via`), SNI/host, method, path (no query string), status, bytes, the decision, and the *name* of any binding used (never its value). Records are batched through nestd to the control plane and written to R2.
- **Deny and alert records are aggregated per sandbox,** so a guest can't flood nestd or the control plane:
  - one record per distinct `(host, port, reason)` per minute, at most 128 distinct ones per minute
  - one alert per distinct `(kind, host, binding)` per minute, at most 32 per minute
  - when a new minute starts, a summary record (host `*`, reason `suppressed: …`) reports what was dropped

  Allowed traffic isn't aggregated; it's bounded by the connection limit.
- **Reason values** in audit records include: `not_allowed`, `invalid_host`, `no_sni`, `not_tls`, `no_ca`, `dns_nxdomain`, `connection_limit`, `host_mismatch` (plaintext), `host_sni_mismatch` and `duplicate_host` (inspected TLS, alert), `sni_mismatch` (CONNECT authority ≠ SNI, alert), `non_tls_tunnel`, `placeholder_wrong_host`, `injection_unavailable`, `injection_requires_tls`, `trace_with_credential`, `tcp_exception_not_in_policy`, `tcp_exception`, `upgraded`, `guard: <name>`, `guard_target_too_long`, `suppressed: …`, plus `upstream: …` / `connect: …` / `resolve: …` errors. Designed, not emitted yet: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope`, `injection_upgrade`. The wire list is in [nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#audit-reason-values).

## Open questions

- **Other forges:** a push to another git host is possible once its host is allowed (an approved widening) and unguarded until it has a constructor.
- **Publishing as exfiltration:** an allowed package registry takes uploads with someone else's token (`npm publish`, PyPI uploads). A constructor for registries' publish endpoints is the next candidate.
- **GraphQL** writes rest on GitHub applying the installation token's repo scope to GraphQL mutations (unverified). Refusing mutations outright needs a GraphQL parser in the proxy.
- **Ref-aware pushes:** the guards see a push's repo, never its refs or whether it's a fast-forward, so a sandbox that may push a repo may push or force-push every branch the repo doesn't protect. Apps whose agents force-push their own branches as routine (the projects app's workers rebase theirs: [PR upkeep](../../../../../projects/README.md#pr-upkeep)) rely on prompts to stay on them. A generic fix: a push allowlist naming refs (`owner/name:refs/heads/task/*`), checked against the ref updates in receive-pack's request, which the proxy would have to parse.
- **LFS uploads** to an allowed repo: where GitHub's batch answer points them is unverified; if at `*.githubusercontent.com`, the content-host guard refuses them.
- **The operator's guards** have no matcher-work bound (64 guards, any matchers), being trusted as the rest of the operator's policy is; whether to bound them too is open.

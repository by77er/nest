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
  guards: []   # request guards, layered with the base layer's and the client's
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
- **Its rules reach hosts tagged `layer: base`** and show as `source: base` ([sources](#sources)). Its guards join every guard of the sandbox's policy (each must let a request through), ahead of the operator's and the client's. They are the operator's, as the operator layer's are: never named `client:` (the operator layer's schema refuses that), so they count against no sandbox's [client guard](../../../../control-plane/api/clients/#request-guards) limit and don't keep a sandbox off a host whose nest-proxy doesn't bound client guards. Unlike a client's guards, they aren't dropped for a host an operator layer passes through or routes as a TCP exception: a cell-wide base guard on such a host forces it to be inspected or refuses it, the operator's base overriding the operator's own layer.
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
| `client` | the sandbox's API client's own rules: its client layer, its sandbox spec, and its attached agents' specs |
| `grant` | temporary grants (an approved `egress_policy`, or `POST …/grants`), with `expires_ms` |

- **`layer` stays beside it for one release:** the wire's value (`base`, `workstream` for every rule that is neither base nor a grant, `sandbox` for grants). Readers move to `source`; `layer` leaves the API view in the release after.
- **`source` never reaches a host:** the policy nest-proxy gets (`policy_update`, `sandbox_create`) is unchanged, its rules tagged only with the closed `layer` enum hosts parse. So there is no wire change and no fixture.
- **What a client reads** of its sandbox: the base layer's and the operator's rules, its own marked `client`, and its own bindings with their placeholders. Never a secret, a secret reference, or another client's binding.

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
- **Scopes err towards refusing; exceptions towards not matching.** A scope matches the path as sent *or* decoded and normalized (percent-decoding up to three rounds, `\` as `/`, `;params` cut, empty and dot segments applied), and query names and values decoded. An exception matches only a clean path as sent ([injection](../injection/#scope)'s safe-path rules, plus no segment that decodes to a dot segment), compared as sent, so an encoded or `;`-suffixed name never equals a literal. A segment that holds `/` or `\` once decoded (`%2F`, `%5C`) matches only under `**`, never as a `*` or a literal, an empty one included (built 2026-11-14; it reads as `/`, which no segment or literal is): a server that decodes it reads more segments there than the pattern saw, while an API's encoded parameter under `**` stays one. A nest-proxy from before that matches it as one segment; its hello lacks `guard_sealed_segments`, so it isn't trusted with `at` ([any injected credential](#any-injected-credential)). A body the proxy can't read (encoded, over 64 KiB, slower than 30 s, not JSON, or the field missing) is in a `body_json` scope and never a `body_json` exception. The body is read only when a matcher on the request's host needs it, then replayed to the upstream whole.
- **A guarded host is always inspected:** never spliced (a passthrough entry for it is ignored) and never a TCP exception, so no layer can route around a guard.
- **Bounded per request (built 2026-11-12):** guards run on the proxy's workers, which every sandbox on the host shares. So a request to a guarded host is decoded and normalized once, not per matcher (`Req::prepare`), and one whose path is over 4096 bytes or 256 segments (as sent or normalized) or whose query is over 8192 bytes or 256 parameters is refused, not decided (414 `request_target_too_long`, audited `guard_target_too_long`). A pattern with one `**` tries only the split its tail fits (a tail without `**` matches exactly as many segments as it has), so each matcher costs time linear in the bounded target. The body pre-pass reads a body only for a guard whose scope can match the request whatever its body. `tests/guard_equivalence.rs` checks this decides exactly as the previous evaluator did, on 40,000 generated requests; unit tests pin that matching decodes nothing again and that one `**` tries one split.
  - **Measured worst case** (`tests/guard_cost.rs`, release build, one request, the per-sandbox bounds on client guards below): **about 1 ms** (0.87 ms here; 0.80 ms in the review of 2026-11-12), 14 scope matchers of one query parameter with 16 values against 256 same-name pairs, every value a near miss, so every comparison runs to its end and none matches, ignoring case. Paths: 0.04 ms (64 scope matchers `/**/<literal>/<literal>/<literal>/b` against 255 near-matching segments). The previous evaluator, decoding per matcher on targets of any length, took about 0.2 s for one request at the longest URI hyper accepts (64 KiB; the review of 2026-11-12).
  - **The bounds can refuse real requests:** percent-encoding triples a non-ASCII byte, so a `raw.githubusercontent.com` or contents-API path naming files with long non-ASCII names can pass 4096 bytes and get a 414.
- **Who writes them:** the operator (the [base layer](#base-layer)'s `guards` and its layer's) and API clients for their own sandboxes ([client guards](#client-guards)). nest-proxy gets them all as one list: the base layer's, the operator's, then the clients'.
- **Decided (2026-11-01, the owner): the evaluator knows no service.** The proxy knows hosts, methods, paths, queries, one body field and bindings. What a service's rules mean belongs to whoever writes them as data: the operator in its layers, or an app in its client guards; the kernel builds none of its own ([no repo tokens](#no-repo-tokens)). **Why:** another service's rules need no change to the proxy or the control plane, and the evaluator is tested with made-up rules plus seam fixtures ([testing](#tests)).

### Client guards

**Built (2026-11-12).** An API client writes request guards for its own sandboxes in the same shape, so an app expresses a service's rules (a push allowlist, a read-only API) as data, with no constructor in the kernel ([where and how](../../../../control-plane/api/clients/#request-guards)).
- **They can only refuse.** nest-proxy refuses a request when any guard refuses it, and consults a guard's `allow` only for that guard's own scope (`refusing` in `guard.rs`). So a client's exception never exempts a request from the base layer's or the operator's guards, or another layer's: adding a client's guards to a policy never lets through a request the policy without them refused. Shown by `tests/client_guards.rs` on the fixture `egress_policy.client_guards.json`, which a vitest asserts the control plane produces.
- **On the wire** a client's guard is an ordinary `RequestGuard` named `client:<name>`, after the operator's (a request both refuse names the operator's), and every named `injected` in it names the client's own binding (`client:<binding>`). An exception's `injected: "*"` stays `*`: [any injected credential](#any-injected-credential). The operator's layer can't name a guard `client:…`. No host change.
- **They never change routing the operator chose:** a guarded host is always inspected, never spliced and never a TCP exception, so a client's guard drops any host the operator marks passthrough or routes as a TCP exception (equal to, under or covering one). Otherwise the operator's splice or TCP exception would stop working, and an operator binding on a spliced host would become injectable.
- **Bounded,** for nest-proxy's packet and its per-request work: at most one `**` in a path pattern and a few segments after it (nest-proxy tries every split of a path at a `**`), and per-list and per-sandbox bounds on guards, scope matchers and matcher work, exceptions with their query parameters, body fields and values included ([limits](../../../../control-plane/api/clients/#request-guards)). With the proxy's per-request bounds above, a sandbox's guards cost the shared proxy at most about a millisecond a request (measured above).
- **Only where every host bounds them:** a cell with any sandbox host whose nest-proxy predates these bounds (its fleet hello lacks `guard_bounds`) refuses new client guards (409), never drops them, and a sandbox with client guards is placed only on a host that bounds them: with none free it waits, unplaced ([request guards](../../../../control-plane/api/clients/#request-guards)).
- **Who else writes them:** guards in the operator's templates and spawn overrides are client guards too: named `client:<name>`, with `injected` naming the sandbox's client's binding (`client:<b>`), and applied in any sandbox.

### Any injected credential

**Built (2026-11-12, [principle 10](../../../../README.md#principles)).** Two matcher fields let a guard ask about nest's own credentials without naming any app's binding (`injected_matches` in `guard.rs`; `INJECTED_ANY` in both protocol copies; what the injector wrote whole is `inject::apply_whole`):
- **`injected: "*"`** holds when the proxy substituted a credential anywhere in the request, whichever binding's (the operator's or a client's), and never when it substituted none. Only `*` itself: any other value is a binding's name. The operator layer refuses a binding named `*` or the empty name.
- **`at: <header>`** (owner's decision, 2026-11-12) names where that credential must be. It holds only when the request as forwarded carries exactly one field of that header (any case), and the proxy's substitution wrote that field's whole value: `Bearer <secret>` in `Authorization`; `Basic <user:secret>` there only when the binding's Basic location names its `username`; or a named header that was exactly the placeholder. The substitution must be by `injected`'s binding, or any binding when `injected` is absent or `*`. It works with a named binding too: `{injected: svc, at: x-api-key}`.
  - **A Basic username is the binding's or nobody's** (decided 2026-11-13, from a review: GitHub, for one, takes a token as the Basic username, so `Basic base64(<planted token>:<placeholder>)` would otherwise pass with a credential the sandbox chose). A Basic password location may name a `username` (`{type: authorization_basic_password, username: x-access-token}`): nest-proxy then writes `Basic base64(<username>:<secret>)` whatever username the request sent, and only that counts as written whole. Without one, the request's username is kept and the field is never whole, so `at` doesn't hold for it.
  - **Mixed versions:** a nest-proxy of the previous release ignores `username` (its location reads it as the plain one: `a_basic_location_names_a_username_only_when_set`) and takes any Basic substitution as whole. nestd's fleet hello says `guard_basic_user` for this one; FleetDO keeps it per host (`hosts.guard_basic_user`). A guard newly using `at` is refused (409) while any sandbox host of the cell lacks it (as `guard_injected_any` gates `*` and `at`).
    - **One invariant, at one gate** (decided 2026-11-14, from reviews): a sandbox on a host that doesn't enforce `at` never has, in its effective policy, a guard using `at` as that host gets it. A host enforces `at` when its hello says both `guard_basic_user` (else it keeps the request's username, so a username the sandbox chose would satisfy the `at` beside a Basic binding) and `guard_sealed_segments` (else an exception matches a segment holding an encoded separator, [request guards](#request-guards); added 2026-11-14).
      - **Placement:** a policy with a Basic binding, or with a guard using `at` (its own or the cell's base layer as FleetDO holds it), goes only to a host that enforces `at`: a later change could bring the other.
      - **Every change of the effective policy** (a client's layer, an attach with its extras, the operator's layer) goes through one gate (`requireBasicUser`): applied, judged and undone in one transaction; if it newly brings a guard using `at`, or a Basic binding beside one, and the sandbox's own host is known not to enforce `at` (asked of FleetDO), it's refused (409 `hosts_not_ready`). The base layer reaches every sandbox of the cell, so a guard newly using `at` there waits for every host (cell-wide, above).
      - **What can't be refused fails closed:** a layer a previous release stored, a release whose guards add `at`. Whenever a guard uses `at` on a host not known to enforce it (FleetDO says it lacks a flag, or nothing is known: the read failed, no row), the policy SandboxDO pushes there has the guards without `at` (`guardsWithoutAt`: an exception using `at` goes, a scope matcher loses its `at`), so they refuse more, never less. SandboxDO asks FleetDO for its host's flags before each push and each reissued create, and holds `true` for a host it was placed on with a Basic binding or `at` (placement required both).
      - **Residual (unverified):** FleetDO holds each host's flags as its last hello said them; a host whose nestd is replaced by an older one in place keeps the row until it says hello again (each reconnect does), and whether a Durable Object deploy makes hosts say hello again isn't checked.
    - **Catalog templates don't hold a `username` yet:** a template whose binding names one is refused (400). The previous release's CatalogDO parses a location strictly and would drop the whole template after a rollback. Only a sandbox's client layer (its client's `client-policy`, or a create's `inject`) and the operator's layer can name one: a spawn only narrows a template's bindings. The operator's is refused with a `:` or a control character, as a client's is.
    - **Residual:** a host that said the flag and later says none (a downgrade in place, which deploys don't do: a host version is rolled back by replacing hosts, [deploy](../../../../../dev/deploy.md)) keeps the sandboxes on it; the next push there fails closed (above), and until it the proxy holds what it had. A sandbox moved off a replaced host is placed again, through the same check.

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
- **What it's for:** an operator floor in the [base layer](#base-layer), for example `scope: [{path: /**/git-receive-pack}]`, `allow: [{injected: "*", at: authorization}]`: a push passes only when its `Authorization` is nest's credential, never one planted in the sandbox. Without `at`, the floor is the weaker first row. The seam is the fixture `egress_policy.injected_any.json`: a base floor with `at`, an operator scope, and a client exception. A vitest asserts the control plane produces it, and `tests/injected_any.rs` evaluates it.
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

## No repo tokens

**Decided (2026-11-12, [principle 10](../../../../README.md#principles); built 2026-11-15):** the kernel holds no repo allowlist, no read-only repos, no GitHub guards and no repo tokens. An app builds the same from its own secrets, [client bindings](../../../../control-plane/api/clients/#injection), environment and [client guards](#client-guards) in a sandbox's client layer, and the operator can put a cell-wide floor in the [base layer](#base-layer).
- **No sandbox gets a guard, binding or allow rule nest constructs:** its policy is the base layer, the operator's layer, its client's and its grants, nothing else.
- **The fields that carried it go:** `repos`, `read_repos` and `github_push` in templates, spawn overrides, the operator's layer, a sandbox's create and its client layer, and `repos` and `read_repos` in the `agent_spawn` tool (which now refuses them as unknown arguments). For one release a write may still name one that grants nothing (an empty list, `workflows: false`), which is dropped; one that grants anything is refused (400). A stored template, spec or layer holding them reads without them: a spawn from such a template gets none, and a stored spec keeps them in its record, out of its view.
- **What a release before kept goes:** a sandbox drops its agents' repos and its push opt-ins at its next start, and BrokerDO forgets every token that release minted at its own start, so an operator binding of the same name never resolves to one. The guest image's `GITHUB_TOKEN` and git credential helper still carry `nest-ph-github`, which nothing fills unless an operator binding takes that placeholder; they leave the image with phase C4.
- **Rollout:** [the rule](../../../../../dev/rollout/2026-11-15-kernel-github-minting.md).

### Tests

The evaluator with made-up hosts (`guard.rs` unit tests, `tests/guards.rs` through the real proxy: refusals before the upstream, body replay, the injected-credential exceptions, named and `*`, passthrough and TCP); seam fixtures the control plane produces and nest-proxy evaluates (`egress_policy.injected_any.json`, `egress_policy.client_guards.json`; `tests/github_rules.rs` still evaluates the GitHub-shaped `egress_policy.github*.json` fixtures as rule data); and the e2e harness's `run_repos`: an operator guard written as data refuses a `git push` and receive-pack to another repo and lets one repo's discovery reach GitHub, with the audit record.

## Audit

- **Every connection or request is logged** with sandbox, agent (if known), entry point (`via`), SNI/host, method, path (no query string), status, bytes, the decision, and the *name* of any binding used (never its value). Records are batched through nestd to the control plane and written to R2.
- **Deny and alert records are aggregated per sandbox,** so a guest can't flood nestd or the control plane:
  - one record per distinct `(host, port, reason)` per minute, at most 128 distinct ones per minute
  - one alert per distinct `(kind, host, binding)` per minute, at most 32 per minute
  - when a new minute starts, a summary record (host `*`, reason `suppressed: …`) reports what was dropped

  Allowed traffic isn't aggregated; it's bounded by the connection limit.
- **Reason values** in audit records include: `not_allowed`, `invalid_host`, `no_sni`, `not_tls`, `no_ca`, `dns_nxdomain`, `connection_limit`, `host_mismatch` (plaintext), `host_sni_mismatch` and `duplicate_host` (inspected TLS, alert), `sni_mismatch` (CONNECT authority ≠ SNI, alert), `non_tls_tunnel`, `placeholder_wrong_host`, `injection_unavailable`, `injection_requires_tls`, `trace_with_credential`, `tcp_exception_not_in_policy`, `tcp_exception`, `upgraded`, `guard: <name>`, `guard_target_too_long`, `suppressed: …`, plus `upstream: …` / `connect: …` / `resolve: …` errors. Designed, not emitted yet: `dns_non_public`, `handshake_limit`, `policy_pending`, `policy_changed`, `invalid_headers`, `injection_out_of_scope`, `injection_upgrade`. The wire list is in [nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#audit-reason-values).

## Open questions

- **Writes with a planted credential:** with no guard of nest's own, a sandbox whose base layer allows a host (github.com, a package registry) can write there with any credential it holds, unless a base-layer floor, the operator's guards or its app's guards refuse it. Whether the seeded base layer should carry a floor (as data) is the operator's.
- **Ref-aware pushes:** guards see a push's repo path, never its refs or whether it's a fast-forward, so a sandbox whose guards let it push a repo may push or force-push every branch the repo doesn't protect. Apps whose agents force-push their own branches as routine (the projects app's workers rebase theirs: [PR upkeep](../../../../../projects/README.md#pr-upkeep)) rely on prompts to stay on them. A generic fix needs a matcher on the ref updates in receive-pack's request, which the proxy would have to parse.
- **The operator's guards** have no matcher-work bound (64 guards, any matchers), being trusted as the rest of the operator's policy is; whether to bound them too is open.

# Credential injection

Sandboxes only ever see **placeholders**. nest-proxy swaps in real credentials on inspected traffic.

```yaml
github:
  hosts: [github.com, api.github.com]       # exact names
  placeholder: nest-ph-github               # unique per binding
  where: [authorization.bearer, authorization.basic.password]
  source: github-app{repos: <the push allowlist>, permissions: {contents: write, pull_requests: write}}   # BrokerDO mints a 1-hour token
github_read:                                # only with read-only repos
  hosts: [github.com, api.github.com]
  placeholder: nest-ph-read-github
  where: [authorization.bearer, authorization.basic.password]
  source: github-app{repos: <the read-only repos>, permissions: {contents: read, metadata: read}}
github_read_default:                        # the same token, with read-only repos and no allowlist
  placeholder: nest-ph-github               # the guest's default
stripe-read:
  hosts: [api.stripe.com]
  placeholder: nest-ph-stripe-91c2
  where: [authorization.bearer]
  methods: [GET]                            # optional; designed, not built
  path_prefix: /v1/charges                  # optional, whole segments; designed, not built
  source: secret                            # BrokerDO inject:stripe-read
```

## Scope

- **Substitution** happens only when the placeholder is present, and only for the binding's own hosts (and, designed, not built, its methods and path).
- **Hosts are exact.** A `*.` pattern is refused unless the binding sets `wildcard: true`: a wildcard also reaches subdomains run by third parties (CNAME'd SaaS, user-content hosts). Built for API clients' bindings; the operator layer's bindings take `*.` patterns unchecked (not built).
- **Designed, not built:** nest-proxy's binding (`InjectionBinding`) carries only `name`, `hosts`, `placeholder` and `locations`, so the next three rules aren't enforced.
- **`methods`** (optional) limits the methods; omitted, any method except TRACE/TRACK.
- **`path_prefix`** (optional) matches whole segments: `/v1` matches `/v1` and `/v1/…` but not `/v10`; a prefix ending in `/` matches everything under it. Query strings aren't considered.
  - **Safe paths only:** the prefix must start with `/`, be ≤ 2,048 bytes, and contain no `\`, `?`, `#`, `%`, NUL, `//`, or `.`/`..` segments. With a prefix set, the request path must pass the same rules, so encodings and dot segments can't step outside it. These are SPACE's rules ([policy.proto](https://github.com/perplexityai/space/blob/main/proto/net/policy/v1/policy.proto), [net/common](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)).
  - Without a prefix, any path matches, so APIs with percent-encoded paths (`refs%2Fheads%2Fmain`) keep working.
- **A placeholder on a method or path outside the binding** is refused (403, `injection_out_of_scope`) and never sent.
- **A placeholder sent to any other host is blocked** and raises an `egress_alert`, since it's a likely exfiltration attempt or a misconfiguration.
- **Reserved headers:** an API client's `header{name}` location can't name `host`, `connection`, `content-length`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `keep-alive`, `proxy-authorization`, `proxy-authenticate`, `proxy-connection`, `http2-settings`, or a [routing override](../inspection/). Substituting into them would change routing or framing after the proxy checked it. SPACE reserves the same standard headers ([net/common](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)). The operator layer's bindings aren't checked (not built).
- **Processors:** a binding's `where` covers bearer and basic credentials and named headers now. Request-signing processors (AWS SigV4, OAuth2 client credentials, HMAC) come later, as in Fly's [Tokenizer](https://github.com/superfly/tokenizer).

## API clients' bindings

**Built (2026-11-02):** an API client declares bindings naming its own write-only secrets, in its templates, its spawns' overrides (which only narrow) and its sandbox specs, on hosts within its grant's `inject_hosts`; nest assigns the placeholder (`nest-ph.<client>.<name>.`). On the wire each is an ordinary binding named `client:<name>`, so nest-proxy needs nothing new; BrokerDO serves its secret only under that client's id, and only for the sandbox's own client. Decisions: [API clients](../../../../control-plane/api/clients/#injection).

## On the wire

- **No protocol upgrade after a substitution (designed, not built).** A request that had a placeholder substituted can't upgrade to WebSocket (h1 `Upgrade` or h2 extended CONNECT): 403, `injection_upgrade`. Masking follows HTTP responses, not frames. nest-proxy forwards an h1 `Upgrade` whether or not it substituted; its h2 side offers no extended CONNECT.
- **Substituted values are sensitive:** on h2 the header is sent as never-indexed ([RFC 7541 §7.1.3](https://www.rfc-editor.org/rfc/rfc7541#section-7.1.3)), so the secret never enters the HPACK dynamic table where later guest-controlled headers on the same connection could probe it.
- **Reflected secrets are masked.** On a request where a credential was substituted, every occurrence of the secret (and of the exact credential header value, including the base64 of a `Basic` one) in the response headers and in an uncompressed response body is replaced with `*` of the same length, streaming, so `Content-Length` stays valid. Compressed (`content-encoding` other than identity) bodies aren't scanned.
- **TRACE/TRACK are refused** on requests carrying an injected credential (405), since they echo the request back.
- **Passthrough hosts can't receive injected credentials,** because their traffic isn't decrypted. Nor can plaintext HTTP: a placeholder sent to the binding's own host over it is refused (403, `credential_requires_tls`).

## Secrets in the proxy

- **Static secrets are keyed by sandbox:** BrokerDO serves the most specific of `inject:<binding>:<sandbox>`, `inject:<binding>:<workstream>` (the sandbox's compat `ws_` value: still read in case secrets were stored under it before the sandbox key; nothing new is keyed by it) and `inject:<binding>`.
- **An unresolved reference is refused, not substituted** (2026-11-02): a `secrets_update` entry whose reference resolves to nothing (a deleted or expired secret, the operator's static ones too) is left out of the push, so nest-proxy has no secret for that binding and refuses its placeholder (`injection_unavailable`), never sending an empty credential.
- **They arrive separately today** (`secrets_set`, checked against the sandbox's epoch only). Designed, not built: each push carries the policy's version and sha256, and the proxy **refuses a secret whose binding isn't in the installed policy**, or that names another policy version or hash ([nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#policy-acknowledgement)).
- **Expiring secrets fail closed at their expiry:** a secret pushed with `expires_ms` (a minted token's, or an API client's `expires_at`) is refused from that moment (`injection_unavailable`), before the next push takes it away.
- **Pushed on change:** a policy change that touches injection pushes again, and so does an API client's write or delete of a secret ([client secret pushes](../../../../control-plane/durable-objects/broker/#client-secret-pushes)); every 15 minutes otherwise.
- **Fenced:** after the sandbox's lease or epoch expires, bindings stop substituting.
- **Alerts carry the binding name** (`ProxyEvent::Alert.binding`) for `placeholder_wrong_host` and `injection_after_expiry`. Domain-fronting alerts have none.

## GitHub

**Moving out (decided 2026-11-12, not built):** the GitHub bindings, their minting and the image's credential helper and `GITHUB_TOKEN` leave the kernel; an app binds its own tokens as [API clients' secrets](#api-clients-bindings) ([principle 10](../../../../README.md#principles)). `git` and `gh` stay in the image. Until then this section describes what runs.

- **GitHub uses a GitHub App (built).** A sandbox with a [push allowlist](../policy/#repo-allowlists) gets the binding `github` from the GitHub rule constructor; BrokerDO mints its installation token narrowed to exactly the allowed repos with `contents: write` (which includes the `contents: read` pull requests need) and `pull_requests: write`, valid for one hour, and SandboxDO pushes it again 15 minutes before it expires ([BrokerDO](../../../../control-plane/durable-objects/broker/#injection-minting)). An operator binding named `github` in the sandbox layer replaces the constructed one (and its static secret is used instead).
- **`workflows: write` on the push token only when asked** (`github_push: {workflows: true}` in a template, a sandbox spec or the operator's layer, within an API client's grant): GitHub refuses a push that changes `.github/workflows/` without it. A pushed workflow runs with the repo's Actions secrets before review, so CI secrets belong in an approval-gated environment ([workflow files](../../../../control-plane/api/clients/#workflow-files)).
- **Read-only repos get a token of their own** under the binding `github_read`, which can only read, and under `github_read_default` (the default placeholder) when the sandbox has no allowlist ([read-only repos](../policy/#read-only-repos)). An operator binding named `github_read` replaces that one the same way.
- **The token doesn't decide where a push may go:** the [request guards](../policy/#github) do, whatever credential a request carries.
- **Defaults in the image (built, `images/guest/`):**
  - a git credential helper (`git-credential-nest`, set for `https://github.com`) that returns `x-access-token` / the placeholder
  - `GITHUB_TOKEN=nest-ph-github` (in `/etc/environment`, which init exports into nest-guest's environment), and `gh`

  So `git push` over HTTPS and `gh` work without a real token in the sandbox. The placeholder is fixed in the image, not per sandbox: it is worthless outside nest-proxy, which refuses it to any other host. A test keeps it in step with the constructor's.
- **Nothing in a sandbox's or agent's `env` may take that over:** the names `gh` and git would prefer to the image's (`GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, every `GIT_CONFIG*`) are reserved with `GITHUB_TOKEN`, for every client ([environment](../../../../control-plane/api/clients/#environment)).

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
  methods: [GET]                            # optional
  path_prefix: /v1/charges                  # optional, whole segments
  source: secret                            # BrokerDO inject:stripe-read
```

## Scope

- **Substitution** happens only when the placeholder is present, and only for the binding's own hosts, methods and path.
- **Hosts are exact.** A `*.` pattern is refused unless the binding sets `wildcard: true`: a wildcard also reaches subdomains run by third parties (CNAME'd SaaS, user-content hosts).
- **`methods`** (optional) limits the methods; omitted, any method except TRACE/TRACK.
- **`path_prefix`** (optional) matches whole segments: `/v1` matches `/v1` and `/v1/…` but not `/v10`; a prefix ending in `/` matches everything under it. Query strings aren't considered.
  - **Safe paths only:** the prefix must start with `/`, be ≤ 2,048 bytes, and contain no `\`, `?`, `#`, `%`, NUL, `//`, or `.`/`..` segments. With a prefix set, the request path must pass the same rules, so encodings and dot segments can't step outside it. These are SPACE's rules ([policy.proto](https://github.com/perplexityai/space/blob/main/proto/net/policy/v1/policy.proto), [net/common](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)).
  - Without a prefix, any path matches, so APIs with percent-encoded paths (`refs%2Fheads%2Fmain`) keep working.
- **A placeholder on a method or path outside the binding** is refused (403, `injection_out_of_scope`) and never sent.
- **A placeholder sent to any other host is blocked** and raises an `egress_alert`, since it's a likely exfiltration attempt or a misconfiguration.
- **Reserved headers:** a `header{name}` location can't name `host`, `connection`, `content-length`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `keep-alive`, `proxy-authorization`, `proxy-authenticate`, `proxy-connection`, `http2-settings`, or a [routing override](../inspection/). Substituting into them would change routing or framing after the proxy checked it. SPACE reserves the same standard headers ([net/common](https://github.com/perplexityai/space/blob/main/crates/libs/net/common/src/lib.rs)).
- **Processors:** a binding's `where` covers bearer and basic credentials and named headers now. Request-signing processors (AWS SigV4, OAuth2 client credentials, HMAC) come later, as in Fly's [Tokenizer](https://github.com/superfly/tokenizer).

## API clients' bindings

**Built (2026-11-02):** an API client declares bindings naming its own write-only secrets, in its templates, its spawns' overrides (which only narrow) and its sandbox specs, on hosts within its grant's `inject_hosts`; nest assigns the placeholder (`nest-ph.<client>.<name>.`). On the wire each is an ordinary binding named `client:<name>`, so nest-proxy needs nothing new; BrokerDO serves its secret only under that client's id, and only for the sandbox's own client. Decisions: [API clients](../../../../control-plane/api/clients/#injection).

## On the wire

- **No protocol upgrade after a substitution.** A request that had a placeholder substituted can't upgrade to WebSocket (h1 `Upgrade` or h2 extended CONNECT): 403, `injection_upgrade`. Masking follows HTTP responses, not frames.
- **Substituted values are sensitive:** on h2 the header is sent as never-indexed ([RFC 7541 §7.1.3](https://www.rfc-editor.org/rfc/rfc7541#section-7.1.3)), so the secret never enters the HPACK dynamic table where later guest-controlled headers on the same connection could probe it.
- **Reflected secrets are masked.** On a request where a credential was substituted, every occurrence of the secret (and of the exact credential header value, including the base64 of a `Basic` one) in the response headers and in an uncompressed response body is replaced with `*` of the same length, streaming, so `Content-Length` stays valid. Compressed (`content-encoding` other than identity) bodies aren't scanned.
- **TRACE/TRACK are refused** on requests carrying an injected credential (405), since they echo the request back.
- **Passthrough hosts can't receive injected credentials,** because their traffic isn't decrypted.

## Secrets in the proxy

- **Static secrets are keyed by sandbox:** BrokerDO serves the most specific of `inject:<binding>:<sandbox>`, `inject:<binding>:<workstream>` (the sandbox's compat `ws_` value: still read in case secrets were stored under it before the sandbox key; nothing new is keyed by it) and `inject:<binding>`.
- **They arrive separately today** (`secrets_set`, checked against the sandbox's epoch only). Designed, not built: each push carries the policy's version and sha256, and the proxy **refuses a secret whose binding isn't in the installed policy**, or that names another policy version or hash ([nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#policy-acknowledgement)).
- **Fenced:** after the sandbox's lease or epoch expires, bindings stop substituting.
- **Alerts carry the binding name** (`ProxyEvent::Alert.binding`) for `placeholder_wrong_host` and `injection_after_expiry`. Domain-fronting alerts have none.

## GitHub

- **GitHub uses a GitHub App (built).** A sandbox with a [push allowlist](../policy/#repo-allowlists) gets the binding `github` from the GitHub rule constructor; BrokerDO mints its installation token narrowed to exactly the allowed repos with `contents: write` (which includes the `contents: read` pull requests need) and `pull_requests: write`, valid for one hour, and SandboxDO pushes it again 15 minutes before it expires ([BrokerDO](../../../../control-plane/durable-objects/broker/#injection-minting)). An operator binding named `github` in the sandbox layer replaces the constructed one (and its static secret is used instead).
- **`workflows: write` on the push token only when asked** (`github_push: {workflows: true}` in a template, a sandbox spec or the operator's layer, within an API client's grant): GitHub refuses a push that changes `.github/workflows/` without it. A pushed workflow runs with the repo's Actions secrets before review, so CI secrets belong in an approval-gated environment ([workflow files](../../../../control-plane/api/clients/#workflow-files)).
- **Read-only repos get a token of their own** under the binding `github_read`, which can only read, and under `github_read_default` (the default placeholder) when the sandbox has no allowlist ([read-only repos](../policy/#read-only-repos)). An operator binding named `github_read` replaces that one the same way.
- **The token doesn't decide where a push may go:** the [request guards](../policy/#github) do, whatever credential a request carries.
- **Defaults in the image (built, `images/guest/`):**
  - a git credential helper (`git-credential-nest`, set for `https://github.com`) that returns `x-access-token` / the placeholder
  - `GITHUB_TOKEN=nest-ph-github` (in `/etc/environment`, which init exports into nest-guest's environment), and `gh`

  So `git push` over HTTPS and `gh` work without a real token in the sandbox. The placeholder is fixed in the image, not per sandbox: it is worthless outside nest-proxy, which refuses it to any other host. A test keeps it in step with the constructor's.

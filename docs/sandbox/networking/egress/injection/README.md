# Credential injection

Sandboxes only ever see **placeholders**. nest-proxy swaps in real credentials on inspected traffic.

```yaml
stripe-read:
  hosts: [api.stripe.com]                   # exact names
  placeholder: nest-ph-stripe-91c2          # unique per binding
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
- **Guards can require a substitution:** a [request guard](../policy/#request-guards)'s `injected` matcher holds when the proxy substituted a binding's credential into the request: a named binding's, or with `*` any binding's. Alone, that's anywhere in the request, so other headers may still carry a credential the sandbox holds. With `at: <header>` it holds only when that header's one field is a value the substitution wrote whole (`Bearer <secret>`; `Basic <user:secret>` only from a Basic location naming its `username`, which nest-proxy writes in place of the request's; or a named header that was exactly the placeholder). So `{injected: "*", at: authorization}` lets a write through only when its `Authorization` is nest's credential, never one the sandbox holds itself, without naming any app's binding ([any injected credential](../policy/#any-injected-credential)).
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
- **Expiring secrets fail closed at their expiry:** a secret pushed with `expires_ms` (a minted token's, or an API client's `expires_at`) is refused from that moment (`injection_unavailable`), before the next push takes it away. FleetDO stamps each entry with the expiry stored with its value when it sends, so a value and its expiry always travel together.
- **Pushed on change:** a policy change that touches injection pushes again, and so does an API client's write or delete of a secret ([client secret pushes](../../../../control-plane/durable-objects/broker/#client-secret-pushes)); every 15 minutes otherwise.
- **Fenced:** after the sandbox's lease or epoch expires, bindings stop substituting.
- **Alerts carry the binding name** (`ProxyEvent::Alert.binding`) for `placeholder_wrong_host` and `injection_after_expiry`. Domain-fronting alerts have none.

## GitHub

nest constructs no GitHub binding and mints no GitHub token ([no repo tokens](../policy/#no-repo-tokens)): an app binds its own tokens as [API clients' secrets](#api-clients-bindings), with its own environment (`GH_TOKEN`, a git credential helper through `GIT_CONFIG_*`) and its own [guards](../policy/#client-guards). `git` and `gh` stay in the image as ordinary tools. **Until phase C4** the guest image still carries a git credential helper (`git-credential-nest`, for `https://github.com`, answering `x-access-token` and `nest-ph-github`) and `GITHUB_TOKEN=nest-ph-github`: nothing fills that placeholder unless an operator binding takes it, so without one it goes to GitHub as an ordinary credential, which GitHub refuses. An app overrides them in its own environment (`GH_TOKEN`, which `gh` prefers to `GITHUB_TOKEN`, and git's configuration through `GIT_CONFIG_*`).

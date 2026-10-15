# Credential injection

Sandboxes only ever see **placeholders**. nest-proxy swaps in real credentials on inspected traffic.

```yaml
github:
  hosts: [github.com, api.github.com, "*.githubusercontent.com"]
  placeholder: nest-ph-github-7f3a          # unique per binding
  where: [authorization.bearer, authorization.basic.password]
  source: github-app{repos: [me/app]}       # BrokerDO mints the 1-hour installation token
```

- **Substitution** happens only when the placeholder is present, and only for the binding's own hosts.
- **A placeholder sent to any other host is blocked** and raises an `egress_alert`, since it's a likely exfiltration attempt or a misconfiguration.
- **Fenced:** after the sandbox's lease or epoch expires, bindings stop substituting.
- **Defaults in the image:**
  - a git credential helper that returns `x-access-token` / the placeholder
  - `GITHUB_TOKEN=<placeholder>`

  So `git push` over HTTPS and `gh` work without a real token in the sandbox.
- **GitHub uses a GitHub App.** Installation tokens are minted per binding, scoped to the repos and permissions in its `source`, and valid for one hour.
- **Passthrough hosts can't receive injected credentials,** because their traffic isn't decrypted.
- **Reflected secrets are masked.** On a request where a credential was substituted, every occurrence of the secret (and of the exact credential header value, including the base64 of a `Basic` one) in the response headers and in an uncompressed response body is replaced with `*` of the same length, streaming, so `Content-Length` stays valid. Compressed (`content-encoding` other than identity) bodies aren't scanned.
- **TRACE/TRACK are refused** on requests carrying an injected credential (405), since they echo the request back.
- **Alerts carry the binding name** (`ProxyEvent::Alert.binding`) for `placeholder_wrong_host` and `injection_after_expiry`. Domain-fronting alerts have none.

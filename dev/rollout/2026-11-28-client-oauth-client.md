# A client's own hand-registered OAuth client (2026-11-28)

**What:** an API client's `{authorize}` mcp capability may name `oauth_client`, one of its own secrets holding a client it registered at the authorization server by hand (Google's MCP servers take neither metadata documents nor registration). Google's authorization requests also ask for offline access (`access_type=offline`, `prompt=consent`).

**Order:** the Worker only; no host is involved. An app sends `oauth_client` once this is deployed: before, it is dropped, and the start fails (409, "supports neither client ID metadata documents … nor registration"), storing nothing.

**`wrangler rollback`:**
- **Capabilities written with `oauth_client`:** the previous release reads them (`mcp` isn't strict; the field sits beside `auth`, which is) and drops the field. Its start then fails as above, so nobody reaches a consent screen.
- **Authorizations made with one:** the token record holds its client (`{"kind": "pre-registered", "secret": "client-secret:<cli>:<name>"}`), which the previous release reads as the operator's pre-registered kind. It refreshes and revokes as that client, from the same secret. Agents keep working.
- **Agent specs:** a spawn by the previous release expands the capability without the field (`oauth.client: null`), so it passes, and agents run as before: a spec's `oauth.client` isn't read at runtime (the token record's client is).
- **A capability rewritten while rolled back:** the write drops `oauth_client` but keeps the incarnation (same URL and form, as that release sees it), so the authorization goes on working. After the roll-forward, the app's next write with `oauth_client` is a new form: a new incarnation, the old authorization revoked, and the person authorizes again.
- **Google's refresh tokens:** an authorization the previous release starts asks for no offline access. For Google it lasts an hour.

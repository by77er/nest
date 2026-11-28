# A client's own hand-registered OAuth client (2026-11-28)

**What:** an API client's `{authorize}` mcp capability may name `oauth_client`, one of its own secrets holding a client it registered at the authorization server by hand (Google's MCP servers take neither metadata documents nor registration). Its JSON may carry `authorize_params` (a server's own authorization parameters, such as Google's `access_type=offline` and `prompt=consent` for a refresh token), which the app supplies: nest names no service.

**Not a one-way deploy:** no Durable Object class changes; a `wrangler rollback` is safe, with the gaps below.

**Order:** the Worker only; no host is involved. An app sends `oauth_client` once this is deployed: before, it is dropped, and the start fails (409, "supports neither client ID metadata documents … nor registration"), storing nothing.

**`wrangler rollback`:**
- **Capabilities written with `oauth_client`:** the previous release reads them (`mcp` isn't strict; the field sits beside `auth`, which is) and drops the field. Its start then fails as above, so nobody reaches a consent screen.
- **Authorizations made with one:** the token record holds its client (`{"kind": "pre-registered", "secret": "client-secret:<cli>:<name>"}`), which the previous release reads as the operator's pre-registered kind. It refreshes as that client, from the same secret, so agents keep working. Revoking the capability's authorization (`DELETE …/oauth`, or deleting the capability) revokes at the server as that client too.
- **Deleting such a client while rolled back** leaves its tokens live at the server: the previous release reads the client only after its first await, by when the client's secrets are gone. Delete or revoke its capabilities first; otherwise the person revokes the app at the service (Google: their account's third-party access page).
- **The secret guard is this release's:** the previous release lets a client delete or rewrite a secret its authorizations use, which strands their tokens at the server as above.
- **Agent specs:** a spawn by the previous release expands the capability without the field (`oauth.client: null`), so it passes, and agents run as before: a spec's `oauth.client` isn't read at runtime (the token record's client is).
- **A capability rewritten while rolled back:** the write drops `oauth_client` but keeps the incarnation (same URL and form, as that release sees it), so the authorization goes on working. After the roll-forward, the app's next write with `oauth_client` is a new form: a new incarnation, the old authorization revoked, and the person authorizes again.
- **`authorize_params`:** the previous release ignores them. An authorization it starts asks Google for no offline access, so it lasts an hour.

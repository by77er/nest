# API clients

**Decided (2026-11-02, the owner's):** external systems (an app with its own Worker and Durable Objects, such as a task board) use nest only through this interface. An app never gets the admin token, and nest gets nothing specific to any app. **An app that seems to need a special case in nest means this interface is wrong:** fix the interface, generically ([principle 9](../../../README.md#principles)).

**Built (2026-11-02):** clients and grants, ownership and visibility, labels, and the client's catalog ([ClientDO](../../durable-objects/client/), `control-plane/src/lib/clients.ts`). [GitHub tokens](#github-tokens) are built too. **Not built:** caller identity, events to the owner.

**How the built parts read the grant** (each a choice the design left open):
- **`credentials`** covers every BrokerDO secret a spec names: the model credential, an mcp capability's `auth` (and its OAuth client record), exactly. So a client can't point the operator's secret for one server at a server of its own.
- **Brokered actions:** only GitHub actions scoped to repos in `repos` are within a grant. An http profile (a URL and a credential no field covers), a fork (it widens the push allowlist) and an unscoped GitHub action are refused.
- **A client's overrides only narrow,** as an agent's spawn does (`SpawnerOverrides`): a different launch, rules or credential is a template in its namespace. A sandbox's policy layer, a brain's host, an agent's rules and share links stay the operator's (403).
- **Writes into a namespace are held to its client's grant, whoever writes them,** the operator included.
- **An mcp capability's tools are named `<client>-<entry>_<tool>`** (tool names hold no `/`). A spec where two capabilities would give the same names is refused.
- **Deleting a client is refused while anything in its subtree lives.** Then its token stops, and its namespace, name and record go.

## Clients and grants

- **A client** is a principal, `cli_<id>`, with a name (`[a-z][a-z0-9-]{1,30}`, unique) and a bearer token (`nest_cli_<id>_<secret>`). Only the token's hash is stored. The operator creates, rotates and deletes clients (`POST /v1/admin/clients {name, grant}`, which shows the token once; `POST …/<id>/rotate`; `DELETE …/<id>`). One Durable Object per client, ClientDO, holds its record, grant, webhook and event outbox.
- **A grant** is the client's ceiling. Anything it doesn't name is refused:
  - `cells`: where its agents and sandboxes may run.
  - `credentials`: the model credentials its agents may run on (e.g. `claude_oauth_token`).
  - `repos`: the repos its agents' sandboxes may push to (`owner/name`, exact).
  - `mcp_urls`: the MCP server URLs its capabilities may name (exact, or a prefix ending in `/`).
  - `github`: the repos and the GitHub App permissions it may [mint tokens](#github-tokens) for.
  - `max_agents`, `max_sandboxes`: live (not ended or destroyed) at once, across everything it owns.
- **The grant binds the whole subtree.** An agent a client creates carries its client (`client: cli_…`), and so does every agent and sandbox it spawns. Spawning, expansion and every check apply the grant, whatever template or override asked for more: a client can't widen it by writing a template.

## Ownership and visibility

- **Owner** is a principal: `user` (the operator), `cli_…`, or `agt_…`. A client owns what it creates, and transitively what those agents create.
- **A client sees and acts only on its subtree:** listing, reading, inbox and turns, approvals, stop and end, transcripts, its sandboxes. Anything else answers `404`, never `403`, so ids outside it reveal nothing.
- **The routes are the operator's, under client auth:** the same paths and bodies (`POST /v1/agents`, `POST /v1/sandboxes`, `/v1/agents/<id>/inbox`, `…/stop`, `…/asks`, …), filtered to the subtree. No route exists for one client's use only.

## Labels

- **Agents and sandboxes carry labels:** up to 16 `key: value` pairs (`[a-z][a-z0-9_.-]{0,62}`, values up to 256 characters), set by whoever creates them and fixed after. A spawner's labels are not inherited.
- **Listing filters by them** (`GET /v1/agents?label=project=x`), and the [caller identity](#caller-identity-for-mcp-servers) carries them, so a client's own server can authorize by them.

## The client's catalog

- **A client writes templates and capabilities in its own namespace,** `<client-name>/<entry>` (`PUT /v1/catalog/templates/<client-name>/<entry>`, and the same for capabilities). It reads its own entries and the operator's; it never writes outside its namespace.
- **Expansion applies the grant:** an mcp capability whose URL isn't in `mcp_urls`, a repo outside `repos`, or a credential outside `credentials` is refused when written and again at spawn.

## Caller identity for MCP servers

**Built (2026-11-02)**, except `client` and `labels`, which appear once agents carry them (the clients and labels work); the wire contract is [remote-mcp](../../../interfaces/remote-mcp/), the keys [BrokerDO](../../durable-objects/broker/#caller-identity-keys). `owner` is `user` for the operator's agents.

- **Every request** AgentDO sends to a remote MCP server ([remote-mcp](../../../interfaces/remote-mcp/)) carries `Nest-Identity: <JWT>`. It's EdDSA (Ed25519), signed by the control plane, valid for 5 minutes, with these claims:
  - `aud`: the server's URL;
  - `sub`: the agent;
  - `owner`, `client` (or absent), `labels`, `epoch`, `tainted`, `iat`, `exp`;
  - `iss`: the Worker's public base URL.
- **The connector's listing session** carries one with `sub: "nest:connector"`.
- **The public keys** are at `GET /.well-known/jwks.json`, unauthenticated, with each key's `kid`. BrokerDO holds the private keys and rotates them, publishing the next key a day before it signs.
- **Cost:** AgentDO and the connector cache a token per claim set (audience, epoch, taint, labels) for its first 4 minutes, so a call usually costs no BrokerDO round trip.
- **What it's for:** a server knows which agent is calling and what labels its creator gave it, so it can scope each agent (a worker sees only its task) without trusting the bearer token alone. This builds the deferred [OIDC token](../../../security/identity/) for MCP servers.

## Events to the owner

- **What a client receives** for every agent in its subtree:
  - `agent.turn_completed {agent, turn, text}`;
  - `agent.exited {agent, reason, text}`;
  - `agent.ask {agent, ask, question, approval?}`;
  - `agent.error {agent, code, message}`;
  - `sandbox.destroyed {sandbox}`.
- **Delivery:** to the client's webhook (`PUT /v1/clients/self/webhook {url}`, `https` only), signed with `Nest-Signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, with the event's `id` for deduplication. The secret is shown once, when the webhook is set.
- **A client never blocks an agent:**
  - An agent writes an event to its own outbox in the same step as the change, then hands it to ClientDO from its alarm.
  - ClientDO delivers from its own alarm, one request at a time:
    - each attempt is cut off after 10 s;
    - failures retry after 1 s, doubling to 5 min;
    - any non-2xx response is a failure.
  - The backlog is bounded at 10,000 events, and past that the oldest go. The number dropped is counted and shown in the client's record.
  - A client that missed events re-reads the agents' state.

## GitHub tokens

- **What a client can ask for:** `POST /v1/clients/self/github-token {repo, permissions}` returns a short-lived installation token of nest's GitHub App, for a repo in the grant's `github.repos`, with permissions within the grant's `github.permissions` (e.g. `checks: write`, `administration: write`, `pull_requests: read`).
- **How it's minted:** by BrokerDO, as for brokered actions. It's audited, and the App's private key never leaves nest.
- **Built (2026-11-02)** (`githubTokenOutsideGrant` in `control-plane/src/lib/clients.ts`, [BrokerDO](../../durable-objects/broker/) `clientGithubToken`), with these choices:
  - **The answer** is `{token, expires_at, repo, permissions}`: the repo lowercased, the permissions as asked.
  - **Permissions are repository permissions only,** each at a level GitHub offers for it (`GITHUB_REPO_PERMISSIONS` in `src/lib/github.ts`, from GitHub's [REST description](https://github.com/github/rest-api-description)'s `app-permissions`). Organization and account permissions are never minted: a token for one repo would still carry them. A request names at least one, since GitHub gives a token naming none every permission the installation has ([GitHub](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). The same rule validates the grant's `github.permissions` at `POST` and `PATCH /v1/admin/clients`.
  - **Within the grant:** the repo is in `github.repos` (exact, compared without case: GitHub's names are case-insensitive), and each permission is in `github.permissions` at the same or a lower level (`read` < `write` < `admin`). The token gets exactly the permissions asked for, not the grant's.
  - **Answers:** outside the grant, `403`; a name not in the list, another case or a look-alike character, a level GitHub doesn't offer, or no permission, `400`. Neither mints. GitHub's own refusal (the App isn't installed on the repo, or lacks a permission) is passed on and audited.
  - **Who:** only a client token has a `self`: the operator's token is `403`, and a deleted client's or a rotated-out token `401`.
  - **Reuse:** a token is cached per client, repo and permissions, and handed out again while it has 10 minutes left; it is never shared with another client or an agent's action. Narrowing the grant applies to the next request; a token already handed out lasts until it expires (an hour at most). nest doesn't [revoke](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token) it.
- **The webhook:** the App's single webhook goes to whichever app the operator points it at (nest itself consumes none).

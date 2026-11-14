# API clients

**Decided (2026-11-02, the owner's):** external systems (an app with its own Worker and Durable Objects, such as a task board) use nest only through this interface. An app never gets the admin token, and nest gets nothing specific to any app. **An app that seems to need a special case in nest means this interface is wrong:** fix the interface, generically ([principle 9](../../../README.md#principles)).

**Built (2026-11-02), all of it:** clients and grants (with [read-only repos](../../../sandbox/networking/egress/policy/#read-only-repos)), ownership and visibility, labels, the client's catalog ([ClientDO](../../durable-objects/client/), `control-plane/src/lib/clients.ts`), [caller identity](#caller-identity-for-mcp-servers) (`control-plane/src/lib/identity.ts`), [events to the owner](#events-to-the-owner) (`control-plane/src/lib/client-events.ts`), the [live trace](#live-trace) (`control-plane/src/lib/trace.ts`), [GitHub tokens](#github-tokens), and `GET /v1/clients/self`. **Built (2026-11-02, later):** [secrets](#secrets), [injection](#injection) and [workflow files](#workflow-files). **Built (2026-11-12):** [request guards](#request-guards).

**Moving out (decided 2026-11-12, not built):** the GitHub parts of this interface (the grant's `repos`, `read_repos`, `github`, `repo_owners` and `github_push`, [owner-wide entries](#owner-wide-entries), [GitHub tokens](#github-tokens), `/grant/repos`, `github_app` and [workflow files](#workflow-files)) leave the kernel. An app does the same on generic primitives: its own GitHub App, its tokens as [secrets](#secrets) that expire and are pushed on write, and its own request guards ([principle 10](../../../README.md#principles)). Until then they describe what runs.

**How the built parts read the grant** (each a choice the design left open):
- **`credentials`** covers every BrokerDO secret a spec names: the model credential, an mcp capability's `auth` (and its OAuth client record), exactly. The model credential is checked again at each brain start against the grant as it is then, and a client's agent runs only on that credential: if it isn't stored (or has expired) the start is refused, never moved to the operator's default token ([BrokerDO](../../durable-objects/broker/), 2026-11-06). So a client can't point the operator's secret for one server at a server of its own. A capability with [no bearer](../../../agents/capabilities/mcp/#no-bearer) names no secret, so it needs none here (2026-11-02).
- **Brokered actions:** only GitHub actions scoped to repos in `repos` are within a grant. An http profile (a URL and a credential no field covers), a fork (it widens the push allowlist) and an unscoped GitHub action are refused.
- **A client's overrides only narrow,** as an agent's spawn does (`SpawnerOverrides`): a different launch, rules or credential is a template in its namespace. A sandbox's policy layer, a brain's host, an agent's rules and share links stay the operator's: a client's route that carries one refuses it (`policy` in `POST /v1/sandboxes`, `host` in `…/start`: 403), and their own routes (`PUT /v1/sandboxes/<id>/policy`, `PUT|DELETE /v1/agents/<id>/rules`, `…/ports`) take only the admin token (401).
- **Writes into a namespace are held to its client's grant, whoever writes them,** the operator included.
- **An mcp capability's tools are named `<client>-<entry>_<tool>`** (tool names hold no `/`). A spec where two capabilities would give the same names is refused.
- **Deleting a client is refused while anything in its subtree lives.** Then its token stops, and its namespace and record go. Its name is held for 15 minutes (the answer's `name_free_ms`), and the cleanup runs once more before the name is free, so a request that was in flight across the delete leaves nothing a later client of that name inherits ([names](../../durable-objects/client/)).

## Clients and grants

- **A client** is a principal, `cli_<id>`, with a name (`[a-z][a-z0-9-]{1,30}`, unique) and a bearer token (`nest_cli_<id>_<secret>`). Only the token's hash is stored. The operator creates, rotates and deletes clients (`POST /v1/admin/clients {name, grant}`, which shows the token once; `POST …/<id>/rotate`; `DELETE …/<id>`). One Durable Object per client, ClientDO, holds its record, grant, webhook and event outbox.
- **A grant** is the client's ceiling. Anything it doesn't name is refused:
  - `cells`: where its agents and sandboxes may run.
  - `credentials`: the model credentials its agents may run on (e.g. `claude_oauth_token`).
  - `repos`: the repos its agents' sandboxes may push to: `owner/name` exactly, or `owner/*`, every repo of one GitHub account ([owner-wide entries](#owner-wide-entries)).
  - `read_repos`: the repos they may only read ([read-only repos](../../../sandbox/networking/egress/policy/#read-only-repos), 2026-11-02). A spec may read any repo in `repos` or `read_repos`, and push only to `repos`. Exact or owner-wide, as `repos`. A grant stored before it reads as none.
  - `mcp_urls`: the MCP server URLs its capabilities may name (exact, or a prefix ending in `/`).
  - `github`: the repos (exact or owner-wide) and the GitHub App permissions it may [mint tokens](#github-tokens) for.
  - `repo_owners`: written by nest, never by the operator: each owner-wide entry's login and the GitHub account id it was bound to ([owner-wide entries](#owner-wide-entries)).
  - `secrets`: `{max_count, max_bytes}`, how many [secrets](#secrets) it may store and how big each may be (default `{0, 4096}`: none).
  - `inject_hosts`: the hosts its secrets may be [injected](#injection) into: exact names, or `*.` and a name of two or more labels (`*.example.com`, never `*.com`), lowercase. No address in any numeric form a resolver accepts (`1.2.3.4`, `127.0.0.0x1`, `0x7f.0x1`): a top-level label must start with a letter. nest has no public-suffix list, so a wildcard like `*.co.uk` is refused only by the operator not granting it: the operator's grant is the gate. Default none.
  - `github_push`: `{workflows}`, whether its specs may ask for [`workflows: write`](#workflow-files) on their sandboxes' push token. Default absent: no.
  - `egress_hosts`: the hosts its own [egress rules](#egress) may allow, named as `inject_hosts` are. Default none.
  - A grant stored before `secrets`, `inject_hosts`, `github_push` or `egress_hosts` reads as none of each.
  - `max_agents`, `max_sandboxes`: live (not ended or destroyed) at once, across everything it owns. A create over one is refused with `429 at_capacity`, `retryable: true`, the message starting with the limit (`max_agents: …`): there is room once fewer than the maximum are live (more than one end, if the grant was lowered below the live count). A maximum of 0 is `403 forbidden`, as for anything else outside the grant.
### Owner-wide entries

**Built 2026-11-10 (the owner approved the design):** `repos`, `read_repos` and `github.repos` may name `owner/*`, so a new repo of that account is in the grant without the operator adding it. Code: `inGrantList`, `ownerLookups` and `githubTokenOwners` in `control-plane/src/lib/clients.ts`; [BrokerDO](../../durable-objects/broker/)'s `githubAccountId`, `repoOwners` and owner-checked mint.
- **Only in a client's grant.** A template, a spawn spec and an override name exact repos (`owner/*` there is a 400), so a sandbox's push allowlist is exactly the repos its spec names, each checked against the grant.
- **Bound to an account id, not a login.** A login can be renamed and registered again by someone else. When the operator writes the grant (`POST /v1/admin/clients`, `PATCH …/<id>`), nest resolves each new login to the account's numeric GitHub id, through the App's installation on it or else its public profile, and stores it in `repo_owners`. A login GitHub doesn't know refuses the write (409); one it couldn't confirm now (no answer, or its anonymous rate limit) answers 502 or 503, retryable; nothing is saved either way. The answer shows each bound id in `grant.repo_owners`, so the operator can check it is the right account (`https://api.github.com/user/<id>`). A login the stored grant already has keeps its id on every later write (resolving it again could pick up another account that took the login). To bind a login afresh, write the grant without the entry, then with it. What a request sends as `repo_owners` is ignored.
- **Only names under a bound account are ever asked about.** nest keeps each bound account's current login (5 minutes; from the App's installations, else `GET /user/{id}`), and looks up only repos whose owner part is one of them. Any other name is outside with no GitHub call, so a client can't spend the App's rate limit (shared by every client and sandbox) on names that couldn't match. A renamed account is followed when its login is next read. On top, each client has a budget of 600 GitHub calls an hour for its owner-wide entries, and all clients together 2,000 (well under the App's own limit, so token mints and pushes keep the rest); each call is reserved, for the client and for all clients, in the same synchronous step as it leaves (so concurrent requests can't pass a spent budget), a listing's pages and mint included; its revoke is counted but never stopped. Past either, nest answers 429 (retryable) and asks GitHub nothing. A login GitHub didn't give (no such account, or no answer) is asked again after a minute.
- **Matched by GitHub's answer, by id.** A repo is in an owner-wide entry only if GitHub says the account with that id owns it now: the account of the App's installation on the repo, or else, for a public repo the App isn't on, the repo's `owner.id`. Never by the repo's name: a renamed account's repos still match under the new login, and a repo under the old login now held by someone else doesn't. A repo GitHub can't confirm (not found, private and the App not installed, a redirect) is outside. A grant of exact entries asks GitHub nothing. **The public fallback fails closed:** the reads without the App (`GET /repos/{owner}/{repo}`, `GET /users/{login}`) are GitHub's unauthenticated API, limited to 60 requests an hour per address ([GitHub](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-unauthenticated-users); whether Workers' egress shares an address with other tenants is unverified). A refused or rate-limited read can refuse a repo spuriously (a template write or spawn, 403) or fail the request (502 or 503, retryable), never admit one; repos on an account the App is installed on never need it.
- **Where it applies:** spawning and template and capability writes (`specOutsideGrant`, `capabilityOutsideGrant`: push, read, and the repos a brokered GitHub action is scoped to), [GitHub tokens](#github-tokens) and the membership route below. An unscoped GitHub action stays outside: an owner-wide entry is one account's repos, not any repo. Answers are kept 5 minutes (a miss 1 minute) in BrokerDO, so a spawn doesn't ask GitHub each time; an owner's change shows within that.
- **Tokens use GitHub's answer at the mint:** for a repo not named exactly, BrokerDO looks the repo's installation up afresh (never from its cache) and mints from it only if its account is one the grant's owner-wide `github.repos` entries are bound to; otherwise 403 and nothing is minted. Every "not owned" outcome (not under a bound login, not found, moved) is the same 403, which says nothing of whether the repo exists; GitHub not answering (no answer, its primary rate limit: 403 or 429 with `x-ratelimit-remaining: 0`), for the repo or for a bound account's login, is a retryable 503, which says nothing either. A cached token is served only while its installation's account is one of them.
- **Listing:** `GET /v1/clients/self/grant/repos` answers `{repos: [{repo, push, read, github}], unlisted, complete}`: every exact entry, and for each owner-wide entry the repos of that account the App's installation reaches (each confirmed as the account's by GitHub's answer). BrokerDO reads them with a token for the whole installation, `metadata: read` only, audited as covering all its repos (`all_repos: true`) before it's used, never handed out, and revoked after (also when its audit record can't be written, in which case it's never used); the list is kept 5 minutes. An owner-wide entry for an account the App isn't on can't be listed (`unlisted`; the POST below still answers for a repo by name). `complete` is false past 1000 repos of one account.
- **Membership, without copying the rule:** `POST /v1/clients/self/grant/repos {repos: [owner/name, …]}` (at most 100) answers `{repos: [{repo, push, read, github}]}`: whether each repo is in `repos`, in `repos` or `read_repos`, and in `github.repos`, decided as above. `GET /v1/clients/self` shows the grant as stored, owner-wide entries and `repo_owners` included.
- **After admission a repo is a name.** A spec's repos are checked when it's written and at spawn; the sandbox's push tokens are then minted for those names as for any exact entry. An account that renames away and whose login is taken over afterwards is the same exposure an exact entry has today (open: re-checking a live sandbox's repos' owners).

- **The grant binds the whole subtree.** An agent a client creates carries its client (`client: cli_…`), and so does every agent and sandbox it spawns. Spawning, expansion and every check apply the grant, whatever template or override asked for more: a client can't widen it by writing a template.

## Ownership and visibility

- **Owner** is a principal: `user` (the operator), `cli_…`, or `agt_…`. A client owns what it creates, and transitively what those agents create.
- **A client sees and acts only on its subtree:** listing, reading, inbox and turns, approvals, stop and end, transcripts and live traces, its sandboxes. Anything else answers `404`, never `403`, so ids outside it reveal nothing.
- **The routes are the operator's, under client auth:** the same paths and bodies, filtered to the subtree ([the list](#routes)). No route exists for one client's use only; the `/v1/clients/self/…` routes are every client's own (the operator has no `self`).
- **No `?cell=`** on any of them but a listing's filter: a cell goes in a create's body, and everything else reaches its object by id ([which routes take a cell](../#which-routes-take-a-cell), 2026-11-02).
- **Creates take an `Idempotency-Key`**, scoped to the client ([idempotency keys](../#idempotency-keys), 2026-11-02).

## Routes

Every route a client's token reaches: the `owner` routes of `control-plane/src/index.ts`. `test/routes.test.ts` checks this table against them both ways, so a route added for clients and not listed here fails it. Every other route takes the admin token (a client's is 401), a host's, or none: the public ones are `GET /v1/health`, `GET /.well-known/jwks.json`, [MCP OAuth](../../../agents/capabilities/mcp/#oauth)'s callback and client document, host enrollment and blobs (`NOT_ADMIN` in that test).

The checks:
- **Subtree:** the agent or sandbox is the caller's (its `client` is the caller's id). Any other id answers 404, as an unknown one does. The operator passes any.
- **Namespace:** `<ns>` is the client's own name. Another name is 403 without a lookup, so it reveals nothing. The operator passes any client's namespace (404 for a name no client has).
- **Self:** a client's token only; the operator's is 403.

| Method | Path | Check |
| --- | --- | --- |
| `POST` | `/v1/agents` | Within the grant (`cells`, `credentials`, `repos`, `read_repos`, `mcp_urls`, `max_agents`, …): the [catalog](#the-clients-catalog) expands its template with it. A `sandbox` or `owner` agent it names is subtree (404). `overrides` only narrow; `launch` and `rules` are the operator's (400). `grants` are confined to the subtree; an agent id in one is subtree (404) ([grants to its agents](#grants-to-its-agents)). |
| `GET` | `/v1/agents` | Its own registry only (ClientDO), whatever `?client=` says. |
| `GET` | `/v1/agents/<agent>` | Subtree. |
| `GET` | `/v1/agents/<agent>/turns` | Subtree. |
| `POST` | `/v1/agents/<agent>/turns` | Subtree. |
| `GET` | `/v1/agents/<agent>/transcript` | Subtree. |
| `GET` | `/v1/agents/<agent>/trace` | Subtree ([live trace](#live-trace)). |
| `GET` | `/v1/agents/<agent>/trace/history` | Subtree. |
| `POST` | `/v1/agents/<agent>/inbox` | Subtree. `from` defaults to the client's id. Any other is a label of its own ([inbox senders](#inbox-senders)): never one of nest's senders or a principal's id (403), shown with the client's id, and it taints the session. An ended agent refuses it (404). |
| `POST` | `/v1/agents/<agent>/interrupt` | Subtree. |
| `POST` | `/v1/agents/<agent>/start` | Subtree. `host` is the operator's (403). With `restart: true`, `launch: {model?, effort?}` restarts the brain on them, resuming its session, and `when: "idle"` only between turns (else `409 busy`) ([restarting on another model](../#restarting-on-another-model)). |
| `POST` | `/v1/agents/<agent>/stop` | Subtree. `destroy_sandbox` (with `end: true`) destroys the agent's sandbox if the client could `DELETE` it (one in its subtree, such as one it created) or it was made for that agent, and only if nothing else is attached when its end detaches it. Without `destroy_sandbox`, an ephemeral agent's end destroys only a sandbox made for it. |
| `GET` | `/v1/agents/<agent>/children` | Subtree. |
| `GET` | `/v1/agents/<agent>/brokered` | Subtree. |
| `GET` | `/v1/agents/<agent>/asks` | Subtree. |
| `POST` | `/v1/agents/<agent>/asks/<ask>/answer` | Subtree. |
| `GET` | `/v1/asks` | Its own registry's live agents only, as for `GET /v1/agents` ([open asks across agents](../#open-asks-across-agents)). |
| `GET` | `/v1/agents/<agent>/timers` | Subtree ([timers](#timers)). |
| `DELETE` | `/v1/agents/<agent>/timers/<name>` | Subtree. |
| `POST` | `/v1/sandboxes` | Within the grant (`cells`, `max_sandboxes`, `inject_hosts`, `egress_hosts`, `github_push`, its own secrets). `policy` is the operator's (403). `guards` need no grant, only the sandbox's bounds (400) ([request guards](#request-guards)). |
| `GET` | `/v1/sandboxes` | Its own registry only, as for agents. |
| `GET` | `/v1/sandboxes/<sandbox>` | Subtree. |
| `DELETE` | `/v1/sandboxes/<sandbox>` | Subtree. Destroys it whatever is attached. |
| `PUT` | `/v1/sandboxes/<sandbox>/lifetime` | Subtree. `idle_ttl_ms` is at least a minute, with no ceiling: `max_sandboxes` bounds what a client keeps. |
| `GET` | `/v1/sandboxes/<sandbox>/policy` | Subtree. The effective policy, the operator's layer included: hosts, rules and bindings' placeholders, never a secret's value. |
| `GET` | `/v1/sandboxes/<sandbox>/client-policy` | Subtree ([the client layer](#the-client-layer)). |
| `PUT` | `/v1/sandboxes/<sandbox>/client-policy` | Subtree. Within its client's grant as it is now (`github_push.workflows` too). `guards` need no grant, only the sandbox's bounds (400). |
| `GET` | `/v1/catalog` | The operator's entries and its own namespace's. |
| `GET` | `/v1/catalog/templates/<ns>/<entry>` | Namespace. |
| `PUT` | `/v1/catalog/templates/<ns>/<entry>` | Namespace. Within the grant, when written and again at spawn. Its `launch.model` and `launch.effort` are [plain tokens](../../durable-objects/catalog/) (400). |
| `DELETE` | `/v1/catalog/templates/<ns>/<entry>` | Namespace. |
| `GET` | `/v1/catalog/capabilities/<ns>/<entry>` | Namespace. |
| `PUT` | `/v1/catalog/capabilities/<ns>/<entry>` | Namespace. Within the grant (`mcp_urls`, `credentials`, brokered actions). Its `rules` reach the live agents of its subtree that list it ([live rules](../../durable-objects/catalog/#live-rules)); a refused write reaches none. |
| `DELETE` | `/v1/catalog/capabilities/<ns>/<entry>` | Namespace. The live agents that read its rules have none of them from then on. |
| `GET` | `/v1/clients/self` | Self. |
| `PUT` | `/v1/clients/self/webhook` | Self ([events](#events-to-the-owner)). |
| `POST` | `/v1/clients/self/github-token` | Self. Within `github` ([GitHub tokens](#github-tokens)). |
| `GET` | `/v1/clients/self/grant/repos` | Self. The repos the grant covers that nest can list ([owner-wide entries](#owner-wide-entries)). |
| `POST` | `/v1/clients/self/grant/repos` | Self. Which repos the grant covers ([owner-wide entries](#owner-wide-entries)). |
| `GET` | `/v1/clients/self/secrets` | Self ([secrets](#secrets)). |
| `PUT` | `/v1/clients/self/secrets/<name>` | Self. Within `secrets`. |
| `DELETE` | `/v1/clients/self/secrets/<name>` | Self. |

## Grants to its agents

**Built (2026-11-06):** a client confers [transcript grants](../../../agents/tools/#built-transcript-grants-2026-11-06) on an agent it creates, so that agent can read agents it doesn't own: its siblings in the client's subtree. A client holds read on its whole subtree (its owner auth), so it may confer any such grant, and only over its subtree.

```json
POST /v1/agents
{"template": "<ns>/<entry>", "labels": {"project": "prj_x", "role": "dreaming"},
 "grants": [{"action": "read_transcript", "resource": "agent{project=prj_x}",
             "limits": {"max_age_ms": 604800000, "max_entries": 200}, "expires_ms": 1794000000000}]}
```

- `grants` takes up to 16 entries of `{action, resource, limits?, expires_ms?}`. Any other field, an unknown limit, an unparsable resource or a past `expires_ms` is 400; a list of tool names (the field's meaning before grants) is 400 too. An agent id that isn't in the subtree is 404.
- **Confined to the subtree:** the grant reaches only agents of this client, whatever their labels. The client's other agents with matching labels are covered, including ones created later.
- **The agent sees them** as `grants` in `GET /v1/agents/<id>` (each with its `id`, `scope` and `parent`), and gets `read_transcript` and `list` as tools whatever its template gives. It may pass a narrower one to an agent it spawns (`agent_spawn{grants}`).
- **They can't be revoked one by one yet:** no route or tool revokes a single grant. One ends only at its `expires_ms`, when its holder ends, when the client is deleted, or, for a grant an agent passed on, when that agent ends. To take one back early, end the agent holding it.

## Inbox senders

**Decided (2026-11-02):** a message's `from` is who the model reads it as from (`Message from <from>: …` as a turn, `[message from <from>]` mid-turn), so a client names only a label of its own, and the message says which client sent it (`control-plane/src/lib/senders.ts`).
- **A client's post** (`POST /v1/agents/<id>/inbox`) is from its own id when it names no `from`, or names its id. Any other `from` shows as `<from> (via client <cli>)` and taints the session, as a relay.
- **A label** is 1-64 letters, digits, spaces and `. _ / @ + -`, starting with a letter or digit (400 otherwise). It has no `:`, brackets, parentheses or line breaks, so it can't forge a spawner's name, the `via` mark, or a new message in the runner's text.
- **Refused (403):** nest's own senders, in any case: `system` (the platform's notes), `timer` (a fired timer) and `user` (the operator's default). Also any label holding a principal's id (`agt_`, `cli_`, `sbx_`, `hst_`), which covers a spawner's `<template>:<agent>` and another client's id.
- **The operator and nest name any sender.**
- **Every post through the API is input,** whatever its `from`: it clears a stop's `stop_quiet`. Only nest's own notes (a sandbox move, a background task's exit) aren't ([AgentDO](../../durable-objects/agent/)).
- **An ended agent refuses every post** (404, `unknown_agent`), whatever its `from`. nest's own notes to it are dropped.

## Labels

- **Agents and sandboxes carry labels:** up to 16 `key: value` pairs (`[a-z][a-z0-9_.-]{0,62}`, values up to 256 characters), set by whoever creates them and fixed after. A spawner's labels are not inherited.
- **Listing filters by them** (`GET /v1/agents?label=project=x`), and the [caller identity](#caller-identity-for-mcp-servers) carries them, so a client's own server can authorize by them.

## The client's catalog

- **A client writes templates and capabilities in its own namespace,** `<client-name>/<entry>` (`PUT /v1/catalog/templates/<client-name>/<entry>`, and the same for capabilities). It reads its own entries and the operator's; it never writes outside its namespace.
- **Its capabilities' rules are read live** by the agents of its subtree, after their spawner's narrowing ([live rules](../../durable-objects/catalog/#live-rules)). Rules decide only whether a call the agent's spec already gives waits for an approval, which the client answers for its own subtree, so the grant doesn't limit them; an operator's agent spawned from the client's template outside the client's subtree keeps them as at spawn.
- **Expansion applies the grant:** an mcp capability whose URL isn't in `mcp_urls`, a repo to push to outside `repos`, a repo to read outside `repos` and `read_repos`, or a credential outside `credentials` is refused when written and again at spawn. A client's `overrides.read_repos` narrows a template's read-only repos as `overrides.repos` narrows its allowlist, and may move a repo from the allowlist to the read list (less access), never back.

## Caller identity for MCP servers

**Built (2026-11-02)**, `client` and `labels` included: AgentDO names them from its record (`AgentDO.identitySubject`). The wire contract is [remote-mcp](../../../interfaces/remote-mcp/), the keys [BrokerDO](../../durable-objects/broker/#caller-identity-keys). `owner` is `user` for the operator's agents.

- **Every request** AgentDO sends to a remote MCP server ([remote-mcp](../../../interfaces/remote-mcp/)) carries `Nest-Identity: <JWT>`. It's EdDSA (Ed25519), signed by the control plane, valid for 5 minutes, with these claims:
  - `aud`: the server's URL;
  - `sub`: the agent;
  - `owner`, `client` (or absent), `labels`, `epoch`, `tainted`, `iat`, `exp`;
  - `iss`: the Worker's public base URL.
- **The connector's listing session** carries one with `sub: "nest:connector"`, and `client` when the capability is in a client's namespace: such a capability has a connector of its own ([the connector](../../../agents/capabilities/mcp/#the-connector), 2026-11-02). An operator's capability's listing names no client, even when a client's agent uses it: its list is shared.
- **The public keys** are at `GET /.well-known/jwks.json`, unauthenticated, with each key's `kid`. BrokerDO holds the private keys and rotates them, publishing the next key a day before it signs.
- **Cost:** AgentDO and the connector cache a token per claim set (audience, epoch, taint, labels) for its first 4 minutes, so a call usually costs no BrokerDO round trip.
- **What it's for:** a server knows which agent is calling and what labels its creator gave it, so it can scope each agent (a worker sees only its task) without trusting the bearer token alone, or with no bearer at all ([no bearer](../../../agents/capabilities/mcp/#no-bearer)). This builds the deferred [OIDC token](../../../security/identity/) for MCP servers.

## Events to the owner

- **What a client receives** for every agent in its subtree:
  - `agent.turn_completed {agent, turn, text}`;
  - `agent.exited {agent, reason, text}`;
  - `agent.ask {agent, ask, question, approval?}`;
  - `agent.error {agent, code, message}` (`start_refused`: every start refused for good that leaves the agent `errored`, whatever the cause, with the reason in `message`; a refusal while a brain still runs sends none (a credential the grant no longer names or that isn't stored, say); `restart_refused`: a restart given up after 5 retryable failures in a row while its brain still runs; `errored`: its brain kept failing; or the runner's own error code);
  - `agent.timer_fired {agent, timer, note}` ([timers](#timers));
  - `sandbox.destroyed {sandbox}`.
- **Delivery:** to the client's webhook (`PUT /v1/clients/self/webhook {url}`, `https` only), signed with `Nest-Signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, with the event's `id` for deduplication. The secret is shown once, when the webhook is set.
- **A client never blocks an agent:**
  - An agent writes an event to its own outbox in the same step as the change, then hands it to ClientDO from its alarm.
  - ClientDO delivers from its own alarm, one request at a time:
    - each attempt is cut off after 10 s;
    - failures retry after 1 s, doubling to 5 min;
    - any non-2xx response is a failure.
  - The backlog is bounded at 10,000 events, and past that the oldest go. An event that has waited 7 days undelivered goes too. The 7 days are the current default (`EVENT_MAX_AGE_MS`), chosen to match the other tables' retention and not yet confirmed by the owner; the reasoning is that a receiver down that long has missed more than a replay would mend, and nothing should wait for ever. An event being sent at that moment is never dropped by the cap (the age drop runs between attempts). The number dropped, either way, is counted and shown in the client's record.
  - A client that missed events re-reads the agents' state.

**How the build settled what the design left open (2026-11-02):**
- **Where each event comes from** (AgentDO and SandboxDO write it in the step of the change):
  - `turn_completed`: a turn the runner completed. `text` is the turn's last `assistant_text` event (Claude Code's last text block), else empty.
  - `exited`: once the agent's end is done (as its registry hears it). `reason` is the end's (`exited`, `done`, `stopped`, `owner_ended`); `text` the note it was given (`exit`'s or `agent_stop`'s `reason`), else its last assistant text.
  - `ask`: every ask held for the owner (a sink approval, or a tool rule in `ask` mode); `approval` is `{name, tool}`, as `GET …/asks` lists it.
  - `error`: a runner `error` event (a Claude Code result that failed: `code` is its subtype), or the agent becoming `errored` (its brain couldn't start or kept exiting; `code: "errored"`).
  - `sandbox.destroyed`: once, at the destroy decision.
  - `text` is clipped to 16 KiB and `message` to 2 KiB (UTF-8).
- **The body** is the event as JSON: `{id, type, …fields}`. The `id` is opaque and fixed when the event is written, so every hand-off and every attempt carries the same one. Delivery is at least once: a client dedups by `id`. Order is the order ClientDO received them, which is each agent's own order.
- **The signing key** is the secret's UTF-8 bytes (`whsec_<64 hex>`). Setting the webhook again replaces the secret and sends what waits to the new URL at once.
- **No webhook set:** events are dropped on arrival (nobody would hear them), not queued for later.
- **Redirects aren't followed** (a 3xx is a failure). The retry wait runs from the failure, so an attempt cut off at 10 s is retried 1 s after that.
- **The record** shows `events: {webhook, backlog, dropped, failures, last_error}`, never the secret: the client reads its own with `GET /v1/clients/self` (its grant and live counts too), so it sees when `dropped` rises; the operator with `GET /v1/admin/clients/<id>`.

## Live trace

**Built (2026-11-02):** a client watches an agent in its subtree as it works with `GET /v1/agents/<id>/trace?after=<seq>`, a WebSocket that AgentDO holds hibernated. The message shape, resume (`after`, and the `gap` when the ring no longer reaches back), bounds, redaction and keepalive are the same for the operator: see [live trace](../#live-trace).
- **Who:** the client's token, on its own subtree; any other agent answers 404, as an unknown one does. An agent's caller identity and host tokens are refused (401).
- **From a browser:** the client's own Worker checks its user, connects with the client token (`fetch` with `Upgrade: websocket` and `Authorization`), and returns the socket. The token never reaches the browser, and the app holds no state for it.
- **Never in an agent's way:** sends are fire-and-forget after the event is recorded, a failed send closes that socket, and at most 8 trace sockets per agent are open (the oldest closes). A client that falls behind reconnects with `after`.
- **History:** `GET /v1/agents/<id>/trace/history?before=<cursor>` gives the older events from the stored transcript, in the same shape, for what the ring doesn't hold; the trace's `history` and `gap` messages carry the cursor to start from ([trace history](../#trace-history)). Same auth.
- **Events vs. trace:** [events to the owner](#events-to-the-owner) are durable and delivered at least once, for acting on; the trace is for watching, and a client that wasn't connected reads what it missed from the ring or the transcript.

## GitHub tokens

- **What a client can ask for:** `POST /v1/clients/self/github-token {repo, permissions}` returns a short-lived installation token of nest's GitHub App, for a repo in the grant's `github.repos`, with permissions within the grant's `github.permissions` (e.g. `checks: write`, `administration: write`, `pull_requests: read`).
- **How it's minted:** by BrokerDO, as for brokered actions. It's audited, and the App's private key never leaves nest.
- **Built (2026-11-02)** (`githubTokenOutsideGrant` in `control-plane/src/lib/clients.ts`, [BrokerDO](../../durable-objects/broker/) `clientGithubToken`), with these choices:
  - **The answer** is `{token, expires_at, repo, permissions, installation_id, app_id, app_slug}`: the repo lowercased, the permissions as asked, the App the token is from (below), and `installation_id`, GitHub's numeric id of the App's installation the token was minted from (added 2026-11-10). An installation token can't look its own installation up (`GET /repos/{owner}/{repo}/installation` takes the App's JWT), so a client that needs it (e.g. to name the installation in a webhook check) reads it here. It is always the token's own: a cached token answers the installation it was minted from, and a token minted after the cached installation proved stale answers the new one. It is absent only from a BrokerDO still on the previous release in the minutes of a deploy.
  - **Permissions are repository permissions only,** each at a level GitHub offers for it (`GITHUB_REPO_PERMISSIONS` in `src/lib/github.ts`, from GitHub's [REST description](https://github.com/github/rest-api-description)'s `app-permissions`). Organization and account permissions are never minted: a token for one repo would still carry them. A request names at least one, since GitHub gives a token naming none every permission the installation has ([GitHub](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)). The same rule validates the grant's `github.permissions` at `POST` and `PATCH /v1/admin/clients`.
  - **Within the grant:** the repo is in `github.repos` (exact, compared without case: GitHub's names are case-insensitive; or under an [owner-wide entry](#owner-wide-entries), confirmed at the mint), and each permission is in `github.permissions` at the same or a lower level (`read` < `write` < `admin`). The token gets exactly the permissions asked for, not the grant's.
  - **Answers:** outside the grant, `403`; a name not in the list, another case or a look-alike character, a level GitHub doesn't offer, or no permission, `400`. Neither mints. GitHub's own refusal (the App isn't installed on the repo, or lacks a permission) is passed on and audited.
  - **Who:** only a client token has a `self`: the operator's token is `403`, and a deleted client's or a rotated-out token `401`.
  - **Reuse:** a token is cached per client, repo and permissions, and handed out again while it has 10 minutes left; it is never shared with another client or an agent's action. Narrowing the grant applies to the next request; a token already handed out lasts until it expires (an hour at most). nest doesn't [revoke](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token) it.
- **The App's identity (2026-11-02):** `app_id` (GitHub's numeric App id) and `app_slug`, in each token's answer and as `github_app: {app_id, app_slug}` in `GET /v1/clients/self` when the grant has `github`. A client pins a required status check to the App with it (branch protection's `checks[].app_id`, [GitHub](https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection)), so no other app or commit status satisfies the check, without first creating a check run to learn it. Not a secret: it is on the App's public page. BrokerDO reads it from `GET /app` and keeps it a day ([BrokerDO](../../durable-objects/broker/)). `app_slug` is absent when GitHub didn't answer and none was read before, and both when nest can't tell (no App configured, or GitHub silent, none read before, and only the App's client id configured); a token's answer goes out either way.
- **The webhook:** the App's single webhook goes to whichever app the operator points it at (nest itself consumes none).

## Secrets

**Decided (2026-11-02, the owner's):** credentials never enter a sandbox. What an agent sends itself gets its credential injected at the egress proxy ([injection](#injection)); what CI/CD needs is the owner's to populate (agents ask for it). So an app keeps its own credentials in nest, write-only, and names them in bindings.
- **Routes,** with a client token only (the operator's has no `self`: 403):
  - `PUT /v1/clients/self/secrets/<name> {"value": "…", "description"?: "…", "expires_at"?: "…"}` stores or replaces one. Answers its metadata.
  - `DELETE /v1/clients/self/secrets/<name>`: 404 when there is none.
  - `GET /v1/clients/self/secrets` answers `{"secrets": [{name, description, size, created_ms, updated_ms, last_injected_ms, expires_ms, sandboxes}]}`, by name. The operator reads the same with `GET /v1/admin/clients/<cli>/secrets`.
- **Expiry** (built 2026-11-12): `expires_at` is an RFC 3339 time with an offset (GitHub's token `expires_at` as it comes); one already past is 400. From then on the value is never handed out, and each push carries it (`expires_ms`, read with the value when the push is sent), so nest-proxy refuses the placeholder at that moment (`injection_unavailable`), between pushes too. A write without it never expires, a replacement included: an app refreshing a short-lived token writes the new value and expiry together. An expired secret stays listed, with its `expires_ms`, and keeps its place in `max_count` until replaced or deleted.
- **Pushed on write** (built 2026-11-12): a write or delete reaches every sandbox that asked for the secret at its last push (`sandboxes`, its binding's secret whether stored then or not) within seconds, through BrokerDO's [client secret pushes](../../durable-objects/broker/#client-secret-pushes). A destroyed sandbox stops counting at its destroy. The 15-minute push stays as the backstop.
- **A name** is `[a-z][a-z0-9_-]{0,62}`. It lives under the client's id alone (BrokerDO's `client-secret:<cli>:<name>`), so no client can name another's secret, and nothing a client sends names an operator secret. The admin secrets route refuses the `client-secret:` prefix (403): the operator can't write one by name either.
- **Values are write-only:** never answered, logged or audited. `size` is the value's UTF-8 bytes; `last_injected_ms` is when it was last handed to a sandbox's proxy (null before), not when a request used it.
- **Within the grant:** at most `secrets.max_count` (a replacement takes no new place), each at most `secrets.max_bytes`; outside it, 403. Counted and written in one step of BrokerDO, so two writes can't both take the last place.
- **Audited** (BrokerDO's [issuance audit](../../durable-objects/broker/#issuance-audit), never a value): `client_secret_put` (`client`, `secret`, `size`, `replaced`, `expires_ms` when given), `client_secret_deleted`, `client_secrets_deleted` (a client's delete), and every injection (below). A write's record is written in the background; an injection's is written before the reference is handed out.
- **Deleting the client** deletes its secrets.

## Injection

A client's bindings put its secrets into its own sandboxes' requests at nest-proxy, as the operator's do ([credential injection](../../../sandbox/networking/egress/injection/)). The sandbox sees only a placeholder.
- **The shape** (`ClientInjection` in `control-plane/src/lib/client-secrets.ts`): the existing binding's `name`, `hosts` and `locations`, plus `secret` and `wildcard`:

  ```json
  {"name": "stripe", "secret": "stripe-key", "hosts": ["api.stripe.com"], "locations": [{"type": "authorization_bearer"}]}
  ```

  - `name`: `[a-z][a-z0-9_]{0,31}`, unique in its list.
  - `secret`: one of the client's own secret names.
  - `hosts`: 1-16, each inside the grant's `inject_hosts`. A `*.` host needs `"wildcard": true`, as for the operator's, and an `inject_hosts` entry at least as wide.
  - `locations`: 1-3 of `{"type": "authorization_bearer"}` (`Authorization: Bearer <placeholder>`, or `token`), `{"type": "authorization_basic_password", "username"?: "x-access-token"}` (the password of `Basic`; with `username`, nest-proxy writes that username in place of the request's, and only then is the field nest's whole for a guard's `at`: [any injected credential](../../../sandbox/networking/egress/policy/#any-injected-credential)), and `{"type": "header", "name": "X-Api-Key"}` (the placeholder anywhere in that header's value). The name is an HTTP token and not a reserved header: the framing ones (`host`, `connection`, `content-length`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `keep-alive`, `proxy-authorization`, `proxy-authenticate`, `proxy-connection`, `http2-settings`) and the routing overrides nest-proxy strips ([inspection](../../../sandbox/networking/egress/inspection/): `Forwarded`, `X-Forwarded-Host`, `X-Host`, `X-Original-URL`, `X-Rewrite-URL`, and `Fastly-*` except `Fastly-Key`).
  - No `placeholder`: nest assigns `nest-ph.<client id>.<name>.` (a fixed string a client can compute). No assigned placeholder contains another or the GitHub ones, which matters because nest-proxy finds placeholders as substrings.
- **Where a client declares bindings** (lists of at most 16):
  - `inject` in a **template** in its namespace (`PUT /v1/catalog/templates/<client-name>/<entry>`). Only a client's template declares bindings; the operator's go in a sandbox's `policy.inject`.
  - `overrides.inject` at a **spawn** (`POST /v1/agents`; an agent's `agent_spawn` takes the template's as they are) **only narrows** the template's: each must be one of the template's bindings, with the same secret and a subset of its hosts and locations, and no `wildcard` it didn't have. Narrowing is exact: a host is kept or dropped, so `*.example.com` can't narrow to `x.example.com` (write a template with that host). Given, it replaces the list (`[]`: none).
  - `inject` in a **sandbox spec** (`POST /v1/sandboxes`), from a client token only (the operator's is 400).
  - `inject` in the live sandbox's [client layer](#the-client-layer) (`PUT /v1/sandboxes/<id>/client-policy`), so a secret added later reaches agents already running.
- **Checked** at the template's write, at the spawn and at the sandbox's create: hosts outside `inject_hosts` are 403. At each push of the sandbox's secrets, the bindings are checked against the grant as it is then, so narrowing `inject_hosts` takes the value away at the next push: within 15 minutes (a grant's `PATCH` pushes nothing itself), sooner at any policy change. A secret that doesn't exist (or was deleted) gets no value: nest-proxy refuses its placeholder (`injection_unavailable`), never sends it bare.
- **On the sandbox:**
  - An agent's bindings join its sandbox's while it is attached, as its repos do, and go at its detach. Only bindings of the sandbox's own client count, so another subtree's spec never adds one (the operator may attach any agent to any sandbox). And each binding's secret is looked up under the client that declared it, never under the sandbox's: even a binding that reached another client's sandbox couldn't name that client's secret.
  - The operator's layer can't name a binding `client:…` (400), and a binding under a name another binding already has is left out of the policy and pushed no secret, so no operator binding is ever handed a client's value. The operator can still reuse a client's placeholder (`nest-ph.<cli>.<name>.`) in a binding of its own, which nest-proxy checks first, and so deny that client's injection: an availability property, the operator's only, as the operator already controls the policy. The client's value is never handed to that binding (secrets are keyed by binding name).
  - In the policy (`GET /v1/sandboxes/<id>/policy`, the agent's `inject`), each binding is an ordinary binding named `client:<name>`, with its placeholder. A name declared twice keeps the first: the sandbox's own, else the earliest agent id's.
  - SandboxDO asks BrokerDO for references (`clientInjectionRefs`), which FleetDO resolves only in `secrets_update`. So the value reaches only nest-proxy's memory, for the binding's hosts only, and the egress audit names the binding (`binding: client:<name>`) like any injected request's. Each push is audited (`client_secret_injected`: `client`, `sandbox`, the bindings, secrets and hosts) before it goes.
  - A written or deleted secret is pushed at once ([pushed on write](#secrets)). The sandbox also pushes again every 15 minutes, so a narrowed grant, or a write whose push failed, reaches its proxy within that. A reference that resolves to nothing (a deleted or expired secret) goes out as no secret at all, never an empty one, so nest-proxy refuses the placeholder.
- **Reflection:** a host that echoes request headers back (a debugging endpoint, an error page quoting the request) shows the secret to the sandbox. nest-proxy masks the exact value, and the exact header, in a response it reads uncompressed; it doesn't see a compressed body (`content-encoding` other than identity) or a transformed echo (re-encoded, truncated, split across lines). Bind a secret only to hosts that don't reflect it.
- **The egress policy still decides where a sandbox may connect:** a binding doesn't open a host. The operator's base or sandbox layer (or an approved `egress_policy` grant) must allow it.
- **No host change:** on the wire a client's binding is an `InjectionBinding` like any other (`protocol/fixtures/control/egress_policy/egress_policy.client_inject.json`; nest-proxy's `tests/client_inject.rs`).

## Workflow files

- **What it is:** a sandbox's [push token](../../../sandbox/networking/egress/injection/#github) has `contents: write` and `pull_requests: write`. GitHub refuses a push that adds or changes a file under `.github/workflows/` without `workflows: write` ("refusing to allow a GitHub App to create or update workflow … without `workflows` permission"; [GitHub's permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-workflows), unverified against the current page). `github_push: {"workflows": true}` asks for it.
- **Where it's asked for:**
  - A template.
  - The operator's spawn overrides (they replace the template's).
  - A client's spawn overrides (`POST /v1/agents`), where `{"workflows": false}` only turns it off; asking for it is refused. An agent's `agent_spawn` passes none: the template's stands.
  - A sandbox spec (`POST /v1/sandboxes`).
  - The live sandbox's [client layer](#the-client-layer) (`PUT /v1/sandboxes/<id>/client-policy {"github_push": {"workflows": true}}`), which replaces the create's: turned on or off while its agents run.
  - The operator's policy layer.
  The sandbox's push token carries `workflows: write` when any of these, or any attached agent's spec, asks.
- **A client's grant** must have `github_push.workflows: true` (403 otherwise, at the template's write, the spawn, the sandbox's create and a client-layer write asking for it; turning it off always goes through). Revoking it applies to later writes, spawns and creates: a running sandbox that has it keeps minting with it until the agents that asked detach, or (its own create's) until it is destroyed.
- **Minted exactly** `{contents: write, pull_requests: write, workflows: write}`, only then. Without it, the token is as before. The read-only token never has it, whatever is asked. A token minted with it is never reused for one without, nor the other way round.
- **On and off live:** a change reaches the sandbox at once, through the usual secrets push: the next token is minted with or without it, and `secrets_update` replaces the proxy's. A token never enters the sandbox (the proxy holds it), so the old one is out of the sandbox's reach then. It would stay valid at GitHub for the rest of its hour, so BrokerDO revokes the one with `workflows: write` (`DELETE /installation/token`) once a token without it replaces it, or none does: tried twice, then logged and audited `github_installation_token_revoke_failed` (the token expires within the hour). A revoke is audited `github_installation_token_revoked`.
- **Security note:** a pushed workflow runs on GitHub with the repo's own Actions secrets as soon as it's pushed, before anyone reviews it (`push` and `pull_request` triggers from the same repo). Keep CI secrets in an [environment](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment) with required reviewers, so a job that reads them waits for a person, and grant `workflows` only where agents should edit CI.

## Timers

An agent with the [`timers`](../../../agents/capabilities/timers/) capability sets named timers (`timer_set {name, after_s? | at_ms?, note?}`, `timer_cancel {name}`, `timer_list`). A fired timer is an inbox message from `timer` (`timer "<name>" fired: <note>`) that wakes the agent.
- **A client** sees its agents' timers with `GET /v1/agents/<id>/timers` (`{timers: [{name, at_ms, note, set_ms}]}`) and cancels one with `DELETE /v1/agents/<id>/timers/<name>`. Each firing is an `agent.timer_fired` event.
- **Waiting for a domain condition is the app's job:** post to the agent's inbox when it holds, and let the agent's timer be the timeout ([the pattern](../../../agents/capabilities/timers/#waiting-is-a-pattern-not-a-tool)).

## Egress

**Decided (2026-11-02):** a client lets its own sandboxes reach hosts within its grant's `egress_hosts`, on top of the operator's policy (a worker that needs `nodejs.org` no longer waits on the operator).
- **The shape** (`ClientEgress` in `control-plane/src/lib/client-egress.ts`), the operator layer's allow rules:

  ```json
  {"allow": [{"host": "nodejs.org"}, {"host": "*.npmjs.com", "ports": [443]}]}
  ```

  At most 64 rules, each host once. `ports` is 1-16 ports (default 80 and 443). Hosts are named as for `inject_hosts`. Method and path rules aren't in a client's rules (not built).
- **Where:**
  - `egress` in a template, joined to its agent's sandbox while attached.
  - `overrides.egress` on `POST /v1/agents`, which only narrows: the template's hosts, and a subset of their ports.
  - `egress` in `POST /v1/sandboxes`.
  - The live sandbox's [client layer](#the-client-layer).
- **Checked** against `egress_hosts` at the template's write, the spawn, the sandbox's create and the client layer's write (403). A sandbox applies its rules within its client's `egress_hosts` as it last read them: at its create, an attach, a client-layer write, any `PATCH` of the grant (which tells every live sandbox of the client at once), and every 15 minutes while it has client rules, so a sandbox the fan-out missed converges. Each read carries the grant's revision (`grant_rev`, bumped by every `PATCH`) and its epoch (`grant_epoch`, random per record, and new if a record ever lacks a revision). Within one epoch a read never replaces a newer one, so a write whose read was overtaken by a narrowing can't put a revoked host back; a read of another epoch is taken as newer, so a lost counter can't make a sandbox ignore narrowings. Narrowing the grant takes a rule away in the next policy push.
- **No port ceiling:** a granted host may be opened on any port a rule names (1-16 ports; default 80 and 443). The grant bounds hosts, not ports.
- **The operator's policy stays authoritative.**
  - A client's rules compile into the policy nest-proxy already gets, as allow rules of the sandbox's layer (`layer: workstream` on the wire, the layer's historical name). The API's view marks them `source: client` ([sources](../../../sandbox/networking/egress/policy/#sources)). Allow rules only add.
  - Every request guard (the GitHub rules, the operator's own) still applies to what they open, as does the [hard deny](../../../sandbox/networking/egress/policy/#hard-deny) of non-public addresses, whatever rule allowed a host. So a client rule never allows what the operator's policy refuses.
  - **Except passthrough:** a host the operator marks passthrough is spliced uninspected, so no guard could apply there. A client's rule for such a host (equal to a passthrough entry, under one, or covering one) is left out of the policy: a client never opens a host the proxy wouldn't inspect.
  - No host change.
- **A binding opens no host:** an injection binding still needs a rule (the operator's, or one here) to reach its host.

## Request guards

**Decided (2026-11-12, the owner's plan to take service integrations out of the kernel):** a client writes request guards for its own sandboxes, so an app expresses a service's rules (a push allowlist, a read-only API, refused uploads) as data, in the generic shape nest-proxy already evaluates ([request guards](../../../sandbox/networking/egress/policy/#request-guards)), and nest needs no constructor of its own for that service.
- **The shape** (`ClientGuard` in `control-plane/src/lib/client-guards.ts`), the operator's `RequestGuard`:

  ```json
  {"name": "push", "hosts": ["git.example.com"], "ignore_case": true,
   "scope": [{"path": "/**/git-receive-pack"}, {"path": "/**/info/refs", "query": [{"name": "service", "values": ["git-receive-pack"]}]}],
   "allow": [{"path": "/me/box/**"}, {"methods": ["POST"], "path": "/graphql", "injected": "gh"}],
   "reason": "pushes only to me/box"}
  ```

  - On its `hosts`, a request a `scope` matcher covers is refused (403 `request_denied`, audited `guard: client:<name>`) unless an `allow` matcher covers it too. A matcher is `methods`, `methods_except`, `path`, `query`, `body_json` and `injected`, every field given must match, with the operator's semantics (scopes match a path however it's spelled; exceptions only a clean path as sent).
  - `name`: `[a-z][a-z0-9_-]{0,47}`, unique in its list. `hosts`: 1-8, named as for [egress rules](#egress). `scope`: 1-8 matchers; `allow`: at most 64; `reason`: at most 300 characters.
  - A `path` is at most 256 characters and 16 segments, starts with `/`, has no empty segment, whitespace, `?`, `#` or `\`, and at most one `**` with at most 4 segments after it (nest-proxy tries every split of a path at a `**`, so this keeps a scope's cost linear in a request's path). `query`: 1-4 parameters, each with at most 16 values. `body_json`: a pointer and 1-16 values. `methods` and `methods_except`: 1-8 each.
  - `injected` is the name of one of the client's own [bindings](#injection) (as in its `inject`): on the wire `client:<name>`, so a guard can't name an operator's binding or another client's. Or, in an exception (`allow`) only, `*`: any credential nest injected, an operator binding's included, sent as `*` ([any injected credential](../../../sandbox/networking/egress/policy/#any-injected-credential)). That only narrows when the client's own guard lets a request through. In a scope it is refused (400): a control plane rolled back to the previous release would send it as `client:*`, matching nothing, and the guard would stop refusing.
  - `at`, a header name (1-64 token characters), in a scope or an exception: the request's one field of that header must be a value nest's substitution wrote whole, by `injected`'s binding (any, when absent or `*`). Without it, `injected` holds for a substitution anywhere in the request ([what each form guarantees](../../../sandbox/networking/egress/policy/#any-injected-credential)).
  - Unknown fields are refused (400).
- **Where** (lists of at most 16, each at most 16 KiB of JSON):
  - `guards` in a **template**, joined to its agent's sandbox while attached.
  - `overrides.guards` on **`POST /v1/agents`**, added to the template's: a spawn adds refusals and never drops one. The operator's overrides replace the template's.
  - `guards` in **`POST /v1/sandboxes`**.
  - The live sandbox's [client layer](#the-client-layer).

  The operator's templates, overrides and sandboxes may set them too, as they may egress rules. Those are client guards as well: on the wire `client:<name>`, their `injected` naming the sandbox's client's binding (`client:<b>`), and applied in any sandbox (the operator's own guards go in a sandbox's `policy.guards`).
- **No grant covers them:** a guard only takes away. **A sandbox applies** at most 32 client guards, 64 scope matchers, 512 matcher work (each matcher, scope or exception, counts 1; each query parameter 1 plus 1 per value, twice in a scope, which matches the query as sent and decoded; a body field 1 plus 1 per value) and 64 KiB of them, its own layer's and its attached agents', each distinct guard once. A create, a layer write or an agent's attach that would pass that is refused (400), and nothing is stored.
- **An agent's guards count toward that budget** while it is attached, so agents spawned into a sandbox (an agent's `agent_spawn` sharing its own, or a spawn's `overrides.guards`) can fill it, after which the next attach or layer write that adds guards is refused. Keep a template's guards small where its agents share sandboxes.
- **Only on hosts that bound them:** while any sandbox host of the sandbox's cell runs a nest-proxy of the previous release (its fleet hello lacks `guard_bounds`; one not heard from since enrolling, or expired and able to come back, counts too), a create, a layer write or an attach that brings client guards is refused (409 `conflict`; retry once the host is replaced). Refused, never dropped: a dropped guard fails open.
  - **A layer write that adds no guard goes through:** each of its guards is already stored for the sandbox (a subset, compared exactly), so an app rewriting its whole layer can change env or egress without dropping its guards. If the stored guards change while such a write is in flight, it is refused (409) and is retried from a fresh read.
  - Writes without guards, and templates (which apply only at attach), aren't affected.
  - **Placement:** a sandbox whose policy carries a client guard is placed only on a host whose hello said `guard_bounds`. With none free it stays unplaced and SandboxDO retries (unavailable, never unbounded).
- **`*` and `at` only where every host knows them:** a create, a layer write or an attach bringing a guard that newly uses `injected: "*"` or `at` is also refused (409 `conflict`) while any sandbox host of the cell lacks `guard_injected_any` in its hello; a write whose such guards are all already stored goes through, and is refused (409) if they change while it is in flight ([any injected credential](../../../sandbox/networking/egress/policy/#any-injected-credential)).
- **nest-proxy bounds the request too:** on a host a guard names, a path over 4096 bytes or 256 segments or a query over 8192 bytes or 256 parameters is refused (414 `request_target_too_long`), whoever's guard names the host ([request guards](../../../sandbox/networking/egress/policy/#request-guards)). A client's guard on a host it uses with long URLs makes them fail there.
- **They can only refuse.** nest-proxy refuses a request when any guard does, and a guard's `allow` applies only within its own scope, so a client's exception never exempts a request from the operator's guards, the GitHub rules or another layer's ([client guards](../../../sandbox/networking/egress/policy/#client-guards)).
- **On the sandbox:**
  - In the policy (`GET /v1/sandboxes/<id>/policy`, and what nest-proxy gets) each is an ordinary guard named `client:<name>`, after the operator's. The operator's layer can't name a guard `client:…` (400).
  - An attached agent's guards count only when they are its sandbox's client's or the operator's (an operator template's, or the operator's overrides): another subtree's spec adds none, as for bindings. The spec shows whose each is (`client`: its client's id, or null).
  - A guard drops any host the operator marks passthrough or routes as a TCP exception (equal to, under or covering one): a guarded host is always inspected, never spliced and never a TCP exception, so otherwise a client's guard would change how the operator routes it.
- **No host change:** on the wire a client's guard is a `RequestGuard` like any other (`protocol/fixtures/control/egress_policy/egress_policy.client_guards.json`; nest-proxy's `tests/client_guards.rs`).
- **Compatibility, and failing open on the previous release:** a control plane of the previous release (a rollback) handles `guards` two ways.
  - **Refused (400, an unrecognized key):** `PUT …/client-policy` and a client's spawn overrides (`POST /v1/agents`).
  - **Silently dropped, with a 2xx:** `POST /v1/sandboxes`, a template's write (`PUT /v1/catalog/templates/…`) and the operator's spawn overrides. The sandbox, template or agent is made without the guards, so their refusals don't apply.
  - It also leaves stored guards out of each policy it pushes (it reads neither the sandbox's keys nor a spec's `guards`, and strips them from templates).

  So an app that depends on a guard checks that it applies: `GET /v1/sandboxes/<id>/policy` shows each as `client:<name>`, and `GET …/client-policy` answers `guards` only on a control plane that has them. Send them only to one that does.

## Environment

**Decided (2026-11-02):** a sandbox's processes get environment variables, so an agent's tools find `$CLOUDFLARE_API_TOKEN` (holding a placeholder) as they expect, and the brief doesn't have to carry it.
- **The shape** (`SandboxEnv` in `control-plane/src/lib/sandbox-env.ts`):

  ```json
  {"CLOUDFLARE_API_TOKEN": "nest-ph.<client id>.cloudflare.", "APP_ENV": "staging"}
  ```

- **Names:** at most 64 variables. A name is `[A-Z_][A-Z0-9_]{0,63}` and not one nest or the guest sets: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `TERM`, `HOSTNAME`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, the proxy variables, `NEST_*`, and the CA-trust variables (`NODE_EXTRA_CA_CERTS`, which the image sets, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`: set otherwise they could only break TLS through the proxy).
- **The GitHub names are reserved only where nest injects its own GitHub token** (decided 2026-11-12, [principle 10](../../../README.md#principles)): `GITHUB_TOKEN` (the image's GitHub placeholder) and what `gh` and git would use over it (`GH_TOKEN`, which `gh` prefers to `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, and every `GIT_CONFIG*`, from which git takes a credential helper or an `http.extraHeader` of its own). A client that binds its own GitHub token sets them, in a sandbox with no kernel GitHub access.
  - **Kernel GitHub access:** a [push allowlist](../../../sandbox/networking/egress/policy/#repo-allowlists), [read-only repos](../../../sandbox/networking/egress/policy/#read-only-repos) or `github_push` in the sandbox's operator layer, its own create or client layer, or an attached agent's spec; or an operator binding named `github`, `github_read` or `github_read_default`.
  - **No sandbox has both.** Each write that would join them is refused (400, naming the variables), whichever side it adds: a template or spawn whose own repos or `github_push` sit beside them; a sandbox create; a client-layer write; the operator's layer; an agent attaching (its spec's repos to a sandbox whose env or another attached agent's names them, or its env to a sandbox with kernel access; the spawn fails and nothing is attached); a fork added to an attached agent's allowlist. The check reads the sandbox in the same step as the write.
  - **A backstop for state a previous release left** (it checks none of this): where the sandbox has kernel access, SandboxDO drops these names from every `agent_attach.env` it sends.
  - **What it doesn't cover:** names the list never held still let a client's config win over the image's (`XDG_CONFIG_HOME`, `GIT_EXEC_PATH`, `SSH_ASKPASS`), as before this rule; the reservation is a default, not a confidentiality boundary (the token itself never enters the sandbox, and a redirected config gets only the placeholder).
  - **An operator binding counts by its name alone** (`github`, `github_read`, `github_read_default`), whatever secret it carries.
  - **`github_push` alone over-reserves:** with no repos it mints no token, yet still reserves the names.
  - Goes when the kernel's GitHub token does.
- **Values:** each at most 4 KiB with no NUL, and only a literal or a placeholder. **Env is for values that aren't secret:** a credential goes in a secret and a binding, and its placeholder here.
  - A value holding a placeholder (`nest-ph.…`) must be exactly the placeholder of a binding declared beside it: in the same template or spec, or the same sandbox spec. In a client-layer write, one of that layer's own bindings, or an operator binding already in the sandbox's policy; never the layer it replaces, nor one only an attached agent's spec brings.
  - A value holding a stored secret's value is refused (BrokerDO's `scanSecretValues`; nothing is answered of which). It is a best-effort check against accidents, not a guarantee. A client's values are compared with its own secrets only: comparing with every secret would answer whether another tenant's or the operator's secret has a guessed value. The operator's values are compared with every secret.
  - All 400.
- **Where:**
  - `env` in a template.
  - `overrides.env` on `POST /v1/agents`, set over the template's.
  - `env` in `POST /v1/sandboxes`.
  - The live sandbox's [client layer](#the-client-layer).

  The operator's templates and sandboxes may set it too, as they may egress rules (it grants nothing).
- **How it reaches commands:** SandboxDO sends each attached agent's slot environment in `agent_attach.env`: the sandbox's own, then the agent's spec's (which wins on a name both set). nestd hands it to the guest's slot (`AgentSlot.env`, which the guest has applied to every exec since its first release), so hands `Bash`, a terminal and everything they start get it. A change to the sandbox's env configures every attached agent's slot again (`agent_attach` is idempotent: the slot is replaced).
- **Compatibility:** `env` is an optional field of `agent_attach`. A nestd of the previous release ignores it, so its sandboxes' processes get none until the host runs this release. There is no capability flag: nothing breaks, and the field means nothing to a host that doesn't read it.

## The client layer

A live sandbox's own egress rules, injection bindings, environment, push opt-in and request guards, in one place:
- **`PUT /v1/sandboxes/<id>/client-policy {"egress"?: {"allow": […]}, "inject"?: […], "env"?: {…}, "github_push"?: {"workflows": bool}, "guards"?: […]}`** (owner auth: the operator, or the API client of the sandbox's subtree) replaces the whole layer; a part left out is emptied (`github_push` left out is `workflows: false`; `guards` left out is none, so a client that sets guards sends them in every write). It is checked against the sandbox's client's grant as it is now (`egress_hosts`, `inject_hosts`, `github_push.workflows`, its own secrets only), whoever writes it, and its guards against the sandbox's [bounds](#request-guards).
- **Compatibility:** a client of the previous release, which sends no `github_push`, turns off a create's `workflows` at its next layer write (the safe direction). One that sends it to a control plane of the previous release gets a 400 (an unrecognized key): read the layer first, and send `github_push` only when `GET` answers it.
- **The operator's sandboxes** have no client: their layer takes egress and env, never bindings (400; the operator's go in `policy.inject`).
- **It goes out through the usual path:** a new policy version, its secrets pushed first, and (for an env change) every attached agent's slot configured again. So a binding or guard added live reaches the proxy, and one removed live goes.
- **`GET /v1/sandboxes/<id>/client-policy`** answers the layer as set: rules, bindings (with their placeholders, never a secret), env, `github_push` (`{"workflows": bool}`: its create's or the last write's) and `guards` (as written, without the `client:` prefix).
- **It doesn't include** what the sandbox's attached agents' specs add, which comes and goes with them, nor the operator's layer (`/policy`, `GET` shows the effective result).

# API clients' grants lose their GitHub fields; clients' GitHub tokens go (2026-11-15)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for API clients ([no GitHub authority](../../docs/control-plane/api/clients/README.md#no-github-authority)): phase C1 of the plan to take service integrations out of nest's kernel ([decisions](../../docs/README.md#settled-decisions)). It needs B4 (`2026-11-14-projects-converge-github.md`) done: nothing of a client runs on nest's repos, and no deployed app calls the routes below.

**Not a one-way deploy. Ordering constraint:** B4 done and the projects app's fallback off before the Worker deploys (both checked below). No Durable Object class, table, column or wire change; routes and DO methods go.

- **Checked before the merge:** the live grants (`GET /v1/admin/clients`): one client, `projects`, holding `repos: []` and `read_repos: []` and none of `github`, `github_push`, `repo_owners`. Its Worker has no `GITHUB_TOKEN_SOURCE` (`wrangler secret list --name nest-projects`; not a var in its `wrangler.jsonc`), so its fallback to nest's tokens is off, and it no longer calls `/grant/repos` (B2).
- **What changes at deploy:**
  - `POST /v1/clients/self/github-token` and `GET`/`POST /v1/clients/self/grant/repos` are gone (a client token gets 401, as for any path nest doesn't serve), and `GET /v1/clients/self` has no `github_app`.
  - A stored grant reads without `repos`, `read_repos`, `github`, `github_push` and `repo_owners`. A client's spec, template or capability naming repos, `github_push.workflows` or a brokered action is refused (403), as is `github_push.workflows` at its sandbox's create and in its client layer.
  - `POST`/`PATCH /v1/admin/clients` take those fields only when they grant nothing, and drop them; one that grants anything is a 400.
  - BrokerDO's client mints, App identity lookups and owner-wide lookups are gone; their tables stay, unwritten.
- **The gap after the deploy** (minutes, until each Durable Object restarts on this release), each direction:
  - A ClientDO of this release hands a previous CatalogDO or Worker its scope with `repos: []`, which the previous code reads with no default.
  - This release's Worker hands a previous ClientDO (which stores what it is given) a grant with `repos: []` at a client's create or `PATCH`, so the record it writes reads under both releases.
  - A previous Worker hands this release's ClientDO a grant that may hold the fields: ClientDO stores and answers it without them (`repos: []` aside).
  - A previous ClientDO hands this release a grant that may still hold the fields, which nothing here reads.
  - A previous BrokerDO still has the client mint methods, but nothing of this release calls them.
- **Cloud check after the deploy:** `GET /v1/admin/clients` shows the `projects` grant with none of the removed fields; `POST /v1/clients/self/github-token` with the admin token answers 404; a projects start still succeeds (the app's logs, or a new agent under `GET /v1/agents?label=…`).
- **What a `wrangler rollback` does:** a record this release wrote (or this release's Worker had a previous ClientDO write) holds `repos: []` and none of the other fields, so the previous release reads a grant with no GitHub authority (`read_repos`, `github`, `github_push` and `repo_owners` it already read as absent). Its routes come back, answering from that grant: the token route refuses (403), `/grant/repos` lists nothing. A record this release only read is unchanged, its old fields and their authority included (today's one record holds none). The operator grants GitHub again only by a `PATCH` under the previous release.
- **Contract, a release later:** stop writing `repos: []` from the Worker's admin routes and into ClientDO's record and scope (`grantForPreviousRelease`), once no rollback reaches the release before this one; keep refusing the fields on write (`GrantInput`) until then too, then let the strict `Grant` refuse them as unknown. The unwritten tables go with phase C5.

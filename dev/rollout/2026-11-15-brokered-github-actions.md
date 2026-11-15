# The brokered GitHub actions, `email.send` and `github_user` go (2026-11-15)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for [brokered actions](../../docs/agents/capabilities/brokered/#actions): phase C2 of the plan to take service integrations out of nest's kernel ([decisions](../../docs/README.md#settled-decisions)). It follows C1 (`2026-11-15-grant-github-fields.md`).

**Not a one-way deploy. No ordering constraint.** No Durable Object class, table, column or wire change; DO methods go (`BrokerDO.githubUserToken`, `SandboxDO.allowAgentRepos`), and stored rows are never rewritten.

- **Checked before the merge** (a read-only inventory, 2026-11-15): no live agent's spec names a removed action; the operator catalog's only entries that do are the capability `gh-check` (`github.create_issue`, `github.comment`, `github.create_pr`) and the template `gh-check` listing it, both made by `dev/cloud-checks/brokered_check.py` and used by nothing else.
- **What changes at deploy:**
  - `github.comment`, `github.create_issue`, `github.create_pr`, `github.review_comment`, `github.fork` and `email.send` are no longer brokered actions: no tool, and `brokered{action}` answers `invalid_message`. `http.request` profiles are unchanged.
  - A capability write naming one is refused (400, naming the action), at the route and in CatalogDO.
  - A stored capability naming one reads without those entries (its rules and the rest as before; `gh-check` reads with `brokered: []`), so a template listing it still expands, to agents without those tools. A stored spec's grants of one stay in the agent's record, unshown and uncallable.
  - The journal's rows of past calls stay as written and readable.
- **The gap after the deploy** (minutes, until each Durable Object restarts on this release), each direction:
  - A previous Worker hands this release's CatalogDO a capability naming a removed action (its schema still takes them): `checkBrokered` refuses it.
  - A previous AgentDO still runs `github.*` calls (BrokerDO's `githubToken` stays until C3). Its `github.fork` fails: before the fork, at `githubUserToken`; after it, at `allowAgentRepos`, leaving the fork off the push allowlist. No live spec grants either.
  - A previous CatalogDO expands a template whose capability names one into a spec with those grants; this release's AgentDO ignores them.
- **Cloud check after the deploy:** `GET /v1/admin/catalog` shows `gh-check` with `brokered: []` and every other entry as before; a spawn from any template still succeeds.
- **What a `wrangler rollback` does:** nothing this release wrote holds less than before: catalog rows naming a removed action weren't rewritten, and agents' stored grants weren't touched, so the previous release runs them again (`github.fork` needs `github_user`, which is still stored if it was). Capabilities written under this release name no removed action.
- **The operator, after the deploy:** delete the template `gh-check`, then the capability `gh-check` (`DELETE /v1/admin/templates/gh-check`, `DELETE /v1/admin/capabilities/gh-check`); the reworked `brokered_check.py` uses `brokered-check` instead. Delete the BrokerDO secret `github_user` if one is stored (`DELETE /v1/admin/secrets/github_user`): nothing reads it, though it stays unresolvable into a host command.
- **Contract, later:** CatalogDO's read prune (`StoredBrokeredSource`) and AgentDO's (`liveGrants`) stay while a stored row may name a removed action and a rollback may reach the release before this one. `BrokerDO.githubToken`, its `github_tokens` cache and the scan of it go with C3; the table with C5.

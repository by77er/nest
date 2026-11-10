# Owner-wide grants: a shared lookup cap and a 503 for no answer (2026-11-10)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** BrokerDO's `github_lookup_budget` gains a row for all clients (`*`), and `github_account_logins` a nullable column, `failed` (expand-only). Calls are now charged as made (a listing's pages, mint and revoke each count). A `wrangler rollback` ignores the shared row and the column and charges one unit per lookup again; the token route then answers 403 again where this release answers 503 for GitHub not answering.

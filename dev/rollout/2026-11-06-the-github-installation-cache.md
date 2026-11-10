# The GitHub installation cache (2026-11-06)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class or host change. BrokerDO gains a table, `github_app_installations` (by App and repo), and keys `github_tokens` rows `app:<app_id>|…`: tokens cached under the previous keys are never read again, so each (repo, permissions) mints once more after the deploy; a sandbox's held injection token's key now names the App too, so each sandbox's next push mints once more as well. It still writes `github_installations` (by repo), which the previous release reads after a `wrangler rollback`; that release's tokens under the new keys are never read by it, and it mints anew. Drop `github_installations` the release after.

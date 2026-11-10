# A client's GitHub token names its installation (2026-11-10)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table or host change. `POST /v1/clients/self/github-token` gains an optional field, `installation_id`; BrokerDO's `clientGithubToken` and `githubToken` also return `installation`, read from the `installation` column `github_tokens` already keeps. Mid-deploy, a Worker on this release that meets a BrokerDO of the previous one gets no `installation` and leaves the field out (never guesses it). A `wrangler rollback` drops the field from the answer; clients must treat it as optional.

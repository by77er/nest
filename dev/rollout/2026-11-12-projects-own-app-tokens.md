# The projects app mints its own GitHub App tokens (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for the projects app ([GitHub tokens](../../projects/README.md#github-tokens)): phase B1 of the plan to take service integrations out of nest's kernel ([decisions](../../docs/README.md#settled-decisions)).

**Not a one-way deploy.** No nest change, no Durable Object class, table or column, no stored state. All in one script, so the Worker and its Durable Objects deploy together.
- **Ordering constraint:** the Worker's secrets `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are set before it deploys (set for production 2026-11-12; `wrangler secret list --name nest-projects` names both). Without them every GitHub call fails as an outage (503, retried), never as a refusal, until they're set or `GITHUB_TOKEN_SOURCE=nest`.
- **The App's installations** must grant the permissions nest's grant names (the same App: unchanged by this release).
- **What changes at deploy:** each GitHub call's token is minted by the Worker from the App's key instead of by nest (`POST /v1/clients/self/github-token`). Before each mint it still asks nest whether the grant covers the repo and the permissions (`POST /v1/clients/self/grant/repos`, `GET /v1/clients/self`), so the grant bounds the app as before. Tokens are cached per Worker isolate, in memory only.
- **Cloud check:** after the deploy, the Admin page's Re-read on a binding answers 200 with the same `installation_id`; a PR opened on an attached repo gets its `nest-projects/review` check (`POST …/check-runs` with the App's own token). The Worker's logs show no `GitHub 503: …GITHUB_APP` errors.
- **Way out, no deploy:** `wrangler secret put GITHUB_TOKEN_SOURCE` with `nest`: every token from nest again, as before this release (no App secret needed). `wrangler secret delete GITHUB_TOKEN_SOURCE` returns to the App's.
- **What a `wrangler rollback` does:** the previous release takes its tokens from nest again. Nothing this release wrote is read differently: the binding's `installation_id` comes from the same App's lookup either way, and the App's id and bot id are the same App's.
- **Contract, a release later (with phase C1):** remove the fallback (`NestTokens`, `GITHUB_TOKEN_SOURCE`, `Nest.githubToken`) once nest's route goes.

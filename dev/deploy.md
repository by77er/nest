# Deploy

**Decided: merges deploy to production automatically, and a health window rolls back on regression.** Nothing deploys from a branch, and agents never hold deploy credentials. The workflows follow the platform's [upgrade rules](../docs/control-plane/#upgrades). Not built.

## `deploy.yml`

It runs when `ci.yml` succeeds on a push to `main` (`workflow_run`), and on `workflow_dispatch` by me. Its job uses the GitHub environment `production`, which only `main` may deploy from and which holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ANALYTICS_TOKEN`. Deploys are serialized (`concurrency: production`, never cancelled).

1. **Check the pause.** If the last production deployment was rolled back, an automatic run stops; a `workflow_dispatch` run clears the pause. The state is GitHub's own deployment statuses, so nothing else stores it.
2. **Classify.** Diff `wrangler.jsonc` against the deployed version. A Durable Object class change or a removed binding makes this a **one-way deploy**, since Cloudflare won't roll back across one.
3. **Deploy at 100%:** `wrangler deploy --message <sha>`, so every Worker version names its commit.
4. **Smoke:** `GET /v1/health` reaches the Worker and makes one round trip to each DO class.
5. **Health window (10 minutes):** every minute, query [runtime metrics](../docs/control-plane/metrics/) for the new version against the previous version's last 24 hours:
   - Worker 5xx and exception rates;
   - DO exceptions per class;
   - host reconnection: every host connected before the deploy reconnects and renews its leases within 2 minutes;
   - agent turn failures and brain crash restarts;
   - reliable-channel resends.
6. **On regression:** `wrangler rollback <previous> --message "auto-rollback: <reason>"`, mark the deployment failed, and pause deploys. A one-way deploy is only marked failed and paused.
7. **Either way,** GitHub's `deployment_status` webhook reaches the maintainer and the monitor as a channel post.

## `rollback.yml`

`workflow_dispatch` with inputs `version?` and `reason`, in the `production` environment: rolls back and pauses. I can run it, and so can the monitor through `github.dispatch_workflow{workflow: rollback.yml}`, without either of us holding a Cloudflare credential.

## Hosts

When host rollout is built (see [upgrades](../docs/compute/provisioning/#upgrades)), CI on `main` builds the host binaries and images into the cell's bucket, versioned by commit, and `deploy.yml` sets the cell's desired version after the control plane is healthy. The same health window applies, per host version, and rollback sets the version back.

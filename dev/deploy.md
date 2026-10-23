# Deploy

**Decided: merges deploy to production automatically, and a health window rolls back on regression.** Nothing deploys from a branch, and agents never hold deploy credentials. The workflows follow the platform's [upgrade rules](../docs/control-plane/#upgrades).

**Built (`deploy.yml`, first cut):** after `ci.yml` passes on a push to `main`, or by `workflow_dispatch`, three jobs run in order. All three use the `production` environment and the cell's deploy role over OIDC.
1. **`infra`:** `inframe test` and `plan` (the plan's summary goes in the run summary), then `apply` for `use1`.
2. **`worker`:** `dev/deploy-use1.sh`, then `GET /v1/health` for up to two minutes. If the health check fails, `wrangler rollback` returns to the previous version.
3. **`release`:** `scripts/publish-release.sh` builds the host binaries (static, musl) into `releases/current/`.
   - Firecracker, the jailer, the guest kernel and the guest image carry over from the current release.
   - If no file changes, nothing is published.
   - When it does publish, a host AMI build starts.

**Not built yet:** the pause, deploy classification, the metrics health window, `rollback.yml`, and guest image rebuilds. Rebuild the guest image by hand (`images/guest/build-on-ec2.sh`) when `nest-guest` changes.

**Credentials:**
- **AWS:** the cell stack's `nest-<cell>-deploy` role, assumed over GitHub OIDC. Its trust policy accepts only `repo:by77er/nest:environment:production`. Applying the stack manages IAM, so the role is administrator-equivalent; the trust policy is what limits it.
- **Cloudflare:** `CLOUDFLARE_API_TOKEN` (Workers edit) and `CLOUDFLARE_ACCOUNT_ID` are secrets on the `production` environment.
- Pull requests get neither.

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

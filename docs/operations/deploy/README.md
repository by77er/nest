# Deploy

**Decided: merged changes deploy to production automatically, and a health window rolls back on regression.** Nothing deploys from a branch, and agents never hold deploy credentials. Not built.

## Control plane

`deploy.yml` runs when `ci.yml` succeeds on a push to `main` (`workflow_run`), and on `workflow_dispatch` by me. Its job uses the GitHub environment `production`, which only `main` may deploy from and which holds `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_ANALYTICS_TOKEN`. Deploys are serialized (`concurrency: production`, never cancelled).

1. **Check the pause.** If the last production deployment was rolled back, an automatic run stops; a `workflow_dispatch` run clears the pause. State is GitHub's own deployment statuses, so nothing else stores it.
2. **Classify.** Diff `wrangler.jsonc` against the deployed version. A Durable Object class change (new, renamed or deleted class) or a removed binding makes this a **one-way deploy**, since Cloudflare won't roll back across one.
3. **Deploy at 100%:** `wrangler deploy --message <sha>`, so every Worker version names its commit.
4. **Smoke:** `GET /v1/health` reaches the Worker and makes one round trip to each DO class.
5. **Health window (10 minutes):** every minute, query [metrics](../metrics/) for the new version against the previous version's last 24 hours:
   - Worker 5xx and exception rates;
   - DO exceptions per class;
   - **host reconnection:** every deploy drops all host sockets, so every host connected before must reconnect and renew its leases within 2 minutes (a free canary, even with no traffic);
   - agent turn failures and brain crash restarts;
   - reliable-channel resends.
6. **On regression:** `wrangler rollback <previous> --message "auto-rollback: <reason>"`, mark the deployment failed, and pause deploys. On a one-way deploy, nothing is rolled back; it's marked failed and paused.
7. **Either way,** GitHub's `deployment_status` webhook reaches the monitor and maintainer as a channel post (see [repo maintenance](../../orchestration/repo-maintenance/)).

**Why 100%, not gradual:** with Durable Objects, a gradual deployment pins each object to one version until the next deployment ([docs](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)). Old and new DOs would then talk to each other for the whole rollout, and a single owner's traffic is too small for a canary percentage to show much. Host reconnection is the better canary.

**Rollback runs on demand too:** `rollback.yml` (`workflow_dispatch`, inputs `version?` and `reason`, environment `production`) rolls back and pauses. I can run it, and the monitor can through `github.dispatch_workflow{workflow: rollback.yml}`, without either of us holding a Cloudflare credential.

### Rules that make rollback safe

Cloudflare rolls back code, not data: bound resources (DO storage, R2) are unchanged, a DO class change blocks rollback, and only the 100 most recent versions are eligible ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). So:

- **Schema changes are expand-only.** Add tables and columns with defaults; never rename or drop in the same release. Old code ignores what it doesn't know. A later release drops what's unused, once the old version can no longer be rolled back to.
- **Each DO records a [PITR bookmark](../../control-plane/#rules) before it migrates its own schema,** so a bad migration can be undone object by object.
- **Wire formats stay compatible one version back:** DO-to-DO RPC and the host protocol take only additive, optional fields. Hosts can lag the control plane by a release.
- **DO class changes and bindings need my review** (`wrangler.jsonc` is in `CODEOWNERS`), because they make a deploy one-way.

## Hosts

Host binaries (nestd, nest-proxy, the runner, `nest`, the guest agent and rootfs) roll out by replacing hosts, never by updating them in place. Not built; it needs the autoscaler and provisioning.

- **Build:** on `main`, CI builds release binaries and images, versioned by commit, into the cell's bucket.
- **Desired version:** FleetDO holds one per cell, set by `deploy.yml`. New hosts boot it, and old hosts are [drained](../../compute/autoscaling/) and terminated, one at a time. The controller host is replaced the same way; its brains move after 30 s, like a lost host.
- **Health:** the same window, per host version: enrollment, lease renewals, sandbox starts, hands latency, turn failures.
- **Rollback:** set the desired version back and replace again.
- **Guests:** cold boots use the new rootfs. Memory snapshots keep their guest agent and restore only on hosts with a matching [restore ABI](../../sandbox/state/memory/), so the hands protocol stays compatible one version back.

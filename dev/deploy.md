# Deploy

**Decided: merges deploy to production automatically, and a health window rolls back on regression.** Nothing deploys from a branch, and agents never hold deploy credentials. The workflows follow the platform's [upgrade rules](../docs/control-plane/#upgrades).

**Built (`deploy.yml`, first cut):** after `ci.yml` passes on a push to `main`, or by `workflow_dispatch`, three jobs run in order. All three use the `production` environment and the cell's deploy role over OIDC.
1. **`infra`:** `inframe test` and `plan` (the plan's summary goes in the run summary), then `apply` for `use1`.
2. **`worker`:** `dev/deploy-use1.sh`, then `GET /v1/health` for up to two minutes. If the health check fails, `wrangler rollback` returns to the previous version.
3. **`release`:** `scripts/publish-release.sh` builds the host binaries (static, musl) into `releases/current/`.

**The `edge` stack** (`deploy/lean/Edge/`): Cloudflare Access in front of the gateways (`*-gw-nest`, Service Auth for the one service token in `access:gateway`, 401 for a machine without it), the dashboard (`dash-nest`, the owner's login) and previews (`*-preview-nest`, the owner's login). The infra job plans and applies it after the cell when the `production` environment carries `CLOUDFLARE_ACCESS_API_TOKEN` (a Cloudflare token with Account › Access: Apps and Policies › Edit), and skips it with a notice otherwise. Applications created by hand before the stack existed are imported once, not recreated: `inframe tofu --stack edge -- import cloudflare_zero_trust_access_application.<name> <account id>/<application id>` for each, then a plan shows only the differences the stack settles. Done for `use1` on 2026-10-24: the gateway and dashboard applications were imported; the stack moves their policies inline (the old reusable policies stay in the account, unattached) and creates the previews application.

**`AWS_CELLS` is the cell stacks'** (`aws_ssm_parameter.aws_cells`): each cell stack writes its own entry, `{"<cell>": {...}}`, to `/nest/control-plane/aws-cells/<cell>`, built from its launch template, subnets and proxy root CA key and from `CellSpec` (instance types, which `launch_types_within_iam` keeps inside IAM's `EightIOnly` patterns; spot, max hosts, timers, the regular-pages reserve). `dev/deploy-use1.sh` merges every parameter under that prefix after the apply, so a replaced template, subnet or key reaches the Worker on the same run, and no cell stack overwrites another's entry ([cells](../docs/compute/cells/)); a parameter whose one key isn't its own cell name fails the deploy. A cell outside us-east-1 isn't supported yet: its stack would write its parameter in its own region, while the script reads us-east-1 and sets `CELLS=use1`. The first apply that moves the parameter from `/nest/control-plane/vars/AWS_CELLS` replaces it (the plan shows `-/+` on `aws_ssm_parameter.aws_cells`): the old parameter is deleted if it was imported into the stack's state, and left behind, unused, if it never was (delete it by hand).

**Per-cell AWS credentials: the owner's migration, once.** The Worker reads each cell's control-plane access key from the secret `AWS_CELL_CREDENTIALS`; until a cell has an entry it uses the legacy `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`, which keeps it working for one release. The release after that removes the legacy globals, and a cell still without an entry then loses STONITH, autoscaling and root CA signing (enrollment fails).
1. After the deploy, `GET /v1/admin/fleet?cell=use1` shows `aws.sources` as `{"region": "cell", "credentials": "legacy", "kms_key": "cell"}`.
2. Write `{"use1": {"access_key_id": "…", "secret_access_key": "…"}}` to a file outside the repo: an access key of `nest-use1-control-plane`, either the one in today's `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or a new one. `dev/cell-credentials.sh check < file` validates it with the control plane's own schema, and `dev/cell-credentials.sh put < file` validates it and puts it with `wrangler secret put AWS_CELL_CREDENTIALS`, which deploys a new version at once. `aws.sources.credentials` then reads `cell`. A malformed entry that reaches the Worker anyway shows as `aws.error` (fields, never values) while the cell keeps using the legacy key.
3. `GET /v1/admin/root-ca?cell=use1` returns the certificate FleetDO keeps for the cell: on first use it adopted `ROOT_CA_CERT_PEM`, the certificate for the same key. If that certificate were for another key, enrollment and renewal would fail with an error naming it, rather than mint a root the guest image doesn't trust. Check that it matches the certificate baked into the guest image.
4. Then delete the legacy secrets (`npx wrangler secret delete` `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ROOT_CA_KMS_KEY_ID` if it is set as a secret, and `ROOT_CA_CERT_PEM`) and the SSM parameter `/nest/control-plane/vars/ROOT_CA_KMS_KEY_ID`, which the deploy now passes only when it exists. `aws.sources` should read `cell` for all three.

**The dashboard deploys apart** (`deploy-dashboard.yml`): on a push to `main` that touches `dashboard/` (or by `workflow_dispatch`), `npm ci`, typecheck, tests, `vite build` and `wrangler deploy` of the `nest-dashboard` Worker to `dash-nest.bitcru.sh`, then `wrangler secret put NEST_ADMIN_TOKEN` from the `production` environment's secret when it is set. It needs no AWS role; it shares nothing with the platform deploy but the Cloudflare token.
   - Firecracker, the jailer, the guest kernel and the guest image carry over from the current release.
   - If no file changes, nothing is published.
   - When it does publish, a host AMI build starts.

**Not built yet:** the pause, deploy classification, the metrics health window, `rollback.yml`, and guest image rebuilds. Rebuild the guest image by hand (`images/guest/build-on-ec2.sh`) when `nest-guest` changes.

**Credentials:**
- **AWS:** the cell stack's `nest-<cell>-deploy` role, assumed over GitHub OIDC. Its trust policy accepts only `repo:by77er@39721110/nest@1416068100:environment:production`: GitHub's immutable subject format for repositories created after 2026-07-15 carries the owner and repository ids, and `GET /repos/by77er/nest/actions/oidc/customization/sub` confirms it for this repo ([OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)). Applying the stack manages IAM, so the role is administrator-equivalent; the trust policy is what limits it. The first apply of a cell runs by hand with the provisioner key: it creates the role that later applies assume.
- **Cloudflare:** `CLOUDFLARE_API_TOKEN` (Workers edit) and `CLOUDFLARE_ACCOUNT_ID` are secrets on the `production` environment, and so is `CLOUDFLARE_TUNNEL_API_TOKEN` (Account: Cloudflare One Connector: cloudflared → Edit, Zone: DNS → Edit on the nest zone): `dev/deploy-use1.sh` writes it to the Worker with `wrangler secret put` whenever the deploy environment carries it, so the Worker can create and delete each sandbox host's tunnel and DNS record ([gateway](../docs/sandbox/gateway/)). The Worker's non-secret vars for the tunnel come from the script too: `NEST_DOMAIN` (`nest.bitcru.sh`, a literal) and `CLOUDFLARE_ACCOUNT_ID` from the SSM parameter `/nest/control-plane/vars/CLOUDFLARE_ACCOUNT_ID`, created once by hand like the other parameters.
- Pull requests get neither.

## `deploy.yml`

It runs when `ci.yml` succeeds on a push to `main` (`workflow_run`), and on `workflow_dispatch` by me. Its job uses the GitHub environment `production`, which only `main` may deploy from and which holds the secrets in [setup](setup.md) (`CLOUDFLARE_ANALYTICS_TOKEN` is for the health window below). Deploys are serialized (`concurrency: production`, never cancelled).

1. **Check the pause.** If the last production deployment was rolled back, an automatic run stops; a `workflow_dispatch` run clears the pause. The state is GitHub's own deployment statuses, so nothing else stores it.
2. **Classify.** Diff `wrangler.jsonc` against the deployed version. A Durable Object class change or a removed binding makes this a **one-way deploy**, since Cloudflare won't roll back across one.
3. **Deploy at 100%:** `wrangler deploy --message <sha>`, so every Worker version names its commit.
4. **Smoke:** `GET /v1/health` reaches the Worker and makes one round trip to each DO class.
5. **Health window (10 minutes):** every minute, query [runtime metrics](../docs/control-plane/metrics/) for the new version against the previous version's last 24 hours:
   - Worker 5xx and exception rates;
   - DO exceptions per class;
   - host reconnection: every host connected before the deploy reconnects and renews its leases within 2 minutes;
   - agent turn failures and brain crash restarts;
   - gateway refusals (`stale_epoch`, unknown bindings) and hands calls reported unknown;
   - reliable-channel resends.
6. **On regression:** `wrangler rollback <previous> --message "auto-rollback: <reason>"`, mark the deployment failed, and pause deploys. A one-way deploy is only marked failed and paused.
7. **Either way,** GitHub's `deployment_status` webhook reaches the maintainer and the monitor as a channel post.

## `rollback.yml`

`workflow_dispatch` with inputs `version?` and `reason`, in the `production` environment: rolls back and pauses. I can run it, and so can the monitor through `github.dispatch_workflow{workflow: rollback.yml}`, without either of us holding a Cloudflare credential.

## Hosts

Host rollout follows the platform's [upgrade rules](../docs/compute/provisioning/#upgrades): hosts are replaced, never updated in place, and the two host kinds roll one after the other. When it is built, CI on `main` builds the host binaries and the guest image into the cell's bucket, versioned by commit, and `deploy.yml` sets the cell's desired versions after the control plane is healthy, in this order:

1. **Brain hosts.** Set the desired brain-host version. FleetDO launches one canary host; the gate is a probe turn: a real Claude Code turn running the Python task against a probe sandbox through its gateway. Then the old brain hosts drain gently (no new brains, running brains exit at idle, forced after 30 min; AgentDO restarts the brains elsewhere with `--resume`). No sandbox is touched.
2. **Sandbox hosts.** Set the desired sandbox-host version and, when it changed, the guest image version. One canary host boots a probe sandbox, a hands call round-trips through its gateway and a commit lands; then the old hosts drain gently as the [autoscaler](../docs/compute/autoscaling/) does, forced after 30 min. Brains survive their sandbox moving.
3. **Done** when no host of either kind reports the old version in its `hello`.

**This release's rollout rule (the brain record, `brain_epochs`):** sandbox hosts must already run this release before this Worker runs with previous-release hosts that had brains on them. FleetDO never starts a brain on a previous-release host and drains such a host of brains on sight, but it leaves its sandboxes in place, and a host holding a lease is never retired. If the rule is broken, a brain that was on such a host when the Worker deployed is released only by that host's loss: AgentDO wedges the host at the 15-minute escalation cap and it is STONITHed (its sandboxes restored elsewhere from their heads), even when the brain exited cleanly. For the rollout of this release the rule holds by construction: `use1` runs no hosts when the Worker deploys, and a previous-release host launched in the gap never receives a brain, so it never reaches escalation.

The same 10-minute health window applies per host version, with the probe as its gate. `rollback.yml` sets a desired version back, and the same replacement rolls the old version forward again. A release that changes the gateway protocol's `min_supported` or (once memory snapshots exist) the restore ABI is one-way and ships alone, like a Durable Object class change.

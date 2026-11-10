# Deploy

**Decided: merges deploy to production automatically, and a health window rolls back on regression.** Nothing deploys from a branch, and agents never hold deploy credentials. The workflows follow the platform's [upgrade rules](../docs/control-plane/#upgrades).

**Built (`deploy.yml`, first cut):** after `ci.yml` passes on a push to `main`, or by `workflow_dispatch`, three jobs run in order. All three use the `production` environment and the cell's deploy role over OIDC.
1. **`infra`:** `inframe test` and `plan` (the plan's summary goes in the run summary), then `apply` for `use1`.
2. **`worker`:** `dev/deploy-use1.sh`, then `GET /v1/health` for up to two minutes; if it fails, `wrangler rollback` returns to the previous version. The script stamps a digest of every var into the bundle (`--define __NEST_CONFIG__`, shown as `config` in `/v1/health`), because Durable Objects restart only when a deploy changes code and keep the env they started with: without it a vars-only deploy (a cell's caps in `AWS_CELLS`) leaves FleetDO on the old config. Even then a busy DO takes minutes to restart (about 5 on `use1`), and so does new code: a route calling a DO method the release added answers 500 until that DO restarts ([upgrades](../docs/control-plane/#upgrades)). The health check doesn't see it: it calls `health()` on each class's own `~health` instance, never on a busy one like a cell's FleetDO (that an idle instance takes new code at once is unverified). So a post-deploy cloud check of a new route retries for 10 minutes before it counts as a failure.
3. **`release`:** `scripts/publish-release.sh` builds the host binaries (static, musl) into `releases/current/`, which every host installs at boot. It first runs nestd's file-access tests on musl: CI tests under glibc, and std's `custom_flags` behaved differently under musl (it dropped `O_PATH`, so no jailed VM could start).
   - Firecracker, the jailer, the guest kernel and the guest image carry over from the current release.
   - If no file changes, nothing is published.
   - If the build's inputs (`crates/`, `protocol/`, the Cargo files, the toolchain, `.cargo/`, the script, by git object id) match a previous deploy's that published or found nothing to publish, nothing is built: an actions-cache marker saved after that publish says so. A dispatch always builds.
   - When it does publish, a host AMI build starts.

**The `edge` stack** (`deploy/lean/Edge/`): Cloudflare Access in front of the gateways (`*-gw-nest`, Service Auth for the one service token in `access:gateway`, 401 for a machine without it), the dashboard (`dash-nest`, the owner's login) and previews (`*-preview-nest`, the owner's login). The infra job plans and applies it after the cell when the `production` environment carries `CLOUDFLARE_ACCESS_API_TOKEN` (a Cloudflare token with Account › Access: Apps and Policies › Edit), and skips it with a notice otherwise.

**The `projects` stack** (`projects/deploy/`) is the projects app's own, not nest's: Cloudflare Access in front of `projects-nest.bitcru.sh` (the owner's login; `/hooks` and `/mcp` bypassed), with its own state key (`projects/projects.tfstate`). `deploy-projects-infra.yml` tests, plans and applies it only on a push to `main` that touches `projects/deploy/` (or by hand), apart from this deploy, with the edge stack's `CLOUDFLARE_ACCESS_API_TOKEN` and the deploy role for the state, and skips the plan and apply with a notice without the token. The run summary shows `projects_aud`, the app Worker's `PROJECTS_AUD` ([projects/deploy/](../projects/deploy/README.md)).

**`AWS_CELLS` is the cell stacks'** (`aws_ssm_parameter.aws_cells`): each cell stack writes its own entry, `{"<cell>": {...}}`, to `/nest/control-plane/aws-cells/<cell>`, built from its launch template, subnets and proxy root CA key and from `CellSpec` (instance types, which `launch_types_within_iam` keeps inside IAM's `EightIOnly` patterns; spot, max hosts, timers, the regular-pages reserve). `dev/deploy-use1.sh` merges every parameter under that prefix after the apply, so a replaced template, subnet or key reaches the Worker on the same run, and no cell stack overwrites another's entry ([cells](../docs/compute/cells/)); a parameter whose one key isn't its own cell name fails the deploy. A cell outside us-east-1 isn't supported yet: its stack would write its parameter in its own region, while the script reads us-east-1 and sets `CELLS=use1`.

**Per-cell AWS credentials:** the Worker reads each cell's control-plane access key from the secret `AWS_CELL_CREDENTIALS` (`{"<cell>": {"access_key_id", "secret_access_key"}}`, an access key of `nest-<cell>-control-plane`), and region and KMS key from `AWS_CELLS`; a cell without an entry loses STONITH by EC2, autoscaling and root CA signing (enrollment fails). `dev/cell-credentials.sh check < file` validates a file outside the repo with the control plane's own schema, and `dev/cell-credentials.sh put < file` validates it and puts the secret, which deploys a new version at once. `GET /v1/admin/fleet?cell=<cell>` shows `aws` (`region`, `credentials`, `kms_key`), and a malformed entry as `aws.error` (fields, never values). `GET /v1/admin/root-ca?cell=<cell>` returns the certificate FleetDO keeps for the cell; it must match the one baked into the guest image.

**The dashboard deploys apart** (`deploy-dashboard.yml`): on a push to `main` that touches `dashboard/` (or by `workflow_dispatch`), `npm ci`, typecheck, tests, `vite build` and `wrangler deploy` of the `nest-dashboard` Worker to `dash-nest.bitcru.sh`, then `wrangler secret put NEST_ADMIN_TOKEN` from the `production` environment's secret when it is set. It needs no AWS role; it shares nothing with the platform deploy but the Cloudflare token.

**The projects app deploys apart too** (`deploy-projects.yml`): on a push to `main` that touches `projects/` outside `projects/deploy/` (or by `workflow_dispatch`), `npm ci`, typecheck, tests, `vite build` and `wrangler deploy` of the `nest-projects` Worker to `projects-nest.bitcru.sh`, then `wrangler secret put` of `NEST_CLIENT_TOKEN`, `NEST_WEBHOOK_SECRET` and `GITHUB_WEBHOOK_SECRET` from the `production` environment's `PROJECTS_NEST_CLIENT_TOKEN`, `PROJECTS_NEST_WEBHOOK_SECRET` and `PROJECTS_GITHUB_WEBHOOK_SECRET`, each when it is set. Without them the Worker serves and fails closed (503 on its nest calls, 401 on the hooks). Its Access stack is `deploy-projects-infra.yml`'s.

**Not built yet:** the pause, deploy classification, the metrics health window, `rollback.yml`, desired host versions with canaries, and guest image rebuilds (the sections below are the design). Rebuild the guest image by hand (`images/guest/build-on-ec2.sh`) when `nest-guest` changes.

**Credentials:**
- **AWS:** the cell stack's `nest-<cell>-deploy` role, assumed over GitHub OIDC. Its trust policy accepts only `repo:by77er@39721110/nest@1416068100:environment:production`: GitHub's immutable subject format for repositories created after 2026-07-15 carries the owner and repository ids, and `GET /repos/by77er/nest/actions/oidc/customization/sub` confirms it for this repo ([OIDC reference](https://docs.github.com/en/actions/reference/security/oidc)). Applying the stack manages IAM, so the role is administrator-equivalent; the trust policy is what limits it. The first apply of a cell runs by hand with the provisioner key: it creates the role that later applies assume.
- **Cloudflare:** `CLOUDFLARE_API_TOKEN` (Workers edit) and `CLOUDFLARE_ACCOUNT_ID` are secrets on the `production` environment, and so is `CLOUDFLARE_TUNNEL_API_TOKEN` (Account: Cloudflare One Connector: cloudflared → Edit, Zone: DNS → Edit on the nest zone): `dev/deploy-use1.sh` writes it to the Worker with `wrangler secret put` whenever the deploy environment carries it, so the Worker can create and delete each sandbox host's tunnel and DNS record ([gateway](../docs/sandbox/gateway/)). The Worker's non-secret vars for the tunnel come from the script too: `NEST_DOMAIN` (`nest.bitcru.sh`, a literal) and `CLOUDFLARE_ACCOUNT_ID` from the SSM parameter `/nest/control-plane/vars/CLOUDFLARE_ACCOUNT_ID`, created once by hand like the other parameters.
- Pull requests get neither.

## The full `deploy.yml` (designed)

Built so far: the trigger, the environment, serialized runs, step 3 and a smoke check of `GET /v1/health` (one read-only round trip to each DO class) that runs `wrangler rollback` on failure. It runs when `ci.yml` succeeds on a push to `main` (`workflow_run`), and on `workflow_dispatch` by me. Its job uses the GitHub environment `production`, which only `main` may deploy from and which holds the secrets in [setup](setup.md) (`CLOUDFLARE_ANALYTICS_TOKEN` is for the health window below). Deploys are serialized (`concurrency: production`, never cancelled).

1. **Check the pause.** If the last production deployment was rolled back, an automatic run stops; a `workflow_dispatch` run clears the pause. The state is GitHub's own deployment statuses, so nothing else stores it.
2. **Classify.** Diff `wrangler.jsonc` against the deployed version. A Durable Object class change or a removed binding makes this a **one-way deploy**, since Cloudflare won't roll back across one (adding `CatalogDO` is one). Recovering from a bad one-way deploy is a forward revert: the previous code deployed again on top, which is why stored records keep the previous release's fields for one release.
3. **Deploy at 100%:** `wrangler deploy --message <sha>`, so every Worker version names its commit.
4. **Smoke:** `GET /v1/health` reaches the Worker and makes one round trip to each DO class (built: 200 only if every class answered within 5 s, else 503 naming the class; each `curl` has 10 s). It proves each class deploys, instantiates and answers with its SQLite reachable, on a health instance that skips the schema, so not that migrations work on stored data; host reconnection after the deploy is that canary.
5. **Health window (10 minutes):** every minute, query [runtime metrics](../docs/control-plane/metrics/) for the new version against the previous version's last 24 hours:
   - Worker 5xx and exception rates;
   - DO exceptions per class;
   - host reconnection: every host connected before the deploy reconnects and renews its leases within 2 minutes;
   - agent turn failures and brain crash restarts;
   - gateway refusals (`stale_epoch`, unknown bindings) and hands calls reported unknown;
   - reliable-channel resends.
6. **On regression:** `wrangler rollback <previous> --message "auto-rollback: <reason>"`, mark the deployment failed, and pause deploys. A one-way deploy is only marked failed and paused.
7. **Either way,** GitHub's `deployment_status` webhook reaches the maintainer and the monitor through their coordination integration.

## `rollback.yml` (designed)

`workflow_dispatch` with inputs `version?` and `reason`, in the `production` environment: rolls back and pauses. I can run it, and so can the monitor through `github.dispatch_workflow{workflow: rollback.yml}`, without either of us holding a Cloudflare credential.

## Hosts

Built: every host installs `releases/current/` at boot, so a release reaches hosts as they are replaced (autoscaling, spot loss), with no canary or version gate. Designed, following the platform's [upgrade rules](../docs/compute/provisioning/#upgrades) (hosts are replaced, never updated in place, and the two host kinds roll one after the other): CI on `main` builds the host binaries and the guest image into the cell's bucket, versioned by commit, and `deploy.yml` sets the cell's desired versions after the control plane is healthy, in this order:

1. **Brain hosts.** Set the desired brain-host version. FleetDO launches one canary host; the gate is a probe turn: a real Claude Code turn running the Python task against a probe sandbox through its gateway. Then the old brain hosts drain gently (no new brains, running brains exit at idle, forced after 30 min; AgentDO restarts the brains elsewhere with `--resume`). No sandbox is touched.
2. **Sandbox hosts.** Set the desired sandbox-host version and, when it changed, the guest image version. One canary host boots a probe sandbox, a hands call round-trips through its gateway and a commit lands; then the old hosts drain gently as the [autoscaler](../docs/compute/autoscaling/) does, forced after 30 min. Brains survive their sandbox moving.
3. **Done** when no host of either kind reports the old version in its `hello`.

The same 10-minute health window applies per host version, with the probe as its gate. `rollback.yml` sets a desired version back, and the same replacement rolls the old version forward again. A release that changes the gateway protocol's `min_supported` or (once memory snapshots exist) the restore ABI is one-way and ships alone, like a Durable Object class change.

## Pruning images

Old images cost money (EBS snapshots for host AMIs, S3 for guest builds), so `deploy.yml` runs `scripts/prune-images.sh use1 <bucket>` before each new host AMI. It keeps the AMI the launch template resolves to (the SSM parameter), the two newest, and any AMI a live instance runs; it deregisters the rest and deletes their snapshots and Image Builder records. Of the guest builds under `images/guest/`, it keeps the two newest finished ones and every `previous-*` backup, and it removes the builder's staging files. The bucket expires noncurrent versions after a day.

**Why not Image Builder's lifecycle policy alone:** it counts images "per recipe version", and every recipe change is a new version, so each old version kept its two newest images forever: 20 AMIs had piled up by 2026-11-01 ([lifecycle rules](https://docs.aws.amazon.com/imagebuilder/latest/userguide/image-lifecycle-rules.html)). An age rule can't replace it either: one without a minimum could delete the current AMI after an idle spell, and its `retainAtLeast` is per version too.

`DRY_RUN=1` prints what it would delete. After building a guest image by hand, run it the same way (with the deploy role, or credentials that may deregister images).

## Rollout rules

The deploy order is the pipeline's: the cell stack applies, then the Worker deploys, then the release is published, and hosts pick it up only as they are replaced. So the Worker always meets hosts one release behind.
- **Anything the Worker needs from a host is gated on the host saying so** (a field or capability in its `hello`), never on the release having rolled out. A host whose hello lacks `brain_epochs` is drained of brains on sight ([FleetDO](../docs/control-plane/durable-objects/fleet/)).
- **A cell's `AWS_CELLS` entry comes from infra,** which applies first: a cell whose entry lacks the `brain` section launches no brain host, and its brains wait.
- **Each release's rule is its own file in [rollout/](rollout/README.md),** never a paragraph here: it says any ordering constraint and what a `wrangler rollback` does, and the file goes once nothing still depends on it. One file per change, so two open PRs never edit the same lines.
- **Never set `ALLOW_LOOPBACK_MCP` or `ALLOW_LOOPBACK_BROKERED` in a deploy:** they let a capability name a loopback URL (local dev and e2e only).
- **The last one-way deploy declared ClientDO** (the `clients` migration): `wrangler rollback` can't reach a version older than it, so no rule in [rollout/](rollout/README.md) covers an older release's rollback.
- **Not yet checked on a host:** `systemctl is-enabled` on each host kind against `scripts/tests/test_bootstrap.py`.

**Cleanups nothing depends on any more** (no rollback reaches the releases that needed them):
- The `gateway-user` check and its root fallback in `deploy/host/install.sh` and `bootstrap.sh` (`nestd --features` stays for the next such change).
- The template fields written for the release before workstreams left (`escalate_to`, `subscribe`; `PREVIOUS_RELEASE_TEMPLATE_FIELDS` in `do/catalog.ts`), AgentDO's `ask:` deadline handler for a previous release's sync `ask`, and the `overrides.params` refusal on `POST /v1/agents` (`index.ts`).
- Stored data no code reads: channel bodies in R2 under `channels/` (an operator delete), and AgentDO/SandboxDO's `channel_subs`, `chan_wakes` and `chan_out` tables (dropped in a later release under the expand-only rule).
- **Unconfirmed operator cleanups** (the owner to confirm they were done): the old SSM parameter `/nest/control-plane/vars/AWS_CELLS` if it was never imported into a cell stack; the legacy Worker secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `ROOT_CA_KMS_KEY_ID`, `ROOT_CA_CERT_PEM`) and the SSM parameter `/nest/control-plane/vars/ROOT_CA_KMS_KEY_ID`; the unattached reusable Access policies left by the edge stack's import; and respawning agents whose stored prompts still describe removed tools.
- **Still needed by hosts:** `sandbox_create`, `sandbox_fork` and `agent_start` carry a `ws_` value (`compatWorkstream`), which hosts and runners from before workstreams left require (Rust's `WorkstreamId`, prefix-checked). Drop it from the control plane (and `SandboxInfo`/`AgentInfo`) once every host runs that release or later, then the Rust fields the release after. The policy layer's wire value `workstream` (the operator layer; hosts parse a closed enum) stays.

## Host role names (expand/contract)

The host kinds' rename (`burst` → `sandbox`, `controller` → `brain`) spans two releases. No rollback reaches the release before brain hosts any more (the ClientDO declaration was one-way), so nothing blocks the contract release or dropping the runner from sandbox hosts; what remains is that hosts lag a release, so the contract release still reads the old names.
- **Now (since brain hosts, #36):** everything reads both names; everything writes the old ones: FleetDO's `hosts`, `enroll_tokens` and `launched` rows (none is rewritten), host tokens, the role nestd sends in enrollment and `hello`, and the role the launch templates' user data writes (`burst` for the sandbox template, `controller` for the brain template). The control plane accepts an enrollment without a proxy CSR (a brain host's). Sandbox hosts keep the agent runner enabled, and nestd on a sandbox host still runs a brain it is sent.
- **Pending: the contract release** (not built; the follow-up to #36): writes `sandbox` and `brain` everywhere (FleetDO rewrites its `role` columns once, in its constructor; host tokens; nestd's wire names; the templates' user data); drops the agent runner from sandbox hosts' bootstrap; nestd on a sandbox host refuses `agent_start` and binds no runner socket. It still reads the old names, for the hosts and rows the expand release wrote. The release after drops them.

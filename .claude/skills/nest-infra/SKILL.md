---
name: nest-infra
description: Use when changing nest's cloud infrastructure or delivery: the inframe Lean stacks in deploy/ (cell use1, edge; IAM theorems, graph policies), host user data (deploy/host/bootstrap.sh, install.sh), .github/workflows, the deploy pipeline (deploy.yml, dev/deploy-use1.sh, scripts/publish-release.sh), rollout rules and rollback, and when checking the live cell after a deploy. Never apply infrastructure from a workstation.
---

# Changing infrastructure and delivery

**Where things are:**
- **Stacks:** [deploy/README.md](../../../deploy/README.md). `deploy/lean/Cell/` holds the cell stack, its IAM statements (`Iam.lean`) and its theorems and policies (`Test.lean`); `deploy/lean/Edge/` holds the Cloudflare Access stack.
- **Host user data:** `deploy/host/`.
- **Pipeline and rollout rules:** [dev/deploy.md](../../../dev/deploy.md).
- **CI:** [dev/ci.md](../../../dev/ci.md).
- **Cloud checks:** [dev/cloud-checks/](../../../dev/cloud-checks/README.md).

All of `deploy/`, `.github/`, `dev/` and `scripts/` are `CODEOWNERS` paths.

**Never run `inframe apply` (or `plan` against the real account), `wrangler deploy`, `wrangler rollback` or `wrangler secret put` from a workstation.** The deploy applies on merge, with the deploy role over OIDC. Applying is the owner's call.

## The stacks

- **Check locally** with no AWS credentials, as CI does:

  ```bash
  cd deploy
  inframe provider generate aws --frontend lean --schema-json aws-schema.json
  inframe provider generate cloudflare --frontend lean --schema-json cloudflare-schema.json
  inframe test --stack use1
  inframe test --stack edge
  ```

  The CLI is pinned in `scripts/infra-tools.sh` (`INFRAME_REV`); a local shim may be a different build. Lean is pinned in `deploy/lean/lean-toolchain`.
- **A theorem or policy that can't fail proves nothing:**
  - for a new or changed one, break the stack the way it forbids (drop a condition in `Iam.lean`, open an ingress rule, allow a wider instance type);
  - watch `inframe test` fail and name the theorem;
  - restore.
  
  Say what you mutated in the PR. Several checks here once passed a mutation that should have failed them.
- **IAM is data** (`Iam.lean`): a new permission gets a theorem bounding it (a resource tag, a template, an account), not just a policy.
- **`include_str` isn't tracked by Lake by itself.** `deploy/lean/lakefile.toml` declares `host/bootstrap.sh` and `host/install.sh` as `input_file` targets the `Cell` library `needs`, so an edit rebuilds `Cell.Stack`, even from the cached `.lake` CI and the deploy restore (their key hashes no scripts, and `restore-keys` would bring an old build back anyway).
  - Without those entries a cached build kept the old scripts: an edit to `bootstrap.sh` left the built `cell-use1` and `cell-test` without it (checked with Lean 4.33.1, 2026-10-30), so the plan would show no user-data change.
  - A new `include_str` gets an `input_file` entry too.

## Host user data

- `bootstrap.sh` is rendered once per launch template with its role; both kinds run `install.sh`.
- **Test:** `python3 -m unittest discover -s scripts/tests -p test_bootstrap.py`. It runs each kind's user data against a fake root with the real `systemctl --root`, checks that exactly its kind's units are enabled and that no unit of the other kind is reachable, and runs shellcheck.
- **Locally,** a missing shellcheck skips its test, and a missing `systemctl` skips the rest. On CI, shellcheck must be installed. Install both, or say what skipped.
- **Why the real `systemctl`:** a `systemctl mask` over a unit file that `install.sh` writes would have aborted every host's boot, and only the real one shows that.

## Workflows

- **YAML must parse.** An unquoted value containing `": "` silently disabled `fuzz.yml`. Check with `uv run --no-project --with pyyaml python3 -I -c "import sys, yaml; [yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`.
- **Pin every action by commit, with the release in a comment.** A new CI job goes into `ci-ok`'s `needs`.
- **CI holds no secrets.** Deploy secrets live only in the `production` environment, which only `main` can use.

## The pipeline

- **Order:** CI green on a push to `main` → `deploy.yml`, serialized and never cancelled:
  1. **`infra`:** the `use1` plan and apply, then the edge stack's plan and apply when its token is set.
  2. **`worker`:** `dev/deploy-use1.sh`, which merges every cell's `AWS_CELLS` parameter, writes the tunnel secret, and deploys. Then `/v1/health` is polled for 2 min, and a failure runs `wrangler rollback` to the previous version.
  3. **`release`:** `scripts/publish-release.sh` builds static musl host binaries into `releases/current/`; when they changed, it starts a host AMI build.
- **Not in the pipeline:**
  - the guest image is rebuilt by hand (`images/guest/build-on-ec2.sh`) when `nest-guest` changes;
  - the dashboard deploys from `deploy-dashboard.yml`;
  - the health window, the deploy pause and `rollback.yml` aren't built.
- **A release with ordering constraints gets a rollout rule** in `dev/deploy.md`. It says what must already be true before the Worker deploys, what runs in each gap (apply → Worker → release), and what an automatic `wrangler rollback` does with what this release wrote. A DO class change or a raised gateway `min_supported` is one-way and ships alone.
- **Rollback:**
  - the Worker rolls back automatically only on a failed smoke test;
  - anything else is a forward revert: a PR that restores the previous behaviour, deployed by merge;
  - a manual `wrangler rollback` is the owner's.

## After the merge

- **Watch the runs:**
  - main's CI: `gh run list --workflow ci.yml --branch main --limit 3`;
  - then the deploy: `gh run list --workflow deploy.yml --branch main --limit 3` and `gh run watch <id> --exit-status`;
  - read the plan summary in the run before trusting the apply.
- **Smoke:** `curl -fsS https://nest.bitcru.sh/v1/health`.
- **Cloud check what only the cloud can show,** with the scripts in [dev/cloud-checks/](../../../dev/cloud-checks/README.md). For brain hosts or placement: `python3 -I dev/cloud-checks/brain_hosts_check.py`. It needs `NEST_ADMIN_TOKEN` exported (never printed), launches spot hosts in a cold cell and spends a little subscription quota, and cleans up the agents and sandboxes it creates.
  - A new check goes in the same directory, cleans up on every exit path, never prints credentials, and gets a row in its README.
  - Don't touch the owner's other tunnels or resources.
- **EC2 facts** (a launch, an instance profile, `systemctl is-enabled` on a host) need AWS access. Say which you checked and which you couldn't.

## Done

- `inframe test` passes for both stacks, and each new theorem or policy was mutation-checked.
- The bootstrap test passed with shellcheck (or its skip is stated).
- The workflows parse.
- The rollout rule is written if order matters.
- After merge: main's CI and the deploy are green, `/v1/health` answers, and the relevant cloud check passed.

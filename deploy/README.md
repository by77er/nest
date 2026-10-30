# Cloud infrastructure

nest's cells as an [inframe](https://github.com/by77er/inframe) project: Lean stacks rendered to OpenTofu. One stack per cell; `use1` is AWS us-east-1.

| Path | What |
|---|---|
| `inframe.toml` | The project: the Lean package, the pinned AWS provider, and each stack's S3 state backend |
| `aws-schema.json` | The AWS provider schema (6.69.1), trimmed to the resource types nest uses, so bindings build in seconds |
| `cloudflare-schema.json` | The Cloudflare provider schema (5.27.0), trimmed to the three Access resources the `edge` stack uses |
| `lean/Edge/` | The `edge` stack: Cloudflare Access applications and policies in front of nest's hostnames (account-level, not per cell); outputs the dashboard application's audience tag (`dashboard_aud`), which the dashboard Worker checks |
| `lean/Cell/Stack.lean` | A cell: VPC with public subnets and an S3 gateway endpoint, egress-only security group, versioned bucket, host role, launch template, the host-image pipeline (EC2 Image Builder), the proxy root CA key, the control plane's IAM user and the cell's `AWS_CELLS` entry (the SSM parameter `/nest/control-plane/aws-cells/<cell>`, from the template, the subnets, the key and `CellSpec`), the deploy role GitHub Actions assumes over OIDC |
| `lean/Cell/Iam.lean` | IAM policies as data, rendered to JSON |
| `lean/Cell/Test.lean` | Theorems about what the control plane and hosts may do, for every cell; that `use1`'s autoscaler instance types fall inside IAM's 8i patterns, and that its `AWS_CELLS` entry parses with the key's ARN; policies over the `use1` graph (no ingress, egress allow-list, IMDSv2) |
| `host/install.sh` | Installs a host's software (packages, the release, Claude Code, systemd units): baked into the host AMI, and rerun at boot to catch up |
| `host/bootstrap.sh` | Host user-data, rendered once per launch template with its role: both kinds run `install.sh`; a sandbox host writes its config and enables nest-proxy, nestd, the gateway (and, this release, the runner), a brain host nestd and the runner (no secrets). `scripts/tests/test_bootstrap.py` runs both against a fake root |

## Use

Needs OpenTofu 1.10+, `elan` and the `inframe` CLI (pinned in `inframe.toml` by commit).

```bash
cd deploy
inframe provider generate aws --frontend lean --schema-json aws-schema.json   # once per checkout
inframe test --stack use1          # proofs and policies; plan and apply also run them
inframe init --stack use1 -- -input=false
inframe plan --stack use1 -- -out=use1.plan
inframe apply --stack use1 -- use1.plan
```

- **`include_str` isn't tracked by Lake:** after editing `host/bootstrap.sh` or `host/install.sh`, delete `lean/.lake/build/{lib/lean,ir}/Cell/Stack.*` (Lake hashes contents, so `touch` doesn't help) or the plan shows no change.
- **Host AMI:** `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn $(inframe output --stack use1 | jq -r .host_image_pipeline.value)` bakes `releases/current/` into a new AMI (about 15 minutes). Its ID lands in `/imagebuilder/nest-<cell>/host-ami`, which the launch template resolves at each launch; the parameter starts at stock AL2023. Rebuild after publishing a release: hosts on an older AMI still work, but download the difference at boot.
- **Spot drill:** `aws fis start-experiment --experiment-template-id $(inframe output --stack use1 | jq -r .spot_drill_template_id.value)` sends a real two-minute interruption notice to one running nest spot host. Its role can interrupt only `nest=true` instances (proved in `Cell.Test`).
- **Once per account:** the EC2 Spot service-linked role (`aws iam create-service-linked-role --aws-service-name spot.amazonaws.com`); without it, spot launches fail with `AuthFailure.ServiceLinkedRoleCreationNotPermitted`.
- **State** lives in the versioned bucket `nest-tfstate-<account>`, created once by hand (versioning on, public access blocked), with S3-native locking.
- **The provider pins the account** (`allowed_account_ids`), so credentials for another account fail before any change.
- **Every resource is tagged** `nest=true` and `nest:cell=<cell>` through the provider's default tags.
- **The bucket can't be destroyed** by the stack (`prevent_destroy`): sandbox state lives there.
- **The provider's `endpoints` block is trimmed** from the schema: its 300+ fields exceed what one Lean structure can hold.

# Cloud infrastructure

nest's cells as an [inframe](https://github.com/by77er/inframe) project: Lean stacks rendered to OpenTofu. One stack per cell; `use1` is AWS us-east-1.

| Path | What |
|---|---|
| `inframe.toml` | The project: the Lean package, the pinned AWS provider, and each stack's S3 state backend |
| `aws-schema.json` | The AWS provider schema (6.69.1), trimmed to the resource types nest uses, so bindings build in seconds |
| `lean/Cell/Stack.lean` | A cell: VPC with public subnets and an S3 gateway endpoint, egress-only security group, versioned bucket, host role, launch template, the control plane's IAM user |
| `lean/Cell/Iam.lean` | IAM policies as data, rendered to JSON |
| `lean/Cell/Test.lean` | Theorems about what the control plane and hosts may do, for every cell; policies over the `use1` graph (no ingress, egress allow-list, IMDSv2) |
| `host/bootstrap.sh` | Burst-host user-data: installs the host binaries from the cell's bucket and starts nestd (no secrets) |

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

- **Once per account:** the EC2 Spot service-linked role (`aws iam create-service-linked-role --aws-service-name spot.amazonaws.com`); without it, spot launches fail with `AuthFailure.ServiceLinkedRoleCreationNotPermitted`.
- **State** lives in the versioned bucket `nest-tfstate-<account>`, created once by hand (versioning on, public access blocked), with S3-native locking.
- **The provider pins the account** (`allowed_account_ids`), so credentials for another account fail before any change.
- **Every resource is tagged** `nest=true` and `nest:cell=<cell>` through the provider's default tags.
- **The bucket can't be destroyed** by the stack (`prevent_destroy`): sandbox state lives there.
- **The provider's `endpoints` block is trimmed** from the schema: its 300+ fields exceed what one Lean structure can hold.

# Cells

A cell is compute plus its object store in one provider and region (AWS today; `use1` is us-east-1). **Decided: everything AWS is per cell, keyed by the cell name.** No AWS resource, setting or credential is shared between cells, so one cell's misconfiguration or leaked key can't reach another, and adding a cell is one more stack and one more secret entry.

| Per cell | Made by | Reaches the control plane as |
|---|---|---|
| VPC, subnets, security group, bucket, host role, launch template, host image pipeline | The cell stack (`deploy/lean/Cell/Stack.lean`) | `AWS_CELLS.<cell>`: template and subnets |
| Region and autoscaler settings | `CellSpec` | `AWS_CELLS.<cell>` |
| Proxy root CA key (`alias/nest-<cell>-proxy-root`) | The cell stack | `AWS_CELLS.<cell>.proxy_root_key_arn` |
| Root CA certificate | FleetDO, from the key ([tls](../../sandbox/networking/egress/tls/)) | FleetDO's storage; `GET /v1/admin/root-ca?cell=<cell>` |
| IAM user `nest-<cell>-control-plane`; its policy names only this cell's template, host role, AMI parameter and key | The cell stack; its access key by hand | `AWS_CELL_CREDENTIALS.<cell>` (a Worker secret) |

- **`AWS_CELLS`** (a Worker var): each cell stack writes its own entry, `{"<cell>": {...}}`, to the SSM parameter `/nest/control-plane/aws-cells/<cell>`, from its own outputs, and the deploy merges every entry ([dev/deploy](../../../dev/deploy.md)). `control-plane/src/lib/cells.ts` parses it and refuses a key outside the cell's region.
- **`AWS_CELL_CREDENTIALS`** (a Worker secret): `{"<cell>": {"access_key_id": "…", "secret_access_key": "…"}}`. `lib/cells.ts` validates it, and its errors name fields, never values.
- **FleetDO uses the cell's region and credentials for KMS, EC2 and SSM alike.**
- **Legacy, for one release:** a cell missing from `AWS_CELL_CREDENTIALS` uses `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; an `AWS_CELLS` entry without `proxy_root_key_arn` uses `ROOT_CA_KMS_KEY_ID`; a cell with no entry uses `AWS_REGION`. Each setting falls back on its own. `GET /v1/admin/fleet?cell=<cell>` reports where each one came from (`aws.sources`: `cell`, `legacy` or `none`), never a value. The release after the migration removes the globals.
- **Not built:** a cell outside us-east-1. Its stack would write its parameter in its own region while the deploy reads us-east-1, and `dev/deploy-use1.sh` sets `CELLS=use1`.

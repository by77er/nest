# Cells

A cell is compute plus its object store in one provider and region (AWS today). **Decided: everything AWS is per cell, keyed by the cell name.** No AWS resource, setting or credential is shared between cells, so one cell's misconfiguration or leaked key can't reach another, and adding a cell is one more stack and one more secret entry.

| Per cell | Made by | Reaches the control plane as |
|---|---|---|
| VPC, subnets, bucket, host image pipeline; per host kind a security group, an instance role and a launch template | The cell's stack | `AWS_CELLS.<cell>`: the sandbox template, subnets, and `brain.launch_template_id` |
| Region and autoscaler settings, per host kind | The cell's stack spec | `AWS_CELLS.<cell>` (sandbox hosts) and `AWS_CELLS.<cell>.brain` (brain hosts; optional for one release: a cell without it launches none) |
| Proxy root CA key (`alias/nest-<cell>-proxy-root`) | The cell's stack | `AWS_CELLS.<cell>.proxy_root_key_arn` |
| Root CA certificate | FleetDO, from the key ([tls](../../sandbox/networking/egress/tls/)) | FleetDO's storage; `GET /v1/admin/root-ca?cell=<cell>` |
| IAM user `nest-<cell>-control-plane`; its policy names only this cell's template, host role, AMI parameter and key | The cell's stack; its access key by hand | `AWS_CELL_CREDENTIALS.<cell>` (a Worker secret) |

- **`AWS_CELLS`** (a Worker var): one entry per cell, `{"<cell>": {...}}`, which each cell's stack produces from its own outputs; the deploy merges them. The control plane refuses a key outside the cell's region.
- **`AWS_CELL_CREDENTIALS`** (a Worker secret): `{"<cell>": {"access_key_id": "…", "secret_access_key": "…"}}`. Validation errors name fields, never values.
- **FleetDO knows its cell by its own name** (each FleetDO is named for its cell), and uses the cell's region and credentials for KMS, EC2 and SSM alike.
- **No global fallback:** a cell missing from `AWS_CELL_CREDENTIALS`, or whose entry is malformed, has no AWS access: STONITH waits for a fence or an operator, nothing autoscales, and KMS signing (so enrollment) fails. An `AWS_CELLS` entry without `proxy_root_key_arn` has no KMS key (the development root applies), and a cell with no entry has no region. `GET /v1/admin/fleet?cell=<cell>` reports the cell's region, whether it has credentials and a KMS key (`aws.credentials`, `aws.kms_key`) and a malformed entry's error (`aws.error`), never a value.

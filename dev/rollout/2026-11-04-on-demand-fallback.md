# On-demand fallback (2026-11-04)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and nothing by hand.**
- **What changes:** when spot has no room for any instance type, FleetDO tries each type on demand, cheapest first. Before, it tried only the first type. The cell stack writes the order, `on_demand_types`, from its price table (Price List API, 2026-11-03/04). `use1` gets `c8i-flex.large, c8i.large, m8i.large, c8id.large, m8id.large, r8id.large`, and the brains `t3a.medium, t3.medium`.
- **Why:** on 2026-11-03 the first type, `c8id.large`, had no on-demand capacity in any of the cell's zones, so a pass with no spot room launched nothing.
- **Cost:** an on-demand sandbox host is `c8i-flex.large` ($0.08902/h) when it has room. That is cheaper than today's `c8id.large` fallback ($0.11088/h), and never dearer than the cheapest type with room.
- **An on-demand fallback host is usually EBS-only:** `c8i-flex`, `c8i` and `m8i` come before every instance-store type on demand. So its checkpoints pause the VM for whole reads (M1), not for a clone ([disk](../../docs/sandbox/state/disk/)). That is the price of the cheaper host; spot still tries the instance-store types first.
- **Its disk:** the sandbox hosts' root volume grows from 30 to 140 GB (gp3), so an EBS-only host holds `maxSandboxesPerHost` (14) at 8 GB each, plus 24 GB for the OS, images and cache. A host whose bootstrap fell back from its instance store keeps its state there too. `sandboxes_fit_their_disk` now covers the root volume as well as each instance store.
  - **Why raise the volume, not cap per type:** placement doesn't know a host's type or whether its store was used. A per-type cap would need nestd to report it, and would leave an EBS host at 2 sandboxes. The bigger volume needs neither.
  - **Cost:** +110 GB × $0.08/GB-month = +$8.80 a month per always-on sandbox host, or about $0.012 an hour while a host runs. It is paid on instance-store hosts too, since the volume is one template's. The brain hosts' 30 GB is unchanged.
  - AL2023 grows the root filesystem to the volume at first boot (cloud-init `growpart`; unverified on a nest host until one launches).
- **Price drift:** `onDemandPrices` is a table in the cell stack, verified on 2026-11-03/04. Nothing checks it against AWS since. A scheduled check of it against the Price List API's `get-products` is an open item ([open questions](../../docs/README.md)), not built.
- **Bounded** ([autoscaling](../../docs/compute/autoscaling/)):
  - A pass makes at most two calls per type.
  - A pass with no room anywhere, or a spent on-demand quota, starts a per-kind backoff: 60 s, doubling to 15 min (brains 5 min), cleared by a launch, and forgotten 30 min after it lapses. A spent spot quota skips to on demand.
  - An error that isn't a lack of room still ends the pass, and that attempt is repeated.
- **Order:** inframe writes `on_demand_types` into `AWS_CELLS`; then the Worker reads it. A Worker of the previous release ignores the field (zod strips it). A new Worker with an `AWS_CELLS` that lacks it tries `instance_types` in order.
- **What a rollback does:** first-type-only on demand, and no backoff.

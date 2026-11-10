# Instance types (2026-11-04)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and nothing by hand.**
- **What changes:**
  - `use1`'s `launchTypes` become `c8id.large, m8id.large, r8id.large`, then the EBS-only `c8i-flex.large, c8i.large, m8i.large`.
  - IAM's sandbox statement (renamed `SandboxTypesOnly`, from `EightIOnly`) now allows exactly those six types: `<family>.large`, no wildcard. Before, it allowed `c8i*.*`, `m8i*.*` and `r8i*.*`, any size.
  - `maxSandboxesPerHost` becomes 14.
  - Bootstrap formats the instance store with `mkfs.xfs -K`, which skips the device-wide discard.
- **Why:** `c8id.large` is scarce in the cell's zones. Its spot placement score was 1 of 10 in us-east-1a, 1b and 1c (`get-spot-placement-scores`, 2026-11-03), and on-demand launches found no capacity in any of them that evening. The first real launch after M2 fell back to `c8i-flex.large`, which has no instance store.
- **Which types can serve:**
  - **KVM:** Firecracker needs `/dev/kvm`, which a virtual EC2 instance has only with nested virtualization. AWS offers that on C/M/R 7i and 8i, R7iz, X8i, I7i and I7ie ([user guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)).
  - **Local NVMe:** of those, only the 8id families and I7i/I7ie have it (`describe-instance-types`).
  - **Firecracker support:** Firecracker supports Granite Rapids (8i), on a 6.1 or 6.18 host kernel only. It doesn't list Emerald Rapids (I7i, I7ie) ([tested platforms](https://github.com/firecracker-microvm/firecracker#tested-platforms), 2026-11-04). So I7i is out, although it has the best placement score.
  - **Out on nested virtualization:** `c6id`, `m6id`, `r6id` and `c7id` don't have it.
  - **Nothing per type in nestd:** nest uses no Firecracker CPU template, and disk-only restores carry no CPU state across hosts. Memory snapshots, when built, will need placement that knows each host's CPU model ([restore ABI](../../docs/sandbox/state/memory/#restore-abi)).
- **The guards** (`deploy/lean/Cell/Test.lean`):
  - `launch_types_sound`: every type has nested virtualization on a CPU Firecracker supports, and every instance-store type comes before every EBS-only one.
  - `sandboxes_fit_their_disk`: 14 sandboxes × 8 GB fits each instance-store type's 118 GB.
    - Placement packs by memory, so without the cap an `m8id` (8 GiB) or `r8id` (16 GiB) would take 2–4× a `c8id`'s sandboxes on the same disk. That would fill it.
    - The 8 GB per sandbox is an assumption: its 32 GiB sparse disk shares `nest-base` by reflink. It is unmeasured on a used host.
  - Better later: nestd reports free space on its state filesystem, for placement to use.
- **Prices** (us-east-1, Linux, verified 2026-11-03):
  - sources: Price List API `get-products` for [on demand](https://aws.amazon.com/ec2/pricing/on-demand/), `describe-spot-price-history` for [spot](https://aws.amazon.com/ec2/spot/pricing/), and `get-spot-placement-scores` for one instance in one zone;
  - all are offered in every us-east-1 zone.

  | Type | vCPU, RAM | Instance store | On demand | Spot 1a / 1b / 1c | Placement score 1a / 1b / 1c |
  |---|---|---|---|---|---|
  | `c8id.large` | 2, 4 GiB | 118 GB | $0.11088 | $0.0555 / 0.0288 / 0.0316 | 1 / 1 / 1 |
  | `m8id.large` | 2, 8 GiB | 118 GB | $0.13052 | $0.0371 / 0.0400 / 0.0335 | 1 / 1 / 1 |
  | `r8id.large` | 2, 16 GiB | 118 GB | $0.16632 | $0.0489 / 0.0705 / 0.1610 | 1 / 1 / 1 |
  | `i7i.large` (out: CPU) | 2, 16 GiB | 468 GB | $0.18880 | $0.0460 / 0.0517 / 0.0443 | 3 / 3 / 3 |
  | `c8i-flex.large` | 2, 4 GiB | none | $0.08902 | $0.0319 / 0.0434 / 0.0390 | 3 / 1 / 3 |
  | `c8i.large` | 2, 4 GiB | none | $0.09371 | $0.0376 / 0.0438 / 0.0385 | 1 / 3 / 3 |
  | `m8i.large` | 2, 8 GiB | none | $0.10584 | $0.0367 / 0.0402 / 0.0427 | 3 / 1 / 2 |

- **What it costs:**
  - On spot, a host is an 8id at $0.029–0.071 an hour (`r8id`'s $0.161 in 1c is the outlier), when one has room, against `c8i-flex.large`'s $0.032–0.043. That is up to about +$0.03 an hour per host, about +$22 a month per always-on host, at most about +$88 a month at `maxHosts` 4.
  - With the 8id types' scores at 1, most launches may still end on `c8i-flex.large`.
  - On demand, a host is the cheapest listed type with room, `c8i-flex.large` ($0.08902) first (the on-demand fallback rule above). So `r8id.large`'s $0.16632 is paid only when every cheaper type has no room.
  - Spot prices move; the scores are one evening's.
- **What differs per type:** the instance store's size (all 118 GB here, formatted by `bootstrap.sh` whatever its size) and memory. Placement packs memory, and the cap bounds the count. Nothing else in nestd or Firecracker differs.
- **Rollout:**
  - inframe applies the cell stack (the IAM policy, the launch template's user data and `AWS_CELLS`), then the Worker reads the new `AWS_CELLS`.
  - Running hosts don't change.
  - The cap applies to new placements: a host already holding more keeps them.
- **What a rollback does:** reverting puts the previous four types, the wildcard patterns and no cap back. A host of a type no longer listed keeps running until it retires.

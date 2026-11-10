# Checkpoint cuts, M2 (2026-11-03)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and nothing by hand.** The merge's own `deploy.yml` run does all of it. No Durable Object class is added, and the guest image doesn't change. The wire gains one optional field, `commit_request.cut_ms` (and `GenerationRecord.cut_ms`), which either side of the previous release ignores (zod strips it, and serde has no unknown-field refusal).
- **The first run failed at `infra` (2026-11-03, run 41714276937), and nothing reached production.**
  - EC2 refused both launch templates' new versions: `InvalidUserData.Malformed: User data is limited to 16384 bytes`. The new `bootstrap.sh` with `install.sh` inside is 18.5 KB.
  - Image Builder's component, recipe and pipeline had already applied (`install.sh` with `xfsprogs`); they matter only at the next AMI build.
  - The templates, `AWS_CELLS`, the Worker and the release stayed the previous release's, and every later deploy would fail the same way.
  - Fixed by gzipping both templates' user data (`base64gzip`; cloud-init unpacks it), now about 6.7 KB. `test_the_user_data_fits_ec2s_limit_gzipped` keeps it under half the limit.
  - The next merge's run applies M2 as the order below says.
- **What production does, in order** (the pipeline's order, all automatic):
  1. **`infra`** applies the `use1` cell stack through inframe:
     - The launch template's user data becomes the new `bootstrap.sh`: sandbox state goes on the instance store when there is one.
     - The cell's `AWS_CELLS` entry gets the new `launchTypes`: `c8id.large` first, then `c8i-flex.large`, `c8i.large` and `m8i.large` for capacity. `launch_types_within_iam` keeps them inside IAM's `EightIOnly` patterns.
     - Running hosts don't change.
  2. **`worker`** deploys. `dev/deploy-use1.sh` reads the new `AWS_CELLS`, so FleetDO launches `c8id.large` first once it restarts on the new config (minutes, as for any deploy). SandboxDO records `cut_ms` from hosts that send it.
  3. **`release`** publishes the new nestd to `releases/current/` and starts a host AMI build. That AMI carries `xfsprogs` from `install.sh`.
  4. **Hosts take it as they are replaced** (scale-down, spot loss): a host installs `releases/current/` at boot.
     - A new `c8id` host formats its instance store and cuts disks with a reflink.
     - A host on an EBS-only type (no `c8id` capacity) keeps state on the root volume and pauses for whole reads, as M1 does.
- **Existing hosts, on the root volume,** keep running the previous nestd with M1's checkpoints until they are replaced. Nothing moves them sooner: there is no drain route. A spot loss or the autoscaler's scale-down replaces them, and sandboxes cold-boot elsewhere from their generations. That is safe and costs nothing extra.
- **Any order is safe,** so a partial run or a re-run is too:
  - Either release's nestd works with either layout (`state_dir`, the kernel, images and jail paths are all in nestd.json).
  - A host booted between steps 1 and 3 runs the previous nestd on the new layout. It finds state in the instance store's `state` directory and pauses for reads.
  - A previous-release Worker ignores `cut_ms`.
  - `bootstrap.sh` falls back to the root volume when any instance-store step fails: no `mkfs.xfs` (an AMI built before step 3, should one lack it), a format or a mount failing, or no reflink. The host still enrolls (`test_sandbox_host_whose_instance_store_wont_format`).
  - Where the store is used, nestd, nest-proxy and the gateway require its mount (`RequiresMountsFor` drop-ins). A host whose store comes back blank after a stop and start fails to start them, and nestd refuses to start without its kernel and images, so it never enrolls broken. Nest only terminates hosts, so only a hand-made stop does this.
- **What the owner sees** (measured 2026-11-03, [disk](../../docs/sandbox/state/disk/)): a checkpoint on a `c8id` host pauses its VM for the clone. That is about 14 ms on a fresh disk, and grows with the disk's extent records: about 2.4 s after 1 GiB of churn, about 8 s after a simulated month. An M1 checkpoint of a changed disk pauses for reading it whole: 33–39 s in production. M3′ is to remove the growth.
- **Cost** (us-east-1, Linux, from AWS's own APIs, verified 2026-11-02: the Price List API's `get-products` for [on demand](https://aws.amazon.com/ec2/pricing/on-demand/), `describe-spot-price-history` for [spot](https://aws.amazon.com/ec2/spot/pricing/); the owner approved it 2026-11-03):
  - On demand, `c8id.large` (1 × 118 GB NVMe instance store) is $0.11088 an hour, and `c8i-flex.large` (EBS only) $0.08902: +$0.02186 an hour, about +$16 a month per always-on host.
  - On spot, `c8id.large` was $0.029–0.058 an hour and `c8i-flex.large` $0.026–0.043, by AZ (spot prices move). In the cell's AZs (1a, 1b, 1c), `c8id` was $0.029, $0.031 and $0.058 against flex's $0.032, $0.043 and $0.038. So on spot the difference is a few dollars a month per host either way, and `c8id` was the cheaper of the two in 1b and 1c.

  Hosts scale to zero when idle, so the delta follows sandbox hours. `maxHosts` (4) bounds it at about +$64 a month on demand.
- **Compatibility one release back:**
  - A new nestd on an old host (root-volume state) probes reflink on the root XFS and uses it if present, else pauses for reads.
  - A `cut-*.img` left in an incarnation's directory is removed by a new nestd at start, and deleted with the directory by an old one.
- **What a rollback does:**
  - Reverting the merge and letting `deploy.yml` run puts the EBS-only types first again and the previous `bootstrap.sh` in the template. Hosts are replaced, never changed in place.
  - `wrangler rollback` drops `cut_ms` from new records.
  - A republished previous release pauses for whole reads, on either layout.
- **Cloud check after a `c8id` host comes up** (anyone with the admin token; host logs need a shell on the host):
  - bootstrap's log says "sandbox state on the instance store at /srv/nest (XFS, reflink)", and nestd's says "checkpoints cut disks with a reflink";
  - a turn-end checkpoint logs `checkpoint: disk cut ... paused_ms=`, then `commit: cut read`;
  - `GET /v1/sandboxes/<id>/generations` shows `cut_ms` on the new turn ends;
  - a hands call made during a checkpoint returns.

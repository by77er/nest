import Cell.Stack

/-! The cells nest runs. -/

namespace Cell

/-- `use1`: us-east-1, in nest's dedicated AWS account. -/
def use1 : CellSpec :=
  { name := "use1", region := "us-east-1", accountId := "589531222691"
    controlUrl := "https://nest.bitcru.sh"
    -- Instance-store types first (sandbox state on XFS with reflink, so a checkpoint pauses a VM only
    -- for a clone; docs/sandbox/state/disk/), cheapest first, then the EBS-only types for capacity
    -- (their checkpoints pause for whole reads). Only types with nested virtualization, on a CPU
    -- Firecracker supports, with local NVMe: the 8id families (I7i is Emerald Rapids, which
    -- Firecracker doesn't list). c8id.large is scarce in the cell's zones (spot placement score 1 of
    -- 10 on 2026-11-03), so m8id and r8id stand behind it (dev/deploy.md, "instance types").
    instanceFamilies := ["c8id", "m8id", "r8id", "c8i-flex", "c8i", "m8i"]
    -- MITIGATION (2026-11-05): EBS-only types only, until the instance-store path is fixed. On an
    -- instance-store host bootstrap puts the jailer's chroots under /var/lib/nest/data, and the
    -- gateway's unit hides /var/lib/nest (InaccessiblePaths), so it can't reach a VM's vsock socket:
    -- every hands call failed on the first such host (i-0515bad00a5794f0b, 2026-11-04). The
    -- instance-store types come back with the fix (dev/deploy.md, "instance-store hosts").
    launchTypes := ["c8i-flex.large", "c8i.large", "m8i.large"]
    -- 14 × 8 GB fits the 118 GB store of every listed instance-store type
    -- (`sandboxes_fit_their_disk`); a c8i-flex.large held 14 by memory in the stress test.
    maxSandboxesPerHost := 14
    -- 14 × 8 GB + 24 GB for the OS, images and cache: an EBS-only host (the on-demand fallback's
    -- cheapest types) or one whose store couldn't be used holds its sandboxes on the root volume.
    -- gp3 at $0.08/GB-month: +$8.80 a month per always-on host over the old 30 GB.
    hostRootGb := 140
    -- us-east-1 Linux on demand, micro-USD an hour (Price List API `get-products`, 2026-11-03 and
    -- -04): FleetDO tries on demand cheapest first.
    onDemandPrices := [("c8i-flex.large", 89020), ("c8i.large", 93710), ("m8i.large", 105840), ("c8id.large", 110880),
      ("m8id.large", 130520), ("r8id.large", 166320), ("t3a.medium", 37600), ("t3.medium", 41600)]
    -- From the stress test (dev/cloud-checks/stress-2026-10-31.md): a c8i-flex.large held 14 idle
    -- sandboxes, so 4 hosts take about 50; 16 Haiku brains ran on a t3a.medium (about 105 MB each,
    -- CPU peaking near 60%), so 12 leaves room for heavier sessions, and 3 hosts hold 36. 14 vCPU in
    -- all, under the account's 32 spot vCPUs.
    maxHosts := 4
    maxBrainsPerHost := 12 }

end Cell

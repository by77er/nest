import Cell.Stack

/-! The cells nest runs. -/

namespace Cell

/-- `use1`: us-east-1, in nest's dedicated AWS account. -/
def use1 : CellSpec :=
  { name := "use1", region := "us-east-1", accountId := "589531222691"
    controlUrl := "https://nest.bitcru.sh"
    -- Instance-store types first (sandbox state on XFS with reflink, so a checkpoint pauses a VM only
    -- for a clone; docs/sandbox/state/disk/), then the EBS-only type for capacity (its checkpoints
    -- pause for whole reads). Only types with nested virtualization, on a CPU Firecracker supports
    -- (I7i is Emerald Rapids, which Firecracker doesn't list). Memory decides how many sandboxes a
    -- host holds (the commit rule below), so the most memory comes first: r8id.large (16 GiB) holds
    -- five default sandboxes, m8id and m8i (8 GiB) two. The 4 GiB types (c8id, c8i-flex, c8i) hold
    -- none and are no longer launched (`launch_types_hold_a_sandbox`); their families stay in IAM.
    instanceFamilies := ["c8id", "m8id", "r8id", "c8i-flex", "c8i", "m8i"]
    launchTypes := ["r8id.large", "m8id.large", "m8i.large"]
    -- A host's sandboxes may be declared up to 150% of its memory less its own reserve. Their
    -- memory is demand-paged, so they rarely all reach their size at once; at 100% a 16 GiB host
    -- would hold three. Free memory alone admitted six 4 GiB sandboxes to a 4 GiB host, whose VMs
    -- the kernel then killed (2026-11-18). Unmeasured: the right ratio for real workloads.
    memoryCommitPct := 150
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
    -- Under the commit rule an r8id.large holds five default sandboxes, so 4 hosts take 20 placed at
    -- once (suspended ones move off when room is needed). 16 Haiku brains ran on a t3a.medium in the
    -- stress test (dev/cloud-checks/stress-2026-10-31.md; about 105 MB each,
    -- CPU peaking near 60%), so 12 leaves room for heavier sessions, and 3 hosts hold 36. 14 vCPU in
    -- all, under the account's 32 spot vCPUs.
    maxHosts := 4
    maxBrainsPerHost := 12 }

end Cell

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
    -- three default sandboxes, m8id and m8i (8 GiB) one. The 4 GiB types (c8id, c8i-flex, c8i) hold
    -- none and are no longer launched (`launch_types_hold_a_sandbox`); their families stay in IAM.
    instanceFamilies := ["c8id", "m8id", "r8id", "c8i-flex", "c8i", "m8i"]
    launchTypes := ["r8id.large", "m8id.large", "m8i.large"]
    -- A host's sandboxes are declared no more than its memory less its own reserve: no overcommit.
    -- A working guest does reach its size (its page cache fills it, and nothing takes memory back
    -- from a guest: no balloon), so anything above 100% loses VMs. At 150%, between 2026-11-18 and
    -- -19, the kernel killed a VMM 13 times on 8 GiB hosts holding two 4 GiB sandboxes, each time
    -- with both at 3.4 to 4.0 GiB (the hosts' journals, `logs/` in the cell's bucket).
    memoryCommitPct := 100
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
    -- 12 hosts take 24 default sandboxes placed at once on the 8 GiB types and 60 on r8id.large
    -- (suspended ones move off when room is needed). 4 was sized for r8id.large alone: with none on
    -- spot (2026-11-18) the cell filled at 8 sandboxes on four 8 GiB hosts, and the rest waited
    -- unplaced. 24 vCPU, with the brain hosts' 6 under the account's 32 spot vCPUs; its 16 on-demand
    -- vCPUs stop the fallback at 8 hosts (Service Quotas, 2026-11-18).
    -- 16 Haiku brains ran on a t3a.medium in the stress test (dev/cloud-checks/stress-2026-10-31.md;
    -- about 105 MB each, CPU peaking near 60%), so 12 leaves room for heavier sessions, and 3 hosts
    -- hold 36.
    maxHosts := 12
    maxBrainsPerHost := 12 }

end Cell

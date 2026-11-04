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
    launchTypes := ["c8id.large", "m8id.large", "r8id.large", "c8i-flex.large", "c8i.large", "m8i.large"]
    -- 14 × 8 GB fits the 118 GB store of every listed instance-store type
    -- (`sandboxes_fit_the_instance_store`); a c8i-flex.large held 14 by memory in the stress test.
    maxSandboxesPerHost := 14
    -- From the stress test (dev/cloud-checks/stress-2026-10-31.md): a c8i-flex.large held 14 idle
    -- sandboxes, so 4 hosts take about 50; 16 Haiku brains ran on a t3a.medium (about 105 MB each,
    -- CPU peaking near 60%), so 12 leaves room for heavier sessions, and 3 hosts hold 36. 14 vCPU in
    -- all, under the account's 32 spot vCPUs.
    maxHosts := 4
    maxBrainsPerHost := 12 }

end Cell

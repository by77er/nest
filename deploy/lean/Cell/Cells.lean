import Cell.Stack

/-! The cells nest runs. -/

namespace Cell

/-- `use1`: us-east-1, in nest's dedicated AWS account. -/
def use1 : CellSpec :=
  { name := "use1", region := "us-east-1", accountId := "589531222691"
    controlUrl := "https://nest.bitcru.sh"
    -- An instance store first (c8id: sandbox state on XFS with reflink, so a checkpoint pauses a VM
    -- only for a clone; docs/sandbox/state/disk/), the EBS-only types behind it for capacity (their
    -- checkpoints pause for whole reads). c8id.large is about 25% dearer on demand than
    -- c8i-flex.large and about the same on spot (dev/deploy.md, "checkpoint cuts").
    launchTypes := ["c8id.large", "c8i-flex.large", "c8i.large", "m8i.large"]
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

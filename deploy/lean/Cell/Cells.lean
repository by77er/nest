import Cell.Stack

/-! The cells nest runs. -/

namespace Cell

/-- `use1`: us-east-1, in nest's dedicated AWS account. -/
def use1 : CellSpec :=
  { name := "use1", region := "us-east-1", accountId := "589531222691"
    controlUrl := "https://nest.bitcru.sh"
    launchTypes := ["c8i-flex.large", "c8i.large", "c8id.large", "m8i.large"]
    -- From the stress test (dev/cloud-checks/stress-2026-10-31.md): a c8i-flex.large held 14 idle
    -- sandboxes, so 4 hosts take about 50; 16 Haiku brains ran on a t3a.medium (about 105 MB each,
    -- CPU peaking near 60%), so 12 leaves room for heavier sessions, and 3 hosts hold 36. 14 vCPU in
    -- all, under the account's 32 spot vCPUs.
    maxHosts := 4
    maxBrainsPerHost := 12 }

end Cell

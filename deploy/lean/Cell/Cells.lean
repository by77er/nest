import Cell.Stack

/-! The cells nest runs. -/

namespace Cell

/-- `use1`: us-east-1, in nest's dedicated AWS account. -/
def use1 : CellSpec :=
  { name := "use1", region := "us-east-1", accountId := "589531222691"
    controlUrl := "https://nest.bitcru.sh"
    launchTypes := ["c8i-flex.large", "c8i.large", "c8id.large", "m8i.large"]
    -- Stress test (dev/cloud-checks/, 2026-10-31), temporary: past the account's 32 spot vCPUs on
    -- purpose (16 sandbox hosts + 4 brain hosts at 2 vCPU each is 40), and 16 brains per t3a.medium
    -- to find where memory runs out. Set back to measured values once the run is done.
    maxHosts := 16
    brainMaxHosts := 4
    maxBrainsPerHost := 16 }

end Cell

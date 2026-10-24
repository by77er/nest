import Edge.Stack

/-! The edge nest runs behind. -/

namespace Edge

/-- The `bitcru.sh` zone and the `bitcrush` Zero Trust team, one owner. -/
def bitcrush : EdgeSpec :=
  { accountId := "8dbec6148300483801d721889a2f4749", zone := "bitcru.sh", label := "nest", ownerEmail := "by77er@gmail.com" }

end Edge

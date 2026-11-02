import Projects.Stack

/-! The values the app runs with: nest's zone, account and owner (from nest's own edge stack, not
secrets), copied here because this project imports nothing from nest's `deploy/`. -/

namespace Projects

/-- `projects-nest.bitcru.sh`, in the `bitcru.sh` zone and the `bitcrush` Zero Trust team. -/
def bitcrush : ProjectsSpec :=
  { accountId := "8dbec6148300483801d721889a2f4749", zone := "bitcru.sh", name := "projects-nest"
    ownerEmail := "by77er@gmail.com" }

end Projects

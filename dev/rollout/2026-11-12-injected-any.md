# `injected: "*"` in request guards (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for [any injected credential](../../docs/sandbox/networking/egress/policy/#any-injected-credential).

**Not a one-way deploy. One ordering constraint, enforced by the control plane:** a guard naming `injected: "*"` is accepted only once every sandbox host of its cell runs this release's nest-proxy.
- **Why:** a nest-proxy of the previous release reads `*` as a binding's name, which no binding has. In an exception that fails closed (the guard refuses what the exception would have let through); in a scope it fails open (the guard stops refusing what that matcher covered). `crates/nest-proxy/tests/guard_equivalence.rs` shows both.
- **How it's enforced (the `nest-wire` capability-flag pattern, as for `guard_bounds`):** nestd's fleet hello says `guard_injected_any: true` (nest-proxy ships with it); FleetDO records it per host (`hosts.guard_injected_any`, default 0).
  - **Writes:** the base layer's `PUT`, the operator layer's `PUT …/policy` and `POST /v1/sandboxes {policy}`, a client's create, client-layer write, and an agent's attach are refused (409) when they bring a guard newly naming `*` while any sandbox host of the cell, any not dead, lacks the flag. A write whose `*` guards are all already stored goes through.
  - **Placement:** FleetDO places a sandbox whose policy names `*` in a scope only on a host with the flag; with none free, it waits unplaced. One naming it only in exceptions goes anywhere (there an old host only refuses more).
- **Control plane:** a FleetDO column (`hosts.guard_injected_any`); a client's `injected` also takes `*`, in exceptions only. No new stored keys: `*` is stored where guards already are.
- **nest-proxy:** `injected: "*"` matches any substituted binding. A named `injected` decides as before.
- **In the gap** (the Worker deployed, a cell's hosts one release behind): guards naming `*` are refused in that cell; everything else runs as before.
- **Operators and apps:** write a `*` floor (for example in the base layer) only after the cell's hosts are replaced; a 409 names the hosts still to go. Check `GET …/policy` for the guards you rely on.
- **What a rollback does:**
  - **A control-plane rollback:**
    - The previous release ignores `hosts.guard_injected_any` and refuses nothing for `*`. The operator's `*` (base and operator layers) still reaches nest-proxy verbatim, as the previous release passes the operator's guards through. It has no placement gate either, so with hosts of the previous release in the cell too, a sandbox whose scopes name `*` can land on one, where that scope fails open.
    - It sends a client's stored `*` as `client:*`, which matches nothing: only exceptions can hold one, so those guards fail closed (refuse what the exception would have let through) until rolling forward.
    - It refuses (400) a client's write or spawn override carrying `*`, and skips a template carrying one when it reads the catalog (CatalogDO logs it), so spawns from that template fail until rolling forward.
  - **A host rollback** (hosts of the previous release launched again): sandboxes whose scopes name `*` are never placed on them and wait unplaced if only those are free. Sandboxes whose `*` is only in exceptions may land there and have writes needing a nest credential refused (fail closed). New `*` guards in the cell are refused until the old hosts are replaced.
  - **Rolling forward** reads the flag again from each host's next hello.

# `injected: "*"` and `at` in request guards (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for [any injected credential](../../docs/sandbox/networking/egress/policy/#any-injected-credential).

**Before deploying, check the stored layers.** This release changes what an existing `injected: "*"` means, from "the binding named `*`" to "any binding", and refuses new bindings named `*` or the empty name. Read every cell's base layer (`GET /v1/admin/egress/base?cell=<cell>`) and every live sandbox's operator layer (`GET /v1/sandboxes/<id>/policy`, its `guards` and `inject`). Look for a guard matcher with `injected: "*"` or a binding named `*`, and rewrite any you find before deploying. None is expected: nothing has written one.

**Not a one-way deploy. One ordering constraint, enforced by the control plane:** a guard using `injected: "*"` or `at` is accepted only once every sandbox host of its cell runs this release's nest-proxy.
- **Why:** a nest-proxy of the previous release reads `*` as a binding's name and ignores `at`.
  - **Fails closed** (refuses what the matcher would have let through): `*` in an exception, with or without `at`; `at` in a scope without a binding named.
  - **Fails open** (stops refusing): `*` in a scope; `at` with a binding named, in a scope; `at` without `*`, in an exception.
  - `crates/nest-proxy/tests/guard_equivalence.rs` shows each.
- **How it's enforced (the `nest-wire` capability-flag pattern, as for `guard_bounds`):** nestd's fleet hello says `guard_injected_any: true` (nest-proxy ships with it); FleetDO records it per host (`hosts.guard_injected_any`, default 0).
  - **Writes:** the base layer's `PUT`, the operator layer's `PUT …/policy` and `POST /v1/sandboxes {policy}`, a client's create, client-layer write, and an agent's attach are refused (409) when they bring a guard newly using `*` or `at` while any sandbox host of the cell, any not dead, lacks the flag. A write whose such guards are all already stored goes through.
  - **Placement:** FleetDO places a sandbox whose guards hold a fail-open position, in its policy or in the cell's base layer as FleetDO holds it, only on a host with the flag; with none free, it waits unplaced. Fail-closed positions go anywhere: there an old host only refuses more.
- **Control plane:** a FleetDO column (`hosts.guard_injected_any`); a client's `injected` also takes `*`, in exceptions only, and its matchers take `at`. The operator layer refuses a binding named `*` or the empty name. No new stored keys: guards are stored where they already are.
- **nest-proxy:** `injected: "*"` matches any substituted binding; `at` asks for a header the substitution wrote whole. A named `injected` without `at` decides as before. The wire gains `RequestMatch.at`, optional, which an old proxy ignores.
- **In the gap** (the Worker deployed, a cell's hosts one release behind): guards using `*` or `at` are refused in that cell; everything else runs as before.
- **Operators and apps:** write a floor (for example `allow: [{injected: "*", at: authorization}]` in the base layer) only after the cell's hosts are replaced; a 409 names the hosts still to go. Check `GET …/policy` for the guards you rely on.
- **What a rollback does:**
  - **A control-plane rollback:**
    - The previous release ignores `hosts.guard_injected_any` and refuses nothing for `*`. The operator's `*` (base and operator layers) still reaches nest-proxy verbatim, as the previous release passes the operator's guards through. It has no placement gate either, so with hosts of the previous release in the cell too, a sandbox whose scopes name `*` can land on one, where that scope fails open.
    - It sends a client's stored `*` as `client:*`, which matches nothing: only exceptions can hold one, so those guards fail closed (refuse what the exception would have let through) until rolling forward. It passes a client's stored `at` through, which this release's proxies decide.
    - It refuses (400) a client's write or spawn override carrying `*` or `at`, and skips a template carrying one when it reads the catalog (CatalogDO logs it), so spawns from that template fail until rolling forward.
    - It accepts an operator binding named `*` again; check for one before rolling forward (above).
  - **A host rollback** (hosts of the previous release launched again): sandboxes whose guards hold a fail-open position are never placed on them and wait unplaced if only those are free. Sandboxes with only fail-closed ones (the floor) may land there and have writes needing a nest credential refused. New `*` or `at` guards in the cell are refused until the old hosts are replaced.
  - **Rolling forward** reads the flag again from each host's next hello.

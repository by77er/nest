# An operator's drain of a host (2026-11-18)

Not a one-way deploy, and no ordering constraint.

- **What it adds:** `POST /v1/admin/hosts/<id>/drain` and `FleetDO.drainHost`: the forced drain a spot notice starts, asked for by hand. No stored state, no wire field: the drain is the existing `drain_ms`, and the host gets the `sandbox_suspend` it already knows.
- **In the gap after the Worker deploys:** a FleetDO still on the previous release answers the route 503 ("isn't running yet after a deploy"); ask again.
- **What a rollback does:** the route is gone (404). A host already draining stays draining: that state is the previous release's own.

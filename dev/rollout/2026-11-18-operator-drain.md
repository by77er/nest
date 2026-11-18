# An operator's drain of a host (2026-11-18)

Not a one-way deploy, and no ordering constraint.

- **What it adds:** `POST /v1/admin/hosts/<id>/drain` and `FleetDO.drainHost`: the forced drain a spot notice starts, asked for by hand. No stored state, no wire field: the drain is the existing `drain_ms`, and the host gets the `sandbox_suspend` it already knows.
- **In the gap after the Worker deploys:** a FleetDO still on the previous release answers the route 503 ("isn't running yet after a deploy"); ask again.
- **What a rollback does:** the route is gone (404). A host already draining stays draining: that state is the previous release's own.
- **Using it:** a drain can't be undone, and a draining host takes nothing new, so drain one host at a time and the next only once a replacement host is active and connected. Watch `GET /v1/admin/fleet` until the host's leases reach 0 and it goes `dead`; if a sandbox stays `running` for minutes, ask again. Never `confirm-dead` or terminate a host that still shows leases: that is the lossy path this replaces.

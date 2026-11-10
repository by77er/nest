# Policy sources (2026-11-02)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** Only the API view of a sandbox's effective policy changes: each allow rule gains `source` (`base`, `operator`, `repos`, `client`, `grant`; [sources](../../docs/sandbox/networking/egress/policy/#sources)), and `layer` stays beside it. The policy sent to hosts is unchanged.
- **Readers:** keep reading `layer` for this release if they must; drop it next release, when `layer` leaves the API view. The dashboard and the e2e harness read neither.
- **What a rollback does:** the API view loses `source` (the previous release answers the wire policy). Nothing is stored.
- **Cloud check:** `GET /v1/sandboxes/<id>/policy` on a `use1` sandbox lists `registry.npmjs.org` as `source: base`, and a client sandbox's own rule as `source: client`.

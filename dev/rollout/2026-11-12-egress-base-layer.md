# The base egress layer as operator data (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class is added and no wire message changes: the base layer's rules reach hosts as before (`layer: base`). FleetDO gains the table `egress_base_notices`, kv `egress_base`, the `egress_base` deadline and the methods `egressBase` and `setEgressBase`, and `registerSandbox` now answers the base layer. SandboxDO gains kv `egress_base`, the `egress_base` deadline and `egressBaseChanged`. The routes are `GET`/`PUT /v1/admin/egress/base?cell=` ([base layer](../../docs/sandbox/networking/egress/policy/#base-layer)).

**Nothing changes until the operator writes the layer.** The seed is exactly the hosts nest had built in, on ports 80 and 443, with no guards.

- **Mixed versions within a deploy:**
  - A FleetDO still on the previous code answers `registerSandbox` with nothing, so the sandbox keeps the seed. It lacks `egressBase`, so the routes answer 503 (`retryable`).
  - A SandboxDO still on the previous code lacks `egressBaseChanged`. The notice fails and is retried with backoff (2 s doubling, at most every 10 minutes) until it answers.
- **What a `wrangler rollback` does with what this release wrote:**
  - **A previous release ignores the stored base layer and uses its constant** (today's list), in FleetDO and SandboxDO alike. The previous Worker has no `/v1/admin/egress/base` route (404).
  - **A sandbox keeps the policy its proxy already holds** until its next policy change. The previous release then sends the constant's base rules, without the operator's base guards.
  - **Its alarms drop what they don't know.** The previous FleetDO's alarm drops a due `egress_base` deadline. The roll-forward's FleetDO constructor arms it again while notices wait, and every waiting sandbox is told then. The previous SandboxDO's alarm drops its own `egress_base` deadline. A sandbox that held the new layer then sends it at its next policy change after the roll-forward.
  - **To make every sandbox carry a layer at once** after a roll-forward, `PUT` it again.
- **No shim to drop.** `BASE_ALLOW` stays as the seed.
- **Cloud check:**
  1. `GET /v1/admin/egress/base?cell=use1` answers `version: 0` and the nine hosts.
  2. `PUT` the same nine hosts plus a guard refusing `PUT` to `registry.npmjs.org`. Within seconds `pending` is 0, and a running sandbox's `GET /v1/sandboxes/<id>/policy` shows the guard.
  3. `PUT` the nine hosts alone to undo it.
  4. An API client's token gets 401 on both routes.

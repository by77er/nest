# `hosts_not_ready`: the refusal while a cell's hosts don't apply guards yet (2026-11-13)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for [request guards](../../docs/control-plane/api/clients/#request-guards).

**Not a one-way deploy, and no ordering constraint.** The 409 a create, a layer write or an attach gets while a sandbox host of its cell lacks `guard_bounds` (client guards) or `guard_injected_any` (`injected: "*"`, `at`) now says `code: "hosts_not_ready"` instead of `conflict`; its status (409), `retryable` (false) and message are unchanged, so a client can wait for it without reading the message (the projects app matches the code, and the message for one release).

- **Wire:** a new error code in both lists (`ErrorCodes`, `model::error_codes::ALL`, `protocol/fixtures/codes.json`). It reaches API clients and, through an agent's spawn, a runner's tool error, which passes any code through. No stored state.
- **What a `wrangler rollback` does:** the previous release answers `conflict` again; a client matching the message as well (the projects app does, for one release) still tells it apart.

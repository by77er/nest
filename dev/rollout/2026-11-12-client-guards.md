# API clients' request guards (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)), for [request guards](../../docs/control-plane/api/clients/#request-guards).

**Not a one-way deploy, and no ordering constraint.**
- **Control plane:** new optional fields (`guards` in the client layer, sandbox specs, templates, spawn overrides and stored agent specs) and two SandboxDO kv keys (`client_guards`, `agent_guards`). Client guards reach nest-proxy as ordinary `RequestGuard`s in `EgressPolicy.guards`, which every running proxy already evaluates: no wire change.
- **nest-proxy:** decodes a guarded host's request once instead of per matcher (the same decisions: `tests/guard_equivalence.rs`), and refuses a request to a guarded host whose path is over 4096 bytes or 256 segments or whose query is over 8192 bytes or 256 parameters (414 `request_target_too_long`). That applies to the GitHub rules' hosts too: a longer URL to `github.com`, `*.github.com` or `*.githubusercontent.com` from a sandbox now fails.
- **In the gap** (the Worker deployed, hosts one release behind): an old proxy decodes per matcher, so a sandbox's client guards cost it more per request, within the control plane's per-sandbox bounds (32 guards, 64 scope matchers, 512 matcher work), on unbounded targets. No client app sets guards before B3, so in practice the gap has none.
- **Apps:** send `guards` only to a control plane whose `GET …/client-policy` answers them, and check `GET …/policy` for the `client:` guards they rely on.
- **What a rollback does:**
  - **Refused (400):** `PUT …/client-policy` and client spawn overrides carrying `guards`.
  - **Silently dropped, with a 2xx (fails open):** `POST /v1/sandboxes`, template writes and the operator's spawn overrides carrying `guards`. What they make has none of the refusals.
  - **Stored guards stop applying:** the previous release ignores the new kv keys and spec fields, so its next policy push for a sandbox leaves the client guards out (the operator's guards and the GitHub rules are unaffected). It strips `guards` from a template when it reads it. An agent detached under it leaves its `agent_guards` entry behind, which this release ignores (only attached agents' keys count).
  - **Rolling forward** applies the stored guards again at each sandbox's next policy push, which nothing forces: an app rewrites its client layers (`PUT …/client-policy`) to get them back at once. A template written during the rollback must be written again.
  - **A host rollback** (the previous nest-proxy) takes back the per-request bounds; the control plane's bounds still hold.

So an app must not rely on client guards for a refusal it can't lose until this release is settled.

# API clients' secrets: expiry and push on write (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class is added and no wire message changes: `InjectionSecret.expires_ms` already exists and nest-proxy already honours it. BrokerDO gains the tables `client_secret_sandboxes` and `client_secret_pushes`, an alarm, and the methods `writeClientSecret`; SandboxDO gains `clientSecretsChanged`, the `client_secrets` deadline and `kv.client_push_fails`. The client route `PUT /v1/clients/self/secrets/<name>` takes `expires_at`; its answer and the listings gain `expires_ms` and `sandboxes` ([secrets](../../docs/control-plane/api/clients/#secrets)).

- **Mixed versions within a deploy:** a BrokerDO still on the previous code lacks `writeClientSecret`, so a `PUT` answers 503 (`retryable`) rather than storing a value without its expiry. A notice to a SandboxDO still on the previous code fails ("does not implement") and is retried, 1 s doubling, ten times; its 15-minute push carries the change regardless.
- **What a `wrangler rollback` does with what this release wrote:**
  - An expiry is stored in `secrets.expires_ms`, which the previous release already reads: it never resolves an expired client secret, so nothing expired reaches a proxy. Its pushes don't carry `expires_ms`, so a proxy holds a value pushed before the expiry until its next push (at most 15 minutes past it), then drops it.
  - The previous Worker's `ClientSecretPut` is strict: a `PUT` with `expires_at` answers 400 until the roll-forward. Its `PUT` without one stores the value with no expiry, as now.
  - The previous BrokerDO doesn't record who asked or push on write: changes reach sandboxes at their 15-minute push. It has no alarm handler, so a scheduled alarm runs nothing; the roll-forward's BrokerDO re-arms it in its constructor when notices wait. Rows it leaves behind are stale at worst: a notice to a sandbox that no longer uses the secret answers `unbound` and forgets it.
  - The previous SandboxDO has no `client_secrets` handler: a due one is dropped, and `inject_refresh` carries the change. It ignores `kv.client_push_fails`.
- **No shim to drop.** `putClientSecret` stays for a Worker one release behind; it can go in the release after this one.
- **Cloud check:** a client with `secrets` in its grant stores a secret bound into one of its running sandboxes with `expires_at` an hour out; within seconds `GET /v1/clients/self/secrets` shows `sandboxes: 1` and `last_injected_ms` advanced; a request with the placeholder still gets through; `DELETE` the secret, and within seconds the same request is refused with `credential_unavailable`.

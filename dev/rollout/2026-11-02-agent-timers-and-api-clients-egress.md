# Agent timers; API clients' egress rules, environment and live client layer (2026-11-02)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy.** No Durable Object class is added (AgentDO gains a table, `timers`, and deadlines `timer:<name>`; SandboxDO kv keys; CatalogDO seed version 9 adds the capability `timers`). The host wire gains one optional field, `agent_attach.env`, which a nestd of the previous release ignores (no unknown-field refusal). Deploy the Worker, then hosts as they are replaced.
- **The gap after the deploy:** a Durable Object still on the previous code for minutes lacks the new methods. These answer `503` (`internal`, retryable), never 500:
  - `GET` and `DELETE /v1/agents/<id>/timers…` (AgentDO);
  - `GET` and `PUT /v1/sandboxes/<id>/client-policy` (SandboxDO);
  - a grant's `PATCH` while one of the client's sandboxes can't take it (`PATCH` again);
  - a request whose `env` is checked for secret values (`BrokerDO.scanSecretValues`).

  A timer set meanwhile is armed by the new code. A previous AgentDO meeting a `timer:` deadline logs "no handler" and drops it; the row stays, and this release arms it again when the agent's object starts or its next alarm runs (the hourly `prune`), so it fires late, never not at all.
- **Hosts of the previous release:** their slots get no `env` until they are replaced. Everything else (egress rules, bindings) is in the policy and secrets they already apply.
- **Stored data (expand-only):** ClientDO's record gains `grant_rev` and `grant_epoch` (absent: a new epoch at revision 0, written at the next read); AgentDO `timers`; grants may carry `egress_hosts` (absent: none); templates may carry `egress` and `env`, specs `egress` and `env`; SandboxDO kv `client_egress`, `client_env`, `client_egress_hosts` (the hosts and the grant revision they were read at), `agent_egress`, `agent_env`, and the `egress_ceiling` deadline (a 15-minute re-read while it has client rules). Catalogs gain `timers` at seed version 9 (only where the name is free); adding it to templates is the operator's (or a client's) step.
- **What a rollback does:**
  - The previous code has no handler for `timer:` deadlines: a timer due during the rollback isn't fired then (logged) and its row stays; after the roll forward it is armed again and fires late. Its schemas strip `timer_*` from the registry (a stored spec naming them lists tools its registry lacks: ignored) and `egress`/`env` from templates and specs.
  - Its SandboxDO never reads the new kv keys, so a client's rules leave the next policy, and slots configured again get no env.
  - The `/timers` and `/client-policy` routes answer 401 (an unknown route to a non-operator).
  - After the roll forward, everything stored is read again, and the next policy push restores the rules.
- **Operator steps after the deploy:** add `timers` to the templates whose agents should wait (`PUT /v1/admin/templates/<t>`; a client adds it to its own). For a client that needs hosts the base policy refuses, `PATCH /v1/admin/clients/<cli> {grant}` with `egress_hosts` (`PATCH` replaces the whole grant).
- **Cloud check:**
  1. **Timers:** on `use1`, an agent of a template with `timers` sets `timer_set {name: "probe", after_s: 15, note: "ping"}` and ends its turn. Within about 20 s a new turn starts whose input is `Message from timer: timer "probe" fired: ping` (the live trace shows `timer_set`, then `timer_fired`), and `GET /v1/agents/<id>/timers` is empty after. A second timer cancelled with `DELETE /v1/agents/<id>/timers/<name>` never fires.
  2. **Egress:** a client with `egress_hosts: ["nodejs.org"]` creates `POST /v1/sandboxes {"cell": "use1", "egress": {"allow": [{"host": "nodejs.org"}]}}`. In it, `curl -sI https://nodejs.org/dist/index.json` answers 200, and `https://example.com` answers 403 `egress_denied`. Then `PUT …/client-policy {}` (rules emptied), and nodejs.org answers 403 too.
  3. **Env:** with `env: {"APP_ENV": "staging"}` in that sandbox's create, on a host of this release, an attached agent's `Bash` `echo $APP_ENV` prints `staging`. `PUT …/client-policy {"env": {"APP_ENV": "prod"}}` makes the next `echo` print `prod`.

# Trace history (2026-11-02)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy.** No Durable Object class, table or host change: AgentDO gains a method (`traceHistory`) and the Worker a route (`GET /v1/agents/<id>/trace/history`); the trace's connect gains a `history` message and `gap.before`, which a client of the previous release ignores (an unknown `type`, an extra field).
- **The gap after the deploy:** an AgentDO still on the previous code answers "does not implement" and the route answers `503` (`internal`, `retryable: true`); its connects send no `history` message. A client retries.
- **What a rollback does:** the route answers 401 to a client (an unknown route) and 404 to the operator; nothing was stored.
- **Cloud check:** with the projects client's token (or the operator's), `GET /v1/agents/agt_01m6f7rj7yryjtn7tvsm6q9y26/trace/history` (a worker with a 129-line transcript and an empty ring) answers 200 with `turn_started`, `assistant_text`, `tool_call` and `tool_result` events: every `tool_call`'s `call_id` is a `tool_use` id in `GET …/transcript`, with its `name`. Page it with `limit=20` and `before=<next_before>` until `next_before` is `null`: the pages joined equal one unlimited read. Another client's token answers 404.

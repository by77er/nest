# Restart only between turns (2026-11-10)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, stored field or host change. `POST /v1/agents/<id>/start` takes `when: "idle"` (with `restart: true`). AgentDO gains a method, `restartWhenIdle`, and the API a new error code, `busy` (409, retryable; in `protocol/fixtures/codes.json` and both mirrors).
- **In the gap after the deploy:** an AgentDO still on the previous code for minutes has no `restartWhenIdle`. The route answers `503` (`internal`, retryable), with nothing stored or restarted. It is never sent to the previous `restartWith`, which would restart regardless of turns.
- **What a rollback does:** the previous Worker's route body is strict, so it refuses `when` with a 400 (unknown field). Nothing is stored or restarted, and a caller can tell the release doesn't have it. Nothing was stored that the previous release reads differently.
- **Turns held behind a restart** (any restart, with or without `when`): AgentDO starts no turn while a restart is pending, and gives the restart up after 5 retryable failures in a row (`restart_error` on the record, `agent.error` `restart_refused` to a client). Stored as an optional `restart_failures` count and `restart_error` on the agent's record, which the previous release ignores. A rollback brings back turns sent while a restart is pending, which its condemn then cuts.
- **Readers of error codes:** a client that switches on codes sees `busy` only from this route with `when`.

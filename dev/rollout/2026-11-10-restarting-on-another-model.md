# Restarting on another model (2026-11-10)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, stored field or host change. `POST /v1/agents/<id>/start` takes `launch` with `restart: true`, and now refuses unknown fields (it took and ignored them before). AgentDO gains a method, `restartWith`. What it stores is the agent's existing launch (`model`, `effort`), which every release reads.
- **In the gap after the deploy:** an AgentDO still on the previous code for minutes has no `restartWith`: the route answers `503` (`internal`, retryable) and nothing is stored or restarted.
- **What a rollback does:** the previous Worker's route ignores `launch` and restarts the brain on the launch already stored. Its answer has no `launch` field, which is how a caller tells. A launch stored before the rollback is the agent's launch: the previous release starts brains with it, as with any launch.
- **Readers:** a caller sending a field the route doesn't know now gets a 400 rather than having it ignored.
- **Cloud check:** with a client on `use1` whose agent is idle, `POST /v1/agents/<id>/start {"restart": true, "launch": {"model": "<another model>"}}` answers with that model in `launch`. The next `agent_start` to its brain host carries it and a `resume` of the same session, and the agent's next turn answers with its earlier turns in context.

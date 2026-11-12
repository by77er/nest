# A client at capacity: `429 at_capacity` (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, stored field, route or host change. A new error code, `at_capacity` (429, retryable), is in `protocol/fixtures/codes.json` and both mirrors.
- **Where it's sent:** ClientDO's `admit` sends it for a full `max_agents` or `max_sandboxes` (`POST /v1/agents`, `POST /v1/sandboxes`, `agent_spawn`). `agent_spawn` also sends it past a spawner's live children. Each of these was `403 forbidden` (not retryable) before. A cell outside the grant, a maximum of 0 and the spawn depth stay `403 forbidden`.
- **API clients one release back:**
  - A client that treated any 403 as "never" now gets a 429 with `retryable: true` for these refusals.
  - A generic client retries it, or reports it as throttling. Both fit: a place frees once fewer than the maximum of the client's agents or sandboxes are live.
  - A client whose own retry loop has no bound will keep asking until there's room. The answer is cheap, ClientDO's one step, and creates nothing.
  - A client that matched the 403's message text no longer matches: the status and code changed. The message keeps naming the limit, and now starts with it (`max_sandboxes: …`). Key on `code === "at_capacity"`.
- **Hosts:** the runner and nest-mcp carry error codes as strings, so an agent's `agent_spawn` result with the new code reaches Claude as any other tool error. Nothing on a host parses it.
- **In the gap after the deploy:** a ClientDO or AgentDO still on the previous code for minutes answers `403 forbidden` as before.
- **What a rollback does:** the previous Worker answers `403 forbidden` again, and nothing was stored that it reads. A refused `agent_spawn` under this release took its `children` row back, which is also what the previous release did for a non-retryable refusal.

# Transcript grants (2026-11-06)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class is added and no host changes. AgentDO gains a table (`grants`, `CREATE TABLE IF NOT EXISTS`) and a method (`grantFor`); `readTranscript` takes an optional fourth argument; `POST /v1/agents` and `agent_spawn` take `grants`; the registry gains `list` and `read_transcript.since_ms`, which reach a runner only through `tools_list`. A `wrangler rollback` fails closed: the previous Worker refuses `grants` in `POST /v1/agents` (400) and ignores the `grants` table, so agents created with grants read only themselves and what they own, and `list` and grant-offered tools vanish from their next `tools_list`. Mid-deploy, an AgentDO of the previous release answers `grantFor` with an error, which the chain treats as revoked, and ignores the window argument, which the reader applies again.

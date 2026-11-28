# Repeating timers (2026-11-28)

[Timers](../../docs/agents/capabilities/timers/README.md): `timer_set`'s `every_s`, a repeating timer that fires at its interval until cancelled.

- **Not a one-way deploy, and no ordering constraint.** No new Durable Object class or table. AgentDO's `timers` gains two nullable columns, `every_ms` and `every_id` (the id the interval was set with), added by `ALTER TABLE` when the table is opened (`TimerStore`'s constructor). A row repeats only while `every_id` equals its `id`; a row without them, as every row before this release, is a one-shot timer.
- **Wire:** `timer_set`'s input gains an optional `every_s` (the brain's tool schema, `platform-tools.json`, which runners read from AgentDO at run time, not from their own release); timers as listed, the trace's `timer_set` and `timer_fired`, and the owner event `agent.timer_fired` gain optional fields (`every_ms`, `next_ms`). A reader of the previous release ignores them.
- **The schema and its handler ship in one Worker bundle,** so there's no gap in which a brain is offered `every_s` that its AgentDO can't take.
- **A `wrangler rollback`:**
  - The previous release reads `timers` without the new columns, so a repeating timer fires once more and is then deleted, as a one-shot timer is. An agent that relied on it gets no further firings and isn't told. After the roll-forward, the agent sets it again.
  - A name the previous release sets again keeps the old `every_ms` and `every_id` (its upsert doesn't know them) but gets a new `id`, so after the roll-forward it reads as the one-shot timer it set, never as the repeating one it replaced.
  - A brain started under this release still lists `every_s` in its tools until it restarts; under the rolled-back release a call with it is refused as an unknown property.
  - The columns stay, ignored.
- **No shim to drop.**

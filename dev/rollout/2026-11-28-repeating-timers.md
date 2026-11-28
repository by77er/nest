# Repeating timers (2026-11-28)

[Timers](../../docs/agents/capabilities/timers/README.md): `timer_set`'s `every_s`, a repeating timer that fires at its interval until cancelled.

- **Not a one-way deploy, and no ordering constraint.** No new Durable Object class or table. AgentDO's `timers` gains a nullable column, `every_ms`, added by `ALTER TABLE` when the table is opened (`TimerStore`'s constructor); a row without it, as every row before this release, is a one-shot timer.
- **Wire:** `timer_set`'s input gains an optional `every_s` (the brain's tool schema, `platform-tools.json`); timers as listed, the trace's `timer_set` and `timer_fired`, and the owner event `agent.timer_fired` gain optional fields (`every_ms`, `next_ms`). A reader of the previous release ignores them. Nothing crosses to hosts: the runner passes tool arguments through.
- **In the gap after the Worker deploys,** before every AgentDO runs this release: an AgentDO of the previous release refuses `every_s` (its `timer_set` arguments are a strict object), so an agent sees an error and can set the timer again a moment later.
- **A `wrangler rollback`:** the previous release reads `timers` without `every_ms`, so a repeating timer fires once more and is then deleted, as a one-shot timer is. An agent that relied on it gets no further firings and isn't told. After the roll-forward, the agent sets it again. The column stays, ignored.
- **No shim to drop.**

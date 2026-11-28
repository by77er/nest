# Repeating timers (2026-11-28)

[Timers](../../docs/agents/capabilities/timers/README.md): `timer_set`'s `every_s`, a repeating timer that fires at its interval until cancelled.

- **Not a one-way deploy, and no ordering constraint.** No new Durable Object class. AgentDO gains a table, `timer_repeats` (`CREATE TABLE IF NOT EXISTS`); `timers` is unchanged. A timer repeats while its `timer_repeats` row has the timer's id.
- **Wire:** `timer_set`'s input gains an optional `every_s` (the brain's tool schema, `platform-tools.json`, which runners read from AgentDO at run time, not from their own release); timers as listed, the trace's `timer_set` and `timer_fired`, and the owner event `agent.timer_fired` gain optional fields (`every_ms`, `next_ms`). A reader of the previous release ignores them.
- **The schema and its handler ship in one Worker bundle,** so there's no gap in which a brain is offered `every_s` that its AgentDO can't take.
- **A `wrangler rollback`:**
  - The previous release reads `timers` alone: a repeating timer that comes due fires once, as a one-shot timer (`timer/<id>`, the one-shot text), and its row is deleted. Its `timer_repeats` row stays.
  - After the roll-forward, the next start or alarm run of each AgentDO restores it on its cadence (its input `timer/<id>` is in the inbox), without the agent having to set it again. One the previous release cancelled, or whose name it set again (a new id), is forgotten; so is an ended agent's.
  - Firings the timer would have had during the rollback are not made up.
  - A firing this release posted and then failed to move on (an alarm retry pending) when the rollback landed may be posted again by the previous release under its own key (`timer/<id>`), so the agent may see that one firing twice.
  - A brain started under this release still lists `every_s` in its tools until it restarts; under the rolled-back release a call with it is refused as an unknown property.
- **No shim to drop.**

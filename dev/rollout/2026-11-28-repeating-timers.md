# Repeating timers (2026-11-28)

[Timers](../../docs/agents/capabilities/timers/README.md): `timer_set`'s `every_s`, a repeating timer that fires at its interval until cancelled.

- **Not a one-way deploy, and no ordering constraint.** No new Durable Object class. AgentDO gains two tables, `timer_repeats` and `timer_notices` (`CREATE TABLE IF NOT EXISTS`), and a deadline key, `timer_notices`; `timers` is unchanged. A timer repeats while its `timer_repeats` row has the timer's id.
- **Wire:** `timer_set`'s input gains an optional `every_s` (the brain's tool schema, `platform-tools.json`, which runners read from AgentDO at run time, not from their own release); timers as listed, the trace's `timer_set` and `timer_fired`, and the owner event `agent.timer_fired` gain optional fields (`every_ms`, `next_ms`). A reader of the previous release ignores them.
- **The schema and its handler ship in one Worker bundle,** so there's no gap in which a brain is offered `every_s` that its AgentDO can't take.
- **A `wrangler rollback`:**
  - The previous release reads `timers` alone: a repeating timer that comes due fires once, as a one-shot timer (`timer/<id>`, the one-shot text), and its row is deleted. Its `timer_repeats` row stays, ignored.
  - **Repeating timers end with a rollback.** After the roll-forward, the next start or alarm run of each AgentDO forgets every repeat that release left behind, and tells the agent of each one that release fired, once: `timer "<name>" stopped repeating … set it again with every_s if you still want it`. The notice is a platform note: it doesn't end an operator's stop (it waits for other input then), and otherwise wakes the agent, which starts a brain for it. None is restored: nothing that release leaves says whether the agent set the name again or cancelled it since. One that didn't come due during the rollback is still in `timers` with its repeat, and repeats on.
  - The proof that it fired is its inbox row, kept 7 days: after a longer rollback the repeat is forgotten untold.
  - A firing this release posted and then failed to move on (an alarm retry pending) when the rollback landed may be posted again by the previous release under its own key (`timer/<id>`); and one the previous release posted and failed to delete is posted again by this release under `timer/<id>/<at_ms>`. Either way the agent may see that one firing twice.
  - A brain started under this release still lists `every_s` in its tools until it restarts; under the rolled-back release a call with it is refused as an unknown property.
  - A `timer_notices` deadline the previous release finds has no handler there and is dropped; `rearmTimers` arms it again after the roll-forward while notices wait.
- **No shim to drop.**

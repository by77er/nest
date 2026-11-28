# Timers

**Decided (2026-11-02):** a kernel capability, `timers`, that any template may name (the operator's or a client's in its namespace). An agent sets a named timer; when it fires, the agent gets an input and wakes for it. There is no blocking wait.

**Decided (2026-11-28): timers repeat.** A timer set with `every_s` fires again at that interval until it's cancelled or its agent ends: a daily digest, a weekly check-in. This is the repeating half of the `wake_at` design ([capabilities](../#tools-and-capabilities)), built on timers rather than as a second scheduler.

## Tools

- **`timer_set {name, after_s? | at_ms?, every_s?, note?}`**:
  - Exactly one of `after_s` (seconds from now) and `at_ms` (Unix epoch ms). With `every_s`, at most one: it sets the first firing, which is otherwise one interval from now.
  - At least 10 s and at most 30 days ahead.
  - `every_s` (a repeating timer's interval) is 300 to 2,592,000 (5 minutes to 30 days). The floor is because each firing is a turn a brain runs, on the subscription.
  - `name` is `[a-z0-9][a-z0-9_.-]{0,62}`; `note` is at most 1,000 characters.
  - At most 32 live timers per agent, of which at most 8 repeat. Setting a name again replaces its timer and takes no new place.
  - Answers the timer `{name, at_ms, note, set_ms, every_ms?}`. Setting a repeating timer's name again without `every_s` makes it one-shot.
- **`timer_cancel {name}`**: says whether there was one. It's the only way a repeating timer stops for good, short of its agent's end.
- **A stop holds against a repeating timer** (decided 2026-11-28): while an operator's `stop` holds (`quietSinceStop`), a repeating timer moves on at each firing without posting, so it never wakes a stopped agent; the next input from elsewhere ends the stop, and it fires again from then. A one-shot timer still wakes a stopped agent, once, as any input does.
- **`timer_list`**: `{timers: [{name, at_ms, note, set_ms, every_ms?}]}`, soonest first; `at_ms` is a repeating timer's next firing.
- **From the brain only:** never from a sandbox's `nest` CLI, as for the lifecycle tools.

## When one fires

- **The input:** an inbox message from `timer`, `timer "<name>" fired: <note>`, through the inbox path (`postInbox`):
  - **During a turn:** pushed into that turn, as an inbox message is.
  - **Between turns:** a turn of its own (`input_kind: inbox`, text `Message from timer: timer "<name>" fired: <note>`), which wakes the agent: an idle brain runs it, and a detached or stopped agent's brain is started for it, exactly as for an inbox message (a repeating timer's firing excepted while an operator's stop holds: below).
  - **An ended agent's** timers are dropped at its end (rows and deadlines); one found later is dropped too.
- **A repeating timer** says so in its input: `timer "<name>" fired (repeats every 1 day; timer_cancel stops it): <note>`. Once its input is posted, its row moves to its next firing and its deadline is armed for it, in one synchronous step. The next firing keeps the timer's cadence: one interval after the firing that was due, or, when it fired late (an outage longer than the interval), the first point of that cadence after now. Missed firings aren't made up, and neither are firings while an earlier one hasn't been taken in: a queued turn no brain could run (no capacity, a failing start), or a message pushed into a running turn that the runner hasn't confirmed (a turn parked for quota). Those are skipped, the timer moving on, so an outage costs one input rather than one per interval. A retried alarm's own firing isn't one: it is posted again (deduplicated) and traced. A skipped firing (waiting, or a stop holding) is in neither the trace nor the owner's events; the timer's `at_ms` moves on. One case lets one more through: a firing that went into a turn requeued from unconfirmed messages keyed by another message, or into a recovery turn, isn't recognized, so the next firing is queued too (then that one holds the rest).
- **Once:** the post carries the timer's id as its request id (`timer/<id>`; a repeating timer's adds the firing's time, `timer/<id>/<at_ms>`, so each firing is posted once and each is posted), so a retried alarm posts it once, and only then is its row deleted or moved on. A timer set again, or cancelled, while it fired is left as that left it (the delete and the move match the timer's id), and two runs of one firing at once move it on once (the move matches the firing's time too). A firing already posted when its alarm is retried completes as posted (traced, and its event sent), even if a stop came in between.
- **Visible:** in the [live trace](../../../control-plane/api/#live-trace) as `timer_set {name, at_ms, note, every_ms?}`, `timer_fired {name, note, next_ms?}` and `timer_cancelled {name, by}`. An API client's agent's firing is also an [owner event](../../../control-plane/api/clients/#events-to-the-owner), `agent.timer_fired {agent, timer, note, next_ms?}`; `next_ms` is a repeating timer's next firing.
- **The owner** lists them with `GET /v1/agents/<id>/timers` (`{timers: […]}`) and cancels one with `DELETE /v1/agents/<id>/timers/<name>` (404 if there's none). The owner is the operator, or the API client of the agent's subtree. Only the agent sets them.

## Durability

- **Storage:** AgentDO's SQLite holds them (`timers`: `name`, `id`, `at_ms`, `note`, `set_ms`; and, added 2026-11-28, `timer_repeats`: `name`, `id`, `every_ms`, a table the previous release never touches; and `timer_notices`, below), and each has one deadline of AgentDO's existing alarm (`Deadlines`, key `timer:<name>`). A row and its deadline are written in one synchronous step.
- **A timer left without its deadline** (a rolled-back release dropped it, having no handler) is armed again when the agent's object starts and at every alarm run: late, never lost.
- **A timer repeats while its `timer_repeats` row has the timer's id.** This release writes and deletes the two rows in one step. A release that doesn't know repeats (a rollback) touches only `timers`: it fires a due repeating timer once, as a one-shot, and deletes it; its re-set of a name gets a new id, which reads as the one-shot timer it set.
- **After a rollback, every repeat it left behind is forgotten** at the next start or alarm run (`orphanedRepeats`), never restored: nothing that release leaves says what the agent did with the name since (set it again, cancelled it), so a restore could bring back a timer the agent cancelled. One that release fired (its input `timer/<id>` is in the inbox) is told to the agent instead, once, from the alarm (`timer_notices`), as a platform note: it doesn't end an operator's stop, and waits for other input if one holds: `timer "<name>" stopped repeating (every <interval>) during a platform rollback, after firing once: set it again with every_s if you still want it.` An ended agent's are forgotten untold.
- **No second scheduler.** A timer survives a brain restart, the brain host's loss, a deploy and the Durable Object's eviction, because nothing about it is in memory.

## Open questions

- **A repeating timer's cost has no budget.** Each firing is a turn on the subscription. An agent may have 8 repeating timers at the 5-minute floor (96 turns an hour), and each agent it spawns as many. A stop holds against them, and cancelling them ends them; `wake_at`'s turn budget ([capabilities](../#tools-and-capabilities)) would bound the rest. Until then, the floor, the cap and coalescing do.

## Waiting is a pattern, not a tool

- **To wait for something:** set a timer, then end the turn. Whichever comes first wakes the agent: an inbox message (a person's answer, another agent's report, an app's notice) or the timer.
- **When the other came first,** cancel the timer.
- **"Wait until X" is the app's job.** nest doesn't watch a domain condition (a PR merged, a deploy done, a ticket moved). The app that knows X posts to the agent's inbox (`POST /v1/agents/<id>/inbox`) when X holds, and the agent sets a timer for the timeout.
- **Why no blocking tool:** a brain held in a tool call keeps a turn open, can't take other input, and loses the wait on any restart. A timer costs nothing while it waits and survives everything.

# Timers

**Decided (2026-11-02):** a kernel capability, `timers`, that any template may name (the operator's or a client's in its namespace). An agent sets a named timer; when it fires, the agent gets an input and wakes for it. There is no blocking wait.

## Tools

- **`timer_set {name, after_s? | at_ms?, note?}`**:
  - Exactly one of `after_s` (seconds from now) and `at_ms` (Unix epoch ms).
  - At least 10 s and at most 30 days ahead.
  - `name` is `[a-z0-9][a-z0-9_.-]{0,62}`; `note` is at most 1,000 characters.
  - At most 32 live timers per agent. Setting a name again replaces its timer and takes no new place.
  - Answers the timer `{name, at_ms, note, set_ms}`.
- **`timer_cancel {name}`**: says whether there was one.
- **`timer_list`**: `{timers: [{name, at_ms, note, set_ms}]}`, soonest first.
- **From the brain only:** never from a sandbox's `nest` CLI, as for the lifecycle tools.

## When one fires

- **The input:** an inbox message from `timer`, `timer "<name>" fired: <note>`, through the inbox path (`postInbox`):
  - **During a turn:** pushed into that turn, as an inbox message is.
  - **Between turns:** a turn of its own (`input_kind: inbox`, text `Message from timer: timer "<name>" fired: <note>`), which wakes the agent: an idle brain runs it, and a detached or stopped agent's brain is started for it, exactly as for an inbox message.
  - **An ended agent's** timers are dropped at its end (rows and deadlines); one found later is dropped too.
- **Once:** the post carries the timer's id as its request id (`timer/<id>`), so a retried alarm posts it once, and only then is its row deleted. A timer set again for later while it fired keeps its new row and deadline.
- **Visible:** in the [live trace](../../../control-plane/api/#live-trace) as `timer_set {name, at_ms, note}`, `timer_fired {name, note}` and `timer_cancelled {name, by}`. An API client's agent's firing is also an [owner event](../../../control-plane/api/clients/#events-to-the-owner), `agent.timer_fired {agent, timer, note}`.
- **The owner** lists them with `GET /v1/agents/<id>/timers` (`{timers: […]}`) and cancels one with `DELETE /v1/agents/<id>/timers/<name>` (404 if there's none). The owner is the operator, or the API client of the agent's subtree. Only the agent sets them.

## Durability

- **Storage:** AgentDO's SQLite holds them (`timers`: `name`, `id`, `at_ms`, `note`, `set_ms`), and each has one deadline of AgentDO's existing alarm (`Deadlines`, key `timer:<name>`). A row and its deadline are written in one synchronous step.
- **No second scheduler.** A timer survives a brain restart, the brain host's loss, a deploy and the Durable Object's eviction, because nothing about it is in memory.

## Waiting is a pattern, not a tool

- **To wait for something:** set a timer, then end the turn. Whichever comes first wakes the agent: an inbox message (a person's answer, another agent's report, an app's notice) or the timer.
- **When the other came first,** cancel the timer.
- **"Wait until X" is the app's job.** nest doesn't watch a domain condition (a PR merged, a deploy done, a ticket moved). The app that knows X posts to the agent's inbox (`POST /v1/agents/<id>/inbox`) when X holds, and the agent sets a timer for the timeout.
- **Why no blocking tool:** a brain held in a tool call keeps a turn open, can't take other input, and loses the wait on any restart. A timer costs nothing while it waits and survives everything.

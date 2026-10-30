# TaskLedgerDO

A **task ledger**: a small issue tracker (a simple Linear) that agents read and write through the `tasks` capability and administer through `tasks-admin`. One object per ledger, keyed `ledger/<name>`.

## Decisions

- **A ledger is its own named primitive (2026-10-30).** It is keyed by a name (a label value: letters, digits, `_`, `.`, `-`, at most 64), not by a workstream: workstreams are going from the platform ([orchestration](../../../orchestration/workstreams/)), and a ledger never calls or reads WorkstreamDO. Nothing creates a ledger: its first write does.
- **An agent's ledger is a capability parameter.** `tasks` and `tasks-admin` declare the `ledger` param; the operator gives it at spawn (`overrides.params.ledger`, or a template's `params` default) and the agent's expanded spec records it ([CatalogDO](../catalog/)). The tools act on that ledger only: an optional `ledger` argument must name it, and an agent spawned without one gets a clear `forbidden` from every task tool. A spawner's child gets no parameters at all, not even a template's default, until grants attenuate them against the spawner's own.
- **Decisions are a pure core** (`control-plane/src/lib/tasks.ts`, the [sans-IO direction](../../../verification/nestd/)): `applyTaskOp(ledger, actor, op, {now, newId}) → {task, put, history, comment, watcher, notices} | refusal`. It reads the ledger only through synchronous lookups, takes the time and the new id as inputs, and throws nothing. The DO is the shell: look up, apply, persist everything in one synchronous step with the alarm, then deliver notices from that alarm.
- **Privilege is the tool.** Each tool asks for exactly one operation kind (`TOOL_OPS`: `task_update` → `update`, `task_assign` → `assign`, …), and AgentDO's per-call check that the tool is in the agent's spec is the only grant check. The admin kinds (`update_any`, `assign`, `cancel`, `set_watcher`) are reachable only through `tasks-admin` tools. The core knows only two actors: an agent, bound to its one ledger (its creates and updates bounded below), and the operator (the root, through the admin API). An earlier `admin` flag on the actor was a second source of truth for the same fact and was dropped.

## Data

- **Task:** `id` (`tsk_…`), `number` (the key is `T-<n>`, dense per ledger), `title` (1–200), `description` (markdown, ≤ 20,000), `status` (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`), `priority` (`none`, `urgent`, `high`, `medium`, `low`), `assignee` (agent id or null), `labels` (≤ 10, `[A-Za-z0-9][A-Za-z0-9_.:/-]{0,39}`), `parent` (a task of the same ledger; never a cycle), `created_by` (agent id or `operator`), `created_ms`, `updated_ms`, `version`, `tainted` ([taint](#taint)).
- **`version`** starts at 1 and is bumped by every change (a comment isn't one). Writes may pass `expected_version`; a stale one is refused with `conflict` (409). An update that changes nothing is a no-op. A missing task is `not_found` (404).
- **History:** one row per changed field (`actor`, `field`: a task field or `created`, `from`, `to`, `ms`). Until it is pruned (below), replaying it over the task as created gives the task as it is (property-tested).
- **Comments:** `author`, `body` (≤ 10,000), `ms`, `tainted`; at most 1,000 per task, after which a comment, or a cancel with a reason, is refused, never dropped.
- **The watcher:** one agent per ledger, told when a task reaches `in_review`, `done` or `canceled`. Interim: it becomes a subscription to the ledger's channel when ledgers post to channels.
- **Stored values:** a status or priority outside its enum (a hand edit, a later release's value) is logged and listed as read; `update` and `claim`, which need it, refuse it cleanly, and an admin's `task_update_any` repairs it.
- **Storage:** `tasks` (the JSON body, plus copies of `status`, `assignee`, `parent`, `labels` and a lower-cased `title + description` for filtering), `comments`, `history`, `outbox`, `applied`, `kv` (`name`, `next`, `watcher`, `last_prune`). At most 10,000 open tasks per ledger.

## Who may do what

| Operation | Tool (capability) | Rule |
|---|---|---|
| list, get | `task_list`, `task_get` (`tasks`) | Anyone with the ledger. Filters: `status`, `assignee` (`me`, an id, or null for unassigned), `label`, `text`, `parent`; pages of ≤ 200 by key (`cursor`) |
| create | `task_create` (`tasks`) | Unassigned, `priority: none`, in `backlog` (default) or `todo`; an optional parent |
| update | `task_update` (`tasks`) | Only a task assigned to or created by the caller: title, description, labels, and status along the transitions below. Priority, parent and assignment are refused |
| claim | `task_claim` (`tasks`) | An unassigned `backlog` or `todo` task becomes the caller's, `in_progress`. Not a task in progress or in review: one an admin unassigned in review waits for a reviewer the admin picks, and a claimant could otherwise move it to `done` itself. A held task is a `conflict`; with `expected_version` it is compare-and-set. No notice (nobody else held it) |
| comment | `task_comment` (`tasks`) | Any task in the ledger |
| assign | `task_assign` (`tasks-admin`) | To an agent whose spec grants this ledger (its `ledger` param, and a task tool), or null |
| update any | `task_update_any` (`tasks-admin`) | Any field of any task, any status; not assignment (that is `task_assign`, which checks and notifies) |
| cancel | `task_cancel` (`tasks-admin`) | Any task not yet canceled; a reason becomes a comment |
| watcher | `task_set_watcher` (`tasks-admin`) | An agent whose spec grants this ledger, or null |

**Transitions for `task_update`:** `backlog ↔ todo`, `backlog|todo → in_progress`, `in_progress → todo|in_review|done`, `in_review → in_progress|done`. `done` and `canceled` are final for it: an admin reopens. Only an admin cancels.

**Arguments:** "nobody" is JSON `null` (`assignee`, `watcher`, `parent`, the `assignee` filter). `task_list`'s `assignee` also takes `me`: an agent isn't told its own id in its prompt, and listing its own tasks is the common read.

## Notices

- **Assignment** (by `task_assign`, or an operator's create) posts to the assignee's inbox, and to a previous assignee that it moved away.
- **Reaching `in_review`, `done` or `canceled`** posts to the task's creator, its assignee and the ledger's watcher, each once and never the actor (the assignee too, so a task an admin cancels reaches the agent working on it). No workstream event.
- **No agent-written text in a notice:** only the key, the status, the agent ids and the ledger (`T-12 is done (by agt_…, ledger <name>); task_get reads it`), so a notice can't carry a tainted title past its reader. The recipient reads the task with `task_get`.
- **Channel-shaped, delivered through the inbox for now:** a notice is `{channel: "<agt>/inbox", post: {kind: task_assigned | task_status, text, data: {ledger, key, status, assignee}}}`, and an `outbox` row is `(id, channel, body)`, the shape a channel outbox keeps. One function, `deliverNotice`, knows where a channel's post goes: today `<agt>/inbox` is AgentDO's `postInbox` (untainted: the text is the platform's), keyed `ledger/<name>/<row>` so a retry is applied once. Not a channel post yet: an agent on a seeded template has no `read`, so a [ChannelDO](../channel/) notice would be taken but not shown to it. In channels' stage 2 (every agent can read its own inbox) `deliverNotice` becomes a `post` to `<agt>/inbox` from the principal `platform`, idempotent on the same key, and the outbox table may become the shared channel outbox (`lib/outbox.ts`); nothing else in the ledger changes. The watcher becomes a subscription to the ledger's channel, `ledger/<name>`, a name channels already reserve.
- **Delivery is from the ledger's alarm only,** never inside a write: an AgentDO calling the ledger has its input gate open at that await, so a callback would interleave with the call that caused it. A row is written with the change and deleted once `deliverNotice` returned; a failure is retried after 1 s doubling to 5 min; a notice to an agent that doesn't exist is dropped and logged. A notice wakes an idle agent like any inbox post.

## Idempotency and concurrency

- A tool call's write carries `<agent>/<epoch>/<call>`; the operator's carries `request_id` or `Idempotency-Key`. The ledger keeps each applied key's outcome, per operation kind, for 7 days and answers a repeat with it, so a call re-run after an eviction creates nothing twice, and a request id reused on another route is a new request.
- A model that retries after `outcome_unknown` makes a new call with a new key: a `task_create` may then run twice (creates have no natural key). The runner tells the model to check before retrying; `task_list` shows the duplicate.
- An assignee's or watcher's spec is read by the caller (AgentDO, or the Worker for the operator) before the ledger is called. Within the ledger, an operation has no await between its reads and its writes.

## Operator API

Admin auth. `GET /v1/ledgers/<name>` (`{ledger, watcher, tasks}`) · `PUT /v1/ledgers/<name>/watcher {watcher}` · `GET|POST /v1/ledgers/<name>/tasks` · `GET|PATCH /v1/ledgers/<name>/tasks/<key|id>` · `POST …/tasks/<key|id>/assign {assignee, expected_version?}` · `POST …/tasks/<key|id>/comments {body}`. A create may set any status, a priority and an assignee; `PATCH` is `update_any`. The list filter `assignee=none` means unassigned (a query string has no null). There is no route under `/v1/workstreams/`.

## Retention

At most 10,000 open tasks per ledger: a create (or a reopen) beyond it is refused, and closing tasks makes room. Closed tasks are kept, and are the one table here without a bound: about twice their text each (the body and its search copy), against SQLite-backed Durable Object storage of 10 GB per object ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/), unverified for this account). Archiving them (to R2 after N days, keeping a stub with key and status) is an open question below. Comments and history of a task `done` or `canceled` more than 30 days ago are deleted; history keeps the latest 500 rows per task; `applied` keys 7 days; `outbox` rows until delivered. The prune runs daily from the alarm ([data](../../../data/#retention)).

## Taint

The ledger keeps the [taint](../../../agents/tools/#taint-and-sinks) of what it holds, from the stand-in AgentDO tracks today (`sessionTaint`: hands, a tainting built-in, or a tainted read, sticky). AgentDO reads the caller's taint just before each write, after any await.
- **A task is tainted** once a tainted session created it or changed its text (title, description, labels), and stays so. Status moves, claims, assignment, priority and parent carry no agent text and don't taint it. The operator's writes never taint.
- **A comment** carries its writer's taint (a cancel's reason too).
- **Reads taint the reader:** every result says `tainted`, and AgentDO taints the session when it is true: `task_list` when a listed task is tainted, `task_get` when the task or a returned comment is, and a write's result when the task it returns whole is.
- **Notices never taint:** they carry no agent text.
- **It over-taints the way the stand-in does:** every hands agent is tainted, so a worker's tasks taint a captain that reads them. Quarantined reports are the designed way back ([taint](../../../agents/tools/#taint-and-sinks)).

## Deploying it

Adding the class is a **one-way deploy** ([deploy](../../../../dev/deploy.md)). A forward revert to the previous release leaves ledgers unreachable but intact, keeps spawning working (the seed migration edits no template), and the previous code ignores a stored spec's `params` and lists no `task_*` tool.

**Not built:** capability params granting more than one ledger, or a different one per capability (`tasks{ledgers: [...]}`, the extension point); a spawner passing on a ledger it holds (waits for `agent_spawn` and grants); posting notices to channels (stage 2, above); deleting a task or a ledger; a cap on retries (a notice to an agent that keeps failing retries every 5 minutes, and per-agent order isn't kept after a failure).

**Open:** a retention rule for closed tasks (archive their bodies to R2 after N days and keep a stub with key, status and version, or let the operator delete them); until then a ledger's closed tasks grow without bound. Also open: whether `task_list`'s `text` and `label` filters, which tell a clean reader one bit about tainted text (whether anything matches), need a tainting result; and a structured-only list (keys, statuses, assignees, no agent text) that wouldn't taint a captain triaging a worker-written board.

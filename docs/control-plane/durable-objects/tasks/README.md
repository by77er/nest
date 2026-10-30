# TaskLedgerDO

A **task ledger**: a small issue tracker (a simple Linear) that agents read and write through the `tasks` capability and administer through `tasks-admin`. One object per ledger, keyed `ledger/<name>`.

## Decisions

- **A ledger is its own named primitive (2026-10-30).** It is keyed by a name (a label value: letters, digits, `_`, `.`, `-`, at most 64), not by a workstream: workstreams are going from the platform ([orchestration](../../../orchestration/workstreams/)), and a ledger never calls or reads WorkstreamDO. Nothing creates a ledger: its first write does.
- **An agent's ledger is a capability parameter.** `tasks` and `tasks-admin` declare the `ledger` param; the operator gives it at spawn (`overrides.params.ledger`, or a template's `params` default) and the agent's expanded spec records it ([CatalogDO](../catalog/)). The tools act on that ledger only: an optional `ledger` argument must name it, and an agent spawned without one gets a clear `forbidden` from every task tool. A spawner can't set it (`SpawnerOverrides` stays narrow-only).
- **Decisions are a pure core** (`control-plane/src/lib/tasks.ts`, the [sans-IO direction](../../../verification/nestd/)): `applyTaskOp(ledger, actor, op, {now, newId}) → {task, put, history, comment, watcher, notices} | refusal`. It reads the ledger only through synchronous lookups, takes the time and the new id as inputs, and throws nothing. The DO is the shell: look up, apply, persist everything in one synchronous step with the alarm, then deliver notices from that alarm.
- **Grants are the spec.** AgentDO's per-call check (the tool is in the agent's spec) is the grant; a `tasks-admin` tool makes the caller an admin for that call. The core checks the actor's ledger again, so a direct call with the wrong ledger is refused too. The operator API acts as `operator`, the root.

## Data

- **Task:** `id` (`tsk_…`), `number` (the key is `T-<n>`, dense per ledger), `title` (1–200), `description` (markdown, ≤ 20,000), `status` (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`), `priority` (`none`, `urgent`, `high`, `medium`, `low`), `assignee` (agent id or null), `labels` (≤ 10, `[A-Za-z0-9][A-Za-z0-9_.:/-]{0,39}`), `parent` (a task of the same ledger; never a cycle), `created_by` (agent id or `operator`), `created_ms`, `updated_ms`, `version`.
- **`version`** starts at 1 and is bumped by every change (a comment isn't one). Writes may pass `expected_version`; a stale one is refused with `conflict` (409), which every boundary now knows (`protocol/fixtures/codes.json`). An update that changes nothing is a no-op.
- **History:** one row per changed field (`actor`, `field`, `from`, `to`, `ms`), plus `created`. Replaying it over the task as created gives the task as it is (property-tested).
- **Comments:** `author`, `body` (≤ 10,000), `ms`; at most 1,000 per task, after which a comment is refused, never dropped.
- **The watcher:** one agent per ledger, told when a task reaches `in_review`, `done` or `canceled`.
- **Storage:** `tasks` (the JSON body, plus copies of `status`, `assignee`, `parent`, `labels` and a lower-cased `title + description` for filtering), `comments`, `history`, `outbox`, `applied`, `kv` (`name`, `next`, `watcher`, `last_prune`). At most 10,000 tasks per ledger.

## Who may do what

| Operation | Tool (capability) | Rule |
|---|---|---|
| list, get | `task_list`, `task_get` (`tasks`) | Anyone with the ledger. Filters: `status`, `assignee` (`me`, `none`, an id), `label`, `text`, `parent`; pages of ≤ 200 by key (`cursor`) |
| create | `task_create` (`tasks`) | Unassigned, `priority: none`, in `backlog` (default) or `todo`; an optional parent |
| update | `task_update` (`tasks`) | Only a task assigned to or created by the caller: title, description, labels, and status along the transitions below. Priority, parent and assignment are refused |
| comment | `task_comment` (`tasks`) | Any task in the ledger |
| assign | `task_assign` (`tasks-admin`) | To an agent whose spec grants this ledger (its `ledger` param, and a task tool), or `none` |
| update any | `task_update_any` (`tasks-admin`) | Any field of any task, any status; not assignment (that is `task_assign`, which checks and notifies) |
| cancel | `task_cancel` (`tasks-admin`) | Any task not yet canceled; a reason becomes a comment |
| watcher | `task_set_watcher` (`tasks-admin`) | An agent whose spec grants this ledger, or `none` |

**Transitions for `task_update`:** `backlog ↔ todo`, `backlog|todo → in_progress`, `in_progress → todo|in_review|done`, `in_review → in_progress|done`. `done` and `canceled` are final for it: an admin reopens. Only an admin cancels.

## Notices

- **Assignment** posts to the assignee's inbox (`assigned T-12 (ledger <name>, by <actor>): <title>`), and to a previous assignee that it moved away.
- **Reaching `in_review`, `done` or `canceled`** posts to the task's creator, its assignee and the ledger's watcher, each once and never the actor (the assignee too, so a task an admin cancels reaches the agent working on it). No workstream event: when channels land, these become posts to the ledger's channel.
- **Delivery is from the ledger's alarm only,** never while a caller awaits the ledger (the AgentDO → ledger → AgentDO deadlock). Each notice is an `outbox` row written with the change; it is deleted once `postInbox` returned (keyed `ledger/<name>/<row>`, so a retry is applied once), retried after 1 s doubling to 5 min, and dropped (logged) for an agent that doesn't exist. A notice wakes an idle agent like any inbox post.

## Idempotency and concurrency

- A tool call's write carries `<agent>/<epoch>/<call>`; the operator's carries `request_id` or `Idempotency-Key`. The ledger keeps each applied key's outcome for 7 days and answers a repeat with it, so a call re-run after an eviction creates nothing twice.
- An assignee's or watcher's spec is read by the caller (AgentDO, or the Worker for the operator) before the ledger is called; the ledger never calls an AgentDO synchronously. Within the ledger, an operation has no await between its reads and its writes.

## Operator API

Admin auth. `GET /v1/ledgers/<name>` (`{ledger, watcher, tasks}`) · `PUT /v1/ledgers/<name>/watcher {watcher}` · `GET|POST /v1/ledgers/<name>/tasks` · `GET|PATCH /v1/ledgers/<name>/tasks/<key|id>` · `POST …/tasks/<key|id>/assign {assignee, expected_version?}` · `POST …/tasks/<key|id>/comments {body}`. A create may set any status, a priority and an assignee; `PATCH` is `update_any`. There is no route under `/v1/workstreams/` (ledgers aren't workstreams).

## Retention

Tasks are kept (the ledger is the record; at most 10,000). Comments and history of a task `done` or `canceled` more than 30 days ago are deleted; history keeps the latest 500 rows per task; `applied` keys 7 days; `outbox` rows until delivered. The prune runs daily from the alarm ([data](../../../data/#retention)).

## Deploying it

Adding the class is a **one-way deploy** ([deploy](../../../../dev/deploy.md)). A forward revert to the previous release leaves ledgers unreachable but intact, keeps spawning working (the seed migration edits no template), and the previous code ignores a stored spec's `params` and lists no `task_*` tool.

**Not built:** capability params granting more than one ledger, or a different one per capability (`tasks{ledgers: [...]}`, the extension point); a spawner passing on a ledger it holds (waits for `agent_spawn` and grants); a ledger channel for notices; deleting a task or a ledger.

# nest projects

A task board for GitHub repos, run by agents on nest: an app with its own Worker and Durable Objects, built only on nest's [API clients](../docs/control-plane/api/clients/) interface. nest knows nothing of projects, tasks or reviews. A feature here that seems to need one of nest's internals means that interface is wrong: fix it there, generically, and build this on the result.

**Status:** designed (2026-11-02, the owner's request). **Built:** the core: the Worker, the three Durable Objects, the catalog sync, the JSON API, the MCP servers and nest's webhook ([below](#built-the-core)), the UI ([below](#the-ui)), attaching a repo and the review pipeline ([below](#built-the-review-pipeline)), and auto-merge ([below](#auto-merge)). **Not built:** setting nest's webhook at first start, and starting a new manager once one ends (it's recorded in the chat). Builds on API clients, caller identity, events to the owner and GitHub tokens.

## What it does

- **Projects.** A project is attached to one GitHub repo the owner owns, one that nest's GitHub App is installed on and that the app's grant names.
- **The manager.** One agent per project, the one the owner talks to. It keeps the board, specs each task as it's created, and assigns tasks when the project is set to assign automatically.
- **Tasks.** The owner or the manager creates them, and the manager specs them. They're assigned by hand from the board, or automatically. An assigned task gets a worker of its own: one agent, which sees only that task and opens one PR for it.
- **Review.** Every PR on the repo gets a review by a reviewer agent, asynchronously. The review judges correctness, quality and architectural cohesiveness, and sets a required check. Branch protection, which the app sets up, makes merging wait for that check.
- **Done.** A task is done when its work is finished: for a task with a PR, when the PR is merged, which needs the review check to pass. Only a task with no PR and no live worker is marked done by hand.

## Pieces

| Piece | What it holds or does |
|---|---|
| Worker `projects` | The UI (Vite + React), the JSON API behind it, the MCP server agents call (`/mcp/<role>`), and two webhook endpoints: nest's (`/hooks/nest`) and GitHub's (`/hooks/github`) |
| `DirectoryDO` (one) | Projects, repo → project, agent → project and role, the events and deliveries already handled, the app's catalog sync state, the GitHub App's id |
| `ProjectDO` (one per project) | The project's settings and its repo's attachment, the board (tasks, specs, assignments, the history of each), the chat with the manager, PR → task |
| `ReviewDO` (one per project) | The review queue: one job per PR head, its reviewer agent, its check run, its verdict. It's an asynchronous process of its own, with its own alarm and an optional concurrency cap (none by default) |

All state is the app's. nest holds the agents, their sandboxes and their transcripts, and labels each agent with `project`, `role` and, for a worker, `task`, or for a reviewer, `pr` and `sha`. The app finds its agents by those labels after losing track of one.

## How it uses nest

Only the client interface. One client, `projects`, has this grant:
- `cells`, and `credentials: [claude_oauth_token]`;
- `repos` and `github.repos`: the attachable repos. Workers push to them; the manager and reviewers only read them, which `repos` covers (no `read_repos` needed);
- `github.permissions`: `checks: write` (check runs), `administration: write` and `metadata: read` (branch protection, the default branch, the repo's "Allow auto-merge"), `pull_requests: write` and `contents: write` (auto-merge on task PRs, and reading the repo's merge settings; [below](#auto-merge)). Each call's token asks only for what that call needs. The app reads nothing else on GitHub: a PR's number, head, base, title and node id come in its webhook, and the reviewer reads the code in its sandbox;
- `mcp_urls: [https://projects-nest.bitcru.sh/mcp/]`;
- `max_agents` and `max_sandboxes`.

| Need | Interface |
|---|---|
| Templates for the three roles | `PUT /v1/catalog/templates/projects/{manager,worker,reviewer}` and capabilities `projects/{board,task,review}` (the MCP URLs), synced from this directory at deploy |
| Starting an agent | `POST /v1/sandboxes {cell, labels}`, then `POST /v1/agents {template: "projects/<role>", cell, sandbox, labels, overrides}`, each with an `Idempotency-Key`. `overrides` is `{repos: [<repo>]}` for a worker, whose sandbox pushes only to that repo, and `{read_repos: [<repo>]}` for the manager and a reviewer, whose sandboxes only read it ([read-only repos](../docs/sandbox/networking/egress/policy/#read-only-repos)). The agent clones it |
| Talking to the manager | `POST /v1/agents/<id>/inbox`. Replies arrive as `agent.turn_completed` events |
| Approvals | `agent.ask` events, shown in "Needs you" with blocked tasks ([below](#blocked)), answered by `POST /v1/agents/<id>/asks/…` |
| Ending a worker or reviewer | `POST /v1/agents/<id>/stop {end: true, destroy_sandbox: true}` |
| Knowing what agents did | Signed webhooks to `/hooks/nest`, deduplicated by event `id`. After a gap (the dropped count rises), it re-reads `GET /v1/agents?label=project=<id>` |
| Check runs and branch protection | `POST /v1/clients/self/github-token {repo, permissions}`, then GitHub's API with that token |
| GitHub's events | The GitHub App's webhook, pointed at `/hooks/github` by the operator (nest consumes none of it) |
| Telling which agent calls the MCP server | The `Nest-Identity` JWT on every request, checked against nest's JWKS |
| Watching an agent work | `GET /v1/agents/<id>/trace?after=<seq>`, nest's live trace (a WebSocket), proxied for the page by `GET /api/agents/<id>/trace` ([below](#the-live-trace)) |

## The MCP server: agents see only their own work

- **One URL per role:** `/mcp/board` for the manager, `/mcp/task` for a worker, `/mcp/review` for a reviewer. nest lists a server's tools over one session shared by every agent on it, so a role's tool list is its URL's. Which data a call may touch is decided per call, from the caller's identity.
- **Every request** must carry a valid `Nest-Identity`:
  - signed by a key from nest's JWKS;
  - `aud` is that URL, and `iss` is nest;
  - `client` is the app's own client id;
  - **`owner` is also the app's client id.** Only agents the app created itself are trusted. A spawned agent's labels are whatever its spawner chose, so they mean nothing here.
  - There is no bearer secret: the capabilities name no `auth`, so nest sends no `Authorization`, and the identity is the credential.
- **Scope comes from the labels:**
  - The manager reads and writes the board of its `project`.
  - A worker reads its `task`, posts progress on it, marks it blocked or clears that, and says when its PR is open. It sees no other task.
  - A reviewer reads its `pr` at its `sha`, and submits one verdict per dimension (correctness, quality, architectural cohesiveness) with a summary.
- **`tainted`** is recorded with each write and shown on the board. It gates nothing: a worker and a reviewer read repo content by design.

## Flows

- **Attaching a repo.** The owner picks a repo from those both in the grant and in the App's installation. The app then, in this order:
  1. mints a token with `administration: write` and `metadata: read`, and reads the default branch;
  2. makes the check `nest-projects/review` required on it, with nothing else changed. A branch with no protection gets a minimal one: that check alone, `strict: false`, `enforce_admins: false`, no required reviews, no restrictions;
  3. only then starts the project's manager.

  A failure is shown on the project (`attach_error`), with the manager not started. A refusal that will repeat (the App not installed, the repo outside the grant, no admin) waits for the owner's `POST /api/projects/:id/attach`; anything else is retried from the alarm.
- **A task:**
  1. It's created (`draft`).
  2. The manager specs it (`ready`).
  3. It's assigned (`assigned`), by the owner from the board, by the manager, or automatically. Automatic assignment takes `ready` tasks in board order while the project's live workers are fewer than its `max_workers`.
  4. The app starts a worker labelled with the task (`in_progress`).
  5. The worker pushes a branch `task/<task-id>` and opens a PR (`in_review`). The PR's branch maps it to the task.
  6. The PR is merged (`done`), and the worker is ended.
  
  A worker that exits before opening a PR leaves the task `stalled`, shown on the board, to be reassigned. Cancelling a task stops its worker.
- **Review:**
  1. GitHub's `pull_request` events (`opened`, `synchronize`, `reopened`) reach `/hooks/github`, which checks the signature. Every PR is reviewed, a task's or not.
  2. ReviewDO queues a job for the PR's head SHA. A newer head replaces a queued job and stops a running one, whose check is cancelled.
  3. Each job creates a check run (`in_progress`) and starts a reviewer.
  4. The reviewer's verdict completes the check: `success` only if all three dimensions pass, else `failure`, with the summary as the check's output.
  5. A reviewer that exits without a verdict is started again, twice, then the check completes as `action_required`. Not `neutral`: a required check accepts `success`, `skipped` and `neutral` ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)), so `neutral` would let the PR merge unreviewed. A `check_run` `rerequested` queues the job again.
- **Merging** is GitHub's, gated by the required check. With the project's auto-merge on, the app enables GitHub's auto-merge on each task PR ([below](#auto-merge)); it never merges itself. A `pull_request` `closed` event with `merged: true` marks the PR's task `done` and ends its worker; closed without merging, it's noted in the task's history and the task stays. Marking done by hand doesn't get past this gate: it's refused for a task with an open PR (`in_review`) and for one with a live worker (`assigned`, `in_progress`, which is cancelled instead).

## Not decided here

- The reviewer is one agent judging all three dimensions. Three agents, one per dimension, is a later choice if one agent's verdicts prove uneven.
- Tasks without a PR (research, specs) end by the owner marking them done, from `draft`, `ready` or `stalled`.
- Whether PRs from outside the owner's account are reviewed: on a public repo anyone's PR starts a reviewer (the owner asked for any PR). `max_concurrent_reviews` caps how many run at once, not how many run.

## Built: the core

**Code:** `src/worker.ts` (routes, the Access check of `src/access.ts`, a copy of the dashboard's, and `/hooks/nest`), `src/api.ts` (the JSON API; its request bodies in `src/requests.ts`), `src/mcp.ts` and `src/identity.ts` (the MCP servers and Nest-Identity), `src/tools.ts` (each server's tools), `src/catalog.ts` (templates, capabilities, prompts), `src/nest.ts` (the client of nest), `src/tasks.ts` (the state machine, pure), `src/webhook.ts` (`Nest-Signature`), `src/do/` (DirectoryDO, ProjectDO, ReviewDO's schema), `src/sql.ts` (versioned migrations), `deploy/` (Cloudflare Access in front of it: the app's own inframe stack). Nothing imports the control plane (`test/deps.test.ts`).

```bash
npm ci && npm run typecheck && npm test && npm run build   # vitest in workerd, against a fake nest (test/fake-nest.ts)
```

**What the build settled** (2026-11-02):
- **Using nest's interface:**
  - **The cell goes where nest takes one:** in a create's body (`NEST_CELL`), and as a listing's filter. Nothing else sends it.
  - **The MCP capabilities name no `auth`:** nest sends no bearer, the grant covers no secret for them, and Nest-Identity is the only credential.
  - **The app's client id is its token's** (`nest_cli_<id>_…` → `cli_<id>`), the way nest itself reads it.
- **Agents:**
  - **Every agent gets a sandbox of its own,** made first (`POST /v1/sandboxes`) with the agent's labels, and ended with it (`stop {end: true, destroy_sandbox: true}`). The manager has one too, to read the code it specs. The agent clones the repo itself.
  - **Repo access:** the worker's template pushes to every attached project's repo (`repos`); the manager's and the reviewer's only read them (`read_repos`), so nest refuses their sandboxes' pushes and REST writes (comments, reviews) and mints them only `contents: read`. Each spawn narrows the list to its project's repo (`overrides.repos` or `overrides.read_repos`). Creating a project syncs the catalog again first.
  - **Labels:** `project`, `role`, `task` for a worker, and `start`, the task's (or the manager's) start count. They find the app's agents again after a gap (`GET /v1/agents?label=…`).
  - **Creates are idempotent:** each start attempt sends `Idempotency-Key: <project>/<task or manager>/<start>/{sandbox,agent}` with its creates, so a retry after a lost answer gets the same sandbox and agent back. A key nest is still handling (a retryable 409) is retried like a 503; a key bound to another request (a 409 that isn't) is a refusal for good.
  - **First input:** the worker's brief (title, body, spec, repo, branch) and the manager's go to their inbox with a request id, so a retry posts once. A brief for a task any tainted session wrote is posted as relayed text (`from: "projects/board"`), so the worker's session is tainted too.
  - **Retries:** ProjectDO owes nest its manager, workers, stops and chat messages, each retried from its alarm (5 s doubling to 5 min); a retryable 503 or 409 is also retried within the call. A worker nest refuses for good (a 4xx) stalls its task with the reason; the manager is retried until it starts.
- **The board:**
  - **States** (`src/tasks.ts`; a task with a live worker may be re-specced, [below](#task-changes)): `draft` → `ready` (specced) → `assigned` → `in_progress` (worker started) → `in_review` (PR reported) → `done`, with `stalled` and `cancelled`. A task is assigned only once specced. The owner may mark done only a task with no PR and no live worker (`draft`, `ready`, `stalled`; a stalled task never has a PR, since one with a PR is `in_review`); a draft may be deleted, anything later is cancelled.
  - **A spec** is a goal, acceptance criteria, the files it likely touches and a test plan.
  - **`max_workers`** caps auto-assign and the manager's `assign_task`; the owner's assign by hand isn't capped (nest's `max_agents` still is). A worker counts from its assignment until it exits or the app has stopped it.
  - **History:** every change records who (the owner, the app, or an agent), what, when, and whether the session was tainted.
- **The MCP servers:** no sessions (no `Mcp-Session-Id`), JSON answers only. A worker's tools take no task id: its labels name its task. Every write is answered once per call key (`_meta["nest/call"]`) that begins with the caller's own id, kept 24 h. The reviewer's are in [the review pipeline](#built-the-review-pipeline).
- **Events:** deduplicated by id (DirectoryDO, 7 days) and idempotent besides. An event for an agent the app hasn't recorded is routed by that agent's labels (`GET /v1/agents/<id>`), only if the app is its client and owner; any other agent is remembered as not the app's and acknowledged. A failure answers 5xx, so nest delivers again.

## Built: the review pipeline

**Code:** `src/github-hook.ts` (`/hooks/github`), `src/github.ts` (the signature, the REST client, the branch-protection rules, the check's output), `src/do/review.ts` (ReviewDO), attaching in `src/do/project.ts`. Tests: `test/review.test.ts`, `test/attach.test.ts`, `test/github.test.ts`, against a fake GitHub in `test/fake-nest.ts`.

**What the build settled** (2026-11-02), against GitHub's docs for [webhook signatures](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries), [events](https://docs.github.com/en/webhooks/webhook-events-and-payloads), [check runs](https://docs.github.com/en/rest/checks/runs) and [branch protection](https://docs.github.com/en/rest/branches/branch-protection):
- **The webhook:**
  - `X-Hub-Signature-256` is checked over the raw bytes in constant time: missing or wrong is `401`.
  - Deduplicated by `X-GitHub-Delivery` (DirectoryDO, 7 days); routed by `repository.full_name` to its project; an unknown repo, `ping` and other events are a `2xx`.
  - It only records: ReviewDO and ProjectDO write one step each and arm their alarms, so it answers within GitHub's 10 s.
  - GitHub doesn't redeliver by itself (unverified: its docs offer manual redelivery only). A lost `pull_request` leaves the head without the check, which blocks merging until the next push or a redelivery.
- **The queue:**
  - One job per PR head. An event with an older `updated_at` than the PR's last is ignored, since deliveries aren't ordered. A head moving back to a reviewed commit, or a reopened PR, queues that commit again.
  - **`max_concurrent_reviews`**: per project, unset (no cap) by default, set with `PATCH /api/projects/:id/settings`. Jobs start from ReviewDO's alarm, oldest first, while running ones are fewer.
  - **Retries:** every call to GitHub or nest is retried from the alarm (5 s doubling to 5 min). A refusal that will repeat fails the job with the reason, its check `action_required`. A check-run create whose answer was lost is found again by its `external_id`, not made twice.
  - **Reviewers:** made as workers are (`Nest.startAgent`, `Idempotency-Key: <project>/review/<pr>/<sha>/<start>/{sandbox,agent}`), labelled `project`, `role=reviewer`, `pr`, `sha`, `start`, reading the repo but unable to push or write to it (`read_repos`, above), and ended with their sandboxes (`stop {end, destroy_sandbox}`) on a verdict, a newer head, a closed PR, or an exit. Two more starts after an exit without a verdict.
  - **The brief** has only what the app knows from GitHub's routing (repo, number, head, base), none of the PR's own text. `review_get` gives the title.
- **The check:** `nest-projects/review`, created `in_progress` at the head with `details_url` the project's board. On completion:
  - a verdict: `success` only if all three pass, else `failure`. The title names the failed dimensions, the summary is the reviewer's, the text holds each dimension's notes, the reviewer and whether its session was tainted. Clipped to GitHub's 65535 characters (the title to 255; GitHub documents no limit for it);
  - no verdict: `action_required` (above);
  - superseded or closed: `cancelled`.
- **The verdict** (`/mcp/review`): `review_get` and `submit_review {correctness, quality, architecture: {verdict: pass|fail, notes}, summary}`. The caller's `pr` and `sha` labels name its job; only that job's current reviewer may submit, once, while the job runs. A retry with the same call key gets the first answer. The taint is recorded with the verdict.
- **Attaching:**
  - **Required checks that exist** change only their lists (`PATCH …/required_status_checks`), and only when the check is missing or not yet pinned to the App; `strict` and everything else stay. A second attach writes nothing.
  - **A branch protected without required checks** gets its protection written back whole with them (`PUT`, from what `GET` answers). Required signatures aren't in that body (unverified that `PUT` leaves them).
  - **The App's id:** the check is required from the App (`checks: [{context, app_id}]`) from the first attach, so no other app or commit status can pass it. The id is the `app_id` of nest's token answer ([GitHub tokens](../docs/control-plane/api/clients/#github-tokens)). If an answer has none (nest can't tell), the check is required from any source (`contexts`, or `checks` without `app_id` where other entries are pinned, which keeps their pins), and the first check run's `app.id` then pins it: the project attaches again. Another entry's `app_id: null` (any source) is sent back as `-1`, GitHub's "any app".
  - Rulesets aren't read or changed: a repo protected by rulesets alone gets branch protection besides.
- **Tasks and PRs:** a `pull_request` from the repo's own branch `task/<id>` (not a fork's) links the PR to its task (`pr_opened`) if the worker hadn't reported it. Merged, the task is `done` (through `pr_opened` first if it was still `in_progress`) and its worker ended.

## Auto-merge

The owner's request (2026-11-02): "Auto-merge should be an option in the project, which writes back to the repo settings."

- **The settings:** `auto_merge` (default off) and `merge_method` (`squash`, the default, `merge` or `rebase`), set at create or with `PATCH /api/projects/:id/settings`.
- **The repo's "Allow auto-merge":**
  - Turning `auto_merge` on writes `allow_auto_merge: true` to the repo; turning it off writes `false`. The write is `PATCH /repos/{o}/{r}`, from ProjectDO's alarm, retried from 5 s doubling to 5 min.
  - A refusal that will repeat is shown (`repo_auto_merge.state: error`), with the setting kept as asked. `POST /api/projects/:id/auto-merge/retry` writes it again.
  - Looking at the project (`GET /api/projects/:id`) reads the repo's value again, at most once a minute, from the alarm. A value that differs from the setting is shown as `drifted` (changed by hand on GitHub), and the same retry writes it back. A repo whose setting the app never wrote isn't watched.
- **Per PR:**
  - While `auto_merge` is on, a task's PR gets GitHub's auto-merge when it opens or reopens, with the project's merge method. The app uses GraphQL `enablePullRequestAutoMerge` with the PR's `node_id` from the webhook.
  - Only a task's own PR counts: one from the repo's own branch `task/<id>`. Other PRs, and forks' branches with that name, are left alone.
  - Turning `auto_merge` on enables it on the task PRs already open, and turning it off disables it on them (`disablePullRequestAutoMerge`).
  - A PR's auto-merge waits until the repo allows it.
  - The task records each change (`auto_merge_enabled`, `auto_merge_disabled`, `auto_merge_failed` with GitHub's reason) and shows it in its drawer. GitHub's GraphQL `errors` are refusals for good, except its rate limit.
  - Changing `merge_method` applies to PRs opened after the change.
- **Merging stays GitHub's,** gated by the required `nest-projects/review` check and the branch's other rules. GitHub's auto-merge merges "after all required reviews and status checks pass" ([GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)). A PR that could merge at once has no auto-merge to enable; GitHub refuses it, and that's recorded.
- **Each call's token:**

| Call | Permissions | Source |
|---|---|---|
| `PATCH /repos/{o}/{r}` (`allow_auto_merge`) | `administration: write` | [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) ("Administration": `PATCH /repos/{owner}/{repo}`, write) |
| `GET /repos/{o}/{r}` (reading `allow_auto_merge`) | `metadata: read`, `contents: write` | the same page ("Metadata": `GET /repos/{owner}/{repo}`, read), and [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository): "To view merge-related settings, you must have the contents:read and contents:write permissions" |
| GraphQL `enablePullRequestAutoMerge`, `disablePullRequestAutoMerge` | `pull_requests: write`, `contents: write` | GitHub's [GraphQL reference](https://docs.github.com/en/graphql/reference/pulls) names none (unverified). [Auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request) needs "write permissions to a repository". The merge it arms is Contents: write (`PUT …/pulls/{n}/merge`, same permissions page), and it changes the PR |

## Blocked

The owner's request (2026-11-02): "Agents might mark their tasks as blocked, which should bubble up to me."

- **A flag, not a state.** A blocked task keeps its state, its worker and its PR, and goes on from there once unblocked. A state would need a way back to wherever it was, and an `in_review` task blocked on a question still has its PR open and under review. The rules are pure, in `src/tasks.ts` (`canBlock`, `canUnblock`):
  - the manager may block any task that isn't over (`block_task` on `/mcp/board`); a worker only its own, while its worker is live (`report_blocked` on `/mcp/task`, which takes no task id, and the task's assignee must be the caller);
  - a blocked task isn't blocked again (clear it first). A task that ends (`done`, `cancelled`) drops its block, and auto-assign skips a blocked `ready` task.
- **What it carries:** who blocked it, their role, when, the reason, an optional question for the owner, and whether the session was tainted.
- **Unblocking:**
  - **The owner answers** (`POST /api/projects/:id/tasks/:task/answer {answer}`). The answer goes to the blocking agent's inbox, and to the manager's too when a worker blocked it. Those messages carry the owner's words and the task's id only, nothing an agent wrote, so they're never relayed.
  - **The manager** (`unblock_task`) **or the task's worker** (`clear_blocked`) clears it when it's resolved another way.
- **The manager is told** when a worker blocks, with the reason and the question. That text is relayed (`from: "projects/board"`) when the worker's session was tainted, as a brief from a tainted spec is.
- **Delivery:** messages to agents' inboxes are owed in ProjectDO's `messages` table, posted once each (a request id) from the alarm, retried from 5 s doubling to 5 min, and kept with the reason when nest refuses for good.
- **"Needs you"** is one area at the top of the board: open asks and blocked tasks together, oldest first (`GET /api/projects/:id/attention`). Each shows who, why, how long ago, and its answer (approve or deny, or words). It replaces the asks banner, and is calm: the surface with a warning rule down its left edge and a warning icon by its title, not a tinted fill.
- **The count:** `GET /api/projects` gives each project `needs_you`, its open asks plus blocked tasks, which the projects list badges (and a sidebar can).

## Task changes

The owner's request (2026-11-02): "Workers should be notified when their assigned task is modified."

- **What's told:** a new title, body or spec, and its block cleared by the owner (answering it) or the manager. It doesn't matter whether the owner made the change (the API), the manager (`/mcp/board`) or the app.
  - The worker's own changes aren't told back, nor is a block it raised and the owner answered: that answer reached it already.
  - Cancelling stops the worker, as before.
  - A task with a live worker (`assigned`, `in_progress`, or `in_review` while its worker lives) may now be re-specced, so the spec can change under a worker (`spec` loops on those states in `src/tasks.ts`).
- **A reorder isn't told:** board order is priority among tasks not yet started, and a worker already on its task has nothing to do with that.
- **To whom:** only a live worker (the task's assignee, still live). A task without one tells nobody, since a worker started later gets the task as it is in its brief.
- **How:**
  - Each change is noted in ProjectDO (`task_changes`) and told within 10 s (`NOTIFY_WINDOW_MS`) from the alarm. Changes in that window go out as one message.
  - The message names the fields, gives each field's first before and last after (title and body clipped to 600 characters), the whole new spec, and asks the worker to re-read the task with `get_task`.
  - A set is frozen on its first try and posted with the request id `<task>/changes/<last change>`, so a retry after a lost answer posts once. A change after that try is the next message.
  - A set with any change from a tainted session is posted as relayed text (`from: "projects/board"`), as the brief is.
  - Each set is recorded in the task's history (`worker_notified`, or `worker_not_notified` when the worker had gone or nest refused).

## The UI

**Code:** `src/ui/`: the layout primitives in `layout/`, one folder per feature in `features/` (`shell`, `projects`, `project`, `board`, `task`, `chat`, `attention`, `settings`, `admin`, `trace`), each component next to its test. `src/main.tsx` mounts it.

- **Stack:** React 19 with [Mantine](https://mantine.dev/) 9 and one theme (`src/ui/theme.ts`); TanStack Query for all server state (`src/ui/api/`), TanStack Router for typed routes (`src/ui/router.tsx`), dnd-kit for reordering the board, Tabler icons, Inter and JetBrains Mono self-hosted from npm.
- **One API client** (`src/ui/api/client.ts`), same origin, so Access's cookie is the only credential: nothing secret is in the bundle. Its types are the Worker's own, imported by type only; the request bodies' zod schemas live in `src/requests.ts`, which both the Worker and the forms validate with.
- **Live views poll while the tab is visible** (the trace is a WebSocket instead): the chat every 3 s, the board and "Needs you" every 5 s, the project every 10 s. The board stops polling while a card is dragged. Nothing animates on a poll.
- **Optimistic where safe:** reordering (one `ord` written, between the new neighbours'; put back if refused) and a chat message (shown as sending; its text back in the composer if refused). An answer to an ask isn't: the ask stays until nest has taken it.
- **Actions follow the state machine:** a button shows only when `src/tasks.ts` allows its move. Cancelling, deleting and marking done are confirmed, with the safe choice focused; "Mark done" shows only for a task with no PR and no live worker. A failed write is a notification (bottom right) with the Worker's reason.
- **The shell** (the skill's [Navigation](../.claude/skills/nest-ui-design/SKILL.md#navigation)): a persistent left sidebar (a burger-toggled drawer below `md`). At its top the product's name, small; then **which project**, a switcher (the current project's name; a searchable, keyboard-first list of "All projects" and every project, keeping the view on a pick); then **which view**, the project's Board, Manager, Reviews and Settings as flat rows (Board carries its "needs you" count, the one place it shows for the current project; the switcher's list shows every project's); outside a project, the projects list's row only; Admin at its foot. Every row is one `NavRow`; the active one is quiet (the subtle ground, full weight, a 2 px rule in the text color). The page's h1 is the project's name, with the repo, auto-assign and the worker cap below it; no breadcrumb.
- **Routes:** `/projects` (the list; `/` redirects there); `/projects/<id>/board` (the default for `/projects/<id>`; "Needs you" at the top, its oldest three shown and the rest behind "Show all (n)", then the board at full width, `?task=<id>` opening the task's drawer; an old `/projects/<id>?task=…` link redirects with its task), `/projects/<id>/manager` (the chat; `?view=trace` the manager's live trace), `/projects/<id>/reviews` (ReviewDO's jobs, read-only, each with its reviewer's live trace on demand), `/projects/<id>/settings`, and `/admin` (the catalog sync and the last one). Each page is a chunk of its own, loaded on first visit; Mantine, React and the other libraries are chunks of their own too (vite.config.ts), cached across releases.
- **The Manager page:** the conversation full width at a reading measure (42rem), the composer pinned to the viewport's bottom, and the manager's status in the header from `GET /api/projects/<id>/manager` (`src/manager.ts`): attaching, attach failed (with a retry, `POST …/attach`), starting, waiting for a host, running (and what it's doing), errored, ended, from the project's record and nest's agent record.
- **History** reads as sentences ("PR #118 opened", "Assigned to agt_…", "Spec written, 3 acceptance criteria"), with who and when; the raw detail is behind "Details".
- **The board's cards** carry `tainted` (any write to the task came from a tainted session), which the task list returns, a "Blocked" badge (warning) while the task is blocked, and a "needs input" marker from the project's open asks.

### The live trace

**Built (2026-11-02):** an agent's turns as they happen, from nest's live trace ([API](../docs/control-plane/api/), "Live trace"). Code: `src/trace.ts` (the route) and `src/ui/features/trace/` (the viewer, self-contained). Tests: `test/trace.test.ts` (the route, against a WebSocket in the fake nest) and `src/ui/features/trace/trace.test.tsx`.
- **The route:** `GET /api/agents/<id>/trace?after=<seq>`, behind Access like the rest of `/api/`. Only an agent DirectoryDO recorded for one of the app's projects (its manager, a worker, a reviewer); any other id is `404` before nest is asked. Then it opens the upgrade to nest with the client token (`fetch` with `Upgrade: websocket` and `Authorization`, nothing of the browser's forwarded) and returns nest's socket as its own `101`. Workers proxy a WebSocket that way ([Response](https://developers.cloudflare.com/workers/runtime-apis/response/): "This establishes a WebSocket connection proxied through a Worker"), so the app holds no state for it and the token never reaches the browser. nest's retryable `503` (minutes after its deploy) stays a `503`; its `404` is a `404`; any other refusal is a `502` with nest's message.
- **The viewer** (`TraceView`, and one mount per place: `ManagerTrace`, `TaskTraces` for a task's worker in its drawer, `ReviewTrace` for a review job's reviewer):
  - Turns are groups: the input's kind and when, then the assistant's text, each tool call with its result's status (Running, Done, Error) and its input and result a click away, asks and errors as notices, state changes as captions; the turn's badge says Working or Completed, with its tokens.
  - The header shows the connection (Live, Connecting, Reconnecting, Ended) and the agent's last state.
  - It follows the newest event only while scrolled to the bottom; above it, "Jump to live (n new)".
  - **Reconnects** after a drop from the last seq received (`after`), 1 s doubling to 30 s, starting over once a connect's backlog is done; never after `ended`. A repeated seq is dropped. A `ping` every 25 s keeps the socket open without waking the agent's object.
  - **Motion:** an event that arrives after nest's `live` marker fades in (`base`, 180 ms, the `FadeIn` primitive); the backlog and everything replayed on a reconnect don't. Reduced motion makes it instant.
  - **The gap notice** names the events nest no longer holds. The app has no transcript view, so it links to none.
  - At most 2,000 events are kept per view; older ones are dropped from it, and it says so.
- **Where it's mounted:** the task drawer (the worker's). `ManagerTrace` is for the Manager page's "Trace" tab beside "Chat", and `ReviewTrace` for each job on the Reviews page; those pages come with the sidebar.

### Rich messages

The manager's messages (in the chat, and its asks and blocks in "Needs you") render; the owner's stay plain text with their line breaks. `src/ui/features/rich/`, `src/ui/rich/`, styled by `layout/Rich.tsx`.

- **Markdown:** `react-markdown` with `remark-gfm` (headings, lists, task lists read-only, tables in a scroll frame, quotes, code in the mono family, links). **A message can't change the page's outline:** its headings are demoted by three (`remarkDemoteHeadings`: `#` is an h4, down to h6) and set at body size by weight. **Raw HTML is never rendered:** it becomes literal text before parsing (`remarkEscapeHtml`), and no `rehype-raw` is in the pipeline.
- **Links** only `http:`, `https:` and `mailto:` (new tab, `noopener noreferrer`); anything else is plain text. **No remote image** (no tracking pixel): `![alt](url)` is a link labelled with the alt text; only a `data:image/png|jpeg|gif|webp` image shows inline, capped.
- **Math:** `remark-math` and `rehype-katex` (inline `$…$`, display `$$` blocks and ```math blocks), with `trust: false` (no `\href`, `\url`, `\includegraphics`, `\htmlClass`, `\htmlId`), `strict: "warn"`, `throwOnError: false` (a bad formula shows its source in the error shade), and `maxSize`/`maxExpand` caps. KaTeX's CSS and fonts come from the package. Display math scrolls in its own frame.
- **SVG, in depth:** found before Markdown (a ```svg block, or an inline `<svg>…</svg>`); sanitized with DOMPurify's SVG profile plus stricter rules (no `foreignObject`, `script`, `on*`, non-fragment `href`/`xlink:href`, outside `<use>`, fetching `<style>`), checked again after, refused above 200 KB; and **shown only as an `<img>`** from a `data:image/svg+xml` URL, never inline, so a sanitizer bug still can't run anything. It sits on a fixed light canvas (white, a hairline) in both schemes, never inverted, so its own colours read as drawn. A click opens it larger (still an image); "View source" shows the sanitized SVG.
- **Task references:** `[text](task:tsk_…)` or a bare `task:tsk_…` is a chip (the live title, then its state badge, at the text's size); a ```tasks block (an id per line, optionally a note) is a card per task, with the Board's card body (`TaskCardBody`: title, state, Blocked, Needs input, Tainted, assignee, PRs with their review) and the note. Always resolved live from the project's board (one query, polled with it); an id the board doesn't have is muted inline code. A chip or card opens the task in the Board's drawer.
- **CSP** (`src/csp.ts`), on every page the built Worker serves: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` (Mantine's CSS variables and style props, KaTeX's sizes); `img-src 'self' data:`; `font-src 'self' data:`; `connect-src 'self' wss://<host>` (the trace); `frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'`. The scheme's pre-paint script is a file (`public/color-scheme.js`), not inline. `vite dev` sends none (its own inline scripts).

### Design system

The values and rules are the [nest-ui-design skill](../.claude/skills/nest-ui-design/SKILL.md)'s; this app implements them.

**Tokens**, defined once in `src/ui/theme.ts` as Mantine theme values and `--nest-*` CSS variables, light and dark (the scheme follows the system):

| Token | Values |
|---|---|
| Fonts | Inter Variable (UI), JetBrains Mono Variable (ids, code), from `@fontsource-variable/*`; no external request |
| Type | caption 12/16 (`xs`), small 13/20 (`sm`), body 14/20 (`md`), body-lg 16/24 (`lg`); h4 14/20, h3 16/24, h2 20/28, h1 24/32, all 600; weights `regular` 400, `medium` 500, `bold` 600 |
| Spacing | `2xs` 2, `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `2xl` 32, `3xl` 48, `4xl` 64 (px) |
| Radii | `sm` 4 (badges, inputs), `md` 8 (panels, buttons) |
| Borders, shadows | a 1 px hairline in `border`; `raised` (a dragged card) and `overlay` (drawers, modals) |
| Neutrals (light / dark) | page `#fafafa` / `#121314`, surface `#ffffff` / `#1a1b1e`, subtle `#f1f3f5` / `#222327`, border `#e9ecef` / `#2c2e33`, text `#212529` / `#e9ecef`, muted `#666e76` / `#9aa0a6` |
| Roles (filled, light / dark) | primary `#3b6fc0` / `#5a8ad6`, danger `#c2414c` / `#d9606a`, warning `#dca71c` / `#e3b341`, success `#2c8152` / `#3f9e6a`; label white (dark on warning) in light, `#121314` in dark |
| Motion | 120 / 180 / 240 ms, `cubic-bezier(0.2, 0, 0, 1)` in, `cubic-bezier(0.4, 0, 1, 1)` out; opacity and transform only; reduced motion honoured; a spinner only after 300 ms |
| Layout | page max 1440 px; gutters `lg` / `xl` / `2xl` (phone / tablet / desktop); sidebar 264 px from 62em (a drawer below), collapsing in 180 ms; reading measure 42rem; board columns at least 8.5rem from 62em (16rem below), all six fitting beside the sidebar at 1280 px |

**Primitives** (`src/ui/layout/`): `AppFrame` (the sidebar: the name small at its top, the places, a footer; a burger-toggled drawer below `md`; and the content), `NavRow`/`NavGroup`/`NavGroups` and `SwitcherTarget` (the sidebar's one row style, its groups, and the switcher's button), `Page` (the max width, gutters, `2xl` between blocks; `measure` `form` or `reading`, a column centred in the content area, its header included), `PageHeader` (the one h1 with its actions right on its row, wrapping when narrow, and a meta line; no breadcrumb), `Section` (a heading row of one height: title, count, actions right; `dense` for a board column), `Panel` (the bordered surface, `lg` padding, `md` when dense; never nested) and `Well` (the borderless subtle region that holds Panels), `Toolbar` (actions `sm` apart, wrapping; destructive ones last after a divider), `Stack` and `Row` (gaps from the scale), `FieldGroup` (fields `lg` apart, actions bottom right), `EmptyState`, `LoadingState`, `ErrorState` and `Notice`, `MetaRow`/`MetaItem` (caption lines), `TableFrame` (a dense table in a frame, scrolling in itself), `CardGrid` and `ColumnGrid` (the projects, the board), `SortablePanel` (a draggable card), `Sheet` (the task drawer), `Bubble` and `PinnedFooter` (the chat and its composer), `ScrollLog` (a log of a fixed height: a trace), `FadeIn` (something that just arrived, once), `Prose`.

**Rules:**
- **Placement:** a section's primary action at its top right, secondary ones to its left; destructive ones last, set apart, and confirmed. In forms and dialogs the actions are bottom right, the primary rightmost. A status badge right after the thing it's about; who and when on a caption line below.
- **Proximity:** `sm` between a card's lines, `md` between cards, `2xl` between a page's blocks.
- **Similarity:** one card (a Panel), one badge per status, one button hierarchy (filled primary, default secondary, subtle tertiary; red for close and cancel).
- **Enforced** by `src/ui/design.test.ts`: outside `theme.ts` and `layout/`, no inline `style`, `className` or CSS; no raw lengths or literal colors; colors only by role, gray, `dimmed` or `bright`; spacing only by the scale's names; weights by name; and no Mantine layout container (Group, Stack, Paper, Box, …). `src/ui/theme.test.ts` reads the skill's tables and checks every token against them, AA contrast in both schemes, and each status's role. `src/ui/layout/layout.test.tsx` checks the primitives' placement.

```bash
npm run dev    # the page and the API in workerd; without NEST_CLIENT_TOKEN the API answers, but nothing reaches nest
npm test       # two vitest projects: `worker` (workerd) and `ui` (jsdom, Testing Library)
```

## Setup (the operator's)

1. Create the client: `POST /v1/admin/clients {name: "projects", grant}`, and store its token as the Worker's secret `NEST_CLIENT_TOKEN`.
2. Cloudflare Access comes from the app's own inframe stack, [`deploy/`](deploy/) (not nest's `edge` stack): the owner's login on `projects-nest.bitcru.sh`, with `/hooks` and `/mcp` bypassed, since they are authenticated by signature and by identity instead. `.github/workflows/deploy-projects-infra.yml` applies it on a push to `main` that touches `deploy/`, with `CLOUDFLARE_ACCESS_API_TOKEN` (Access: Apps and Policies: Edit); or by hand, `inframe plan --stack projects` then `apply` ([deploy/README.md](deploy/README.md#use)). Set `PROJECTS_AUD` in `wrangler.jsonc` to its output `projects_aud`.
3. The Worker deploys by `.github/workflows/deploy-projects.yml` on a push to `main` that touches `projects/` (outside `deploy/`), to `projects-nest.bitcru.sh`. It puts its secrets from the `production` environment's `PROJECTS_NEST_CLIENT_TOKEN`, `PROJECTS_NEST_WEBHOOK_SECRET` and `PROJECTS_GITHUB_WEBHOOK_SECRET` when they're set. Then `POST /api/admin/sync` writes the catalog.
4. `PUT /v1/clients/self/webhook {url: https://projects-nest.bitcru.sh/hooks/nest}` (the app does this at its first start), and store the secret as `NEST_WEBHOOK_SECRET`.
5. Point the GitHub App's webhook at `https://projects-nest.bitcru.sh/hooks/github` (content type `application/json`), with a new secret, stored as `GITHUB_WEBHOOK_SECRET` (`wrangler secret put`). Subscribe the App to the `pull_request` and `check_run` events. The App needs the repository permissions the grant names (Checks: read and write, Administration: read and write, Metadata: read) and Pull requests (read at least), without which GitHub doesn't offer the `pull_request` event. Its installation must cover each attached repo. For auto-merge, the App also needs Contents: read and write, and Pull requests: read and write.
6. **Auto-merge's permissions (2026-11-02):** add `pull_requests: write` and `contents: write` to the live client's `github.permissions`. Use `PATCH /v1/admin/clients/<id>`, which takes the grant ([clients doc](../docs/control-plane/api/clients/)). Until then, turning auto-merge on writes the repo setting, but each PR's auto-merge fails with nest's 403, recorded on its task.

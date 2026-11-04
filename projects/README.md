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
- `github.permissions`: `checks: write` (check runs), `administration: write` and `metadata: read` (branch protection, the default branch, the repo's "Allow auto-merge"), `pull_requests: write` and `contents: write` (auto-merge on task PRs, and reading the repo's merge settings; [below](#auto-merge)), which also cover reading PRs to attach them (`pull_requests: read`; [below](#prs)). Each call's token asks only for what that call needs. The app reads nothing else on GitHub: a PR's number, head, base, title and node id come in its webhook, and the reviewer reads the code in its sandbox;
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
  5. The worker pushes a branch `task/<task-id>` and opens a PR (`in_review`). The PR's branch maps it to the task. The owner or the manager may attach more ([below](#prs)).
  6. All its attached PRs merged (`done`), and the worker is ended.
  
  A worker that exits before opening a PR leaves the task `stalled`, shown on the board, to be reassigned. Cancelling a task stops its worker.
- **Review:**
  1. GitHub's `pull_request` events (`opened`, `synchronize`, `reopened`) reach `/hooks/github`, which checks the signature. Every PR is reviewed, a task's or not.
  2. ReviewDO queues a job for the PR's head SHA. A newer head replaces a queued job and stops a running one, whose check is cancelled.
  3. Each job creates a check run (`in_progress`) and starts a reviewer.
  4. The reviewer's verdict completes the check: `success` only if all three dimensions pass, else `failure`, with the summary as the check's output.
  5. A reviewer that exits without a verdict is started again, twice, then the check completes as `action_required`. Not `neutral`: a required check accepts `success`, `skipped` and `neutral` ([GitHub](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging)), so `neutral` would let the PR merge unreviewed. A `check_run` `rerequested` queues the job again.
- **Merging** is GitHub's, gated by the required check. With the project's auto-merge on, the app enables GitHub's auto-merge on each task PR ([below](#auto-merge)); it never merges itself. A `pull_request` `closed` event with `merged: true` marks the PR merged, and its task `done` once every attached PR has, ending its worker; closed without merging, the PR is detached, noted in the task's history, and the task stays. Marking done by hand doesn't get past this gate: it's refused for a task with an open PR (`in_review`) and for one with a live worker (`assigned`, `in_progress`, which is cancelled instead).

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

- **What's told:** a new title, body or spec, its block cleared by the owner (answering it) or the manager, PRs attached or detached ([PRs](#prs)), and its dependencies added, removed or done ([dependencies](#dependencies)). It doesn't matter whether the owner made the change (the API), the manager (`/mcp/board`) or the app.
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

## PRs

The owner's request (2026-11-03): "PRs should be attachable to tasks."

- **A relation, not one field.** A task has any number of PRs (ProjectDO's `task_prs`), and a PR belongs to one task at a time. The migration made each task's single `pr` its first attached PR, with its auto-merge. `Task.pr` (and the old column) is still the first attached; `Task.prs` lists them all.
- **Attaching:**
  - **the owner**, from the task's drawer: one of the repo's open PRs (`GET /api/projects/:id/prs/open`), or a number, `#n`, or the PR's URL (`POST /api/projects/:id/tasks/:task/prs`);
  - **the manager**, with `attach_pr` on `/mcp/board`;
  - **its worker's own PR** still attaches itself, by `report_pr` or by its branch `task/<id>`.

  The owner's and the manager's are checked on GitHub with a `pull_requests: read` token: the PR is in the repo and open, and GitHub says whether it's from a fork. A task in progress goes to review; a task that's over takes no PR.
- **One task per PR:** attaching a PR that's attached to another task is refused, naming that task: detach it there first. A branch `task/<id>` never moves a PR attached elsewhere; it's noted on the task it names. Moving it silently would take a PR from a task someone chose.
- **Detaching** (`DELETE …/prs/<n>`, or `detach_pr`) works on an open PR only, since a merged one stays as the record. A detached PR's auto-merge is turned off.
- **Done:** a task is done once at least one PR is attached and every attached one has merged (`prsDone` in `src/tasks.ts`). Merging one of several leaves it in review. A PR closed without merging is detached with a note, and the task is done if the rest have merged. `merged` now moves any task that isn't over, since a PR may be attached to a task with no worker.
- **Review and auto-merge:** every PR is reviewed already. With auto-merge on, every attached PR gets it: the owner's, the manager's, the worker's or the branch's, but only once GitHub has said it's from the repo itself and given its node id. A fork's PR never gets it, and neither does one whose head repo GitHub no longer names.
- **The live worker is told** when PRs are attached or detached ([task changes](#task-changes)).

## Dependencies

The owner's request (2026-11-03): "Tasks should be able to block other tasks."

- **"Waiting on", a relation** (ProjectDO's `task_deps`): a task waits on others (`blocked_by`), and is waited on by others (`blocks`). This is distinct from "Blocked" ([above](#blocked)), the flag an agent raises for the owner, which is a "Needs you" item. A dependency is the board's own ordering, and nothing waits on the owner.
- **Valid** (`dependencyError` in `src/tasks.ts`, pure): within the project only, never on itself, never on a task that's over, never twice, and never closing a cycle, which is refused with the cycle's path (`tsk_a → tsk_b → tsk_a`).
- **Assignment:** a task waiting on any task not `done` can't be assigned, whether automatically, by the manager or by the owner. The refusal names the blockers and their states. **There is no override:** the owner removes the dependency instead, which says what changed and keeps the board's record honest.
- **Becoming assignable:** when its last blocker is done, the task can be assigned, and auto-assign takes it. **A cancelled blocker still holds it:** the work it waited on won't happen, so whether to go on without it is the owner's or the manager's call, made by removing the dependency.
- **Who:** the owner from the drawer (`POST /api/projects/:id/tasks/:task/dependencies {blocked_by}`, `DELETE …/dependencies/<task>`), and the manager with `add_dependency` and `remove_dependency`. A worker's `get_task` lists what its task waits on, with each one's state.
- **A live worker** on a task whose dependencies change (added or removed mid-flight, or one done) is told ([task changes](#task-changes)).
- **On the board:** a card says "Waiting on N", neutral (gray, outline), since it's no one's to act on now. Hovering or focusing it lists the blockers. The drawer has a Dependencies section: what it waits on, each removable, a task picker (the switcher) to add one, and what waits on it.

## The UI

**Code:** `src/ui/`: the layout primitives in `layout/`, one folder per feature in `features/` (`shell`, `projects`, `project`, `board`, `task`, `chat`, `attention`, `settings`, `admin`, `trace`), each component next to its test. `src/main.tsx` mounts it.

- **Stack:** React 19 with [Mantine](https://mantine.dev/) 9 and one theme (`src/ui/theme.ts`); TanStack Query for all server state (`src/ui/api/`), TanStack Router for typed routes (`src/ui/router.tsx`), dnd-kit for reordering the board, Tabler icons, Inter and JetBrains Mono self-hosted from npm.
- **A strict Content-Security-Policy** (`src/csp.ts`) on everything the Worker serves from its assets: only the app's own scripts (no inline script or eval; the color-scheme snippet is `public/scheme.js`), fetches and the trace's WebSocket to this origin only, fonts and images from it or `data:`, no framing (`frame-ancestors 'none'`). Styles may be inline: Mantine writes CSS variables in `style` attributes and a `<style>` tag. `vite dev` runs without it, for its inline preamble and HMR client.
- **One API client** (`src/ui/api/client.ts`), same origin, so Access's cookie is the only credential: nothing secret is in the bundle. Its types are the Worker's own, imported by type only; the request bodies' zod schemas live in `src/requests.ts`, which both the Worker and the forms validate with.
- **Live views poll while the tab is visible** (the trace is a WebSocket instead): the chat every 3 s, the board and "Needs you" every 5 s, the project every 10 s. The board stops polling while a card is dragged. Nothing animates on a poll.
- **Optimistic where safe:** reordering (one `ord` written, between the new neighbours'; put back if refused) and a chat message (shown as sending; its text back in the composer if refused). An answer to an ask isn't: the ask stays until nest has taken it.
- **Actions follow the state machine:** a button shows only when `src/tasks.ts` allows its move. Cancelling, deleting and marking done are confirmed, with the safe choice focused; "Mark done" shows only for a task with no PR and no live worker. A failed write is a notification (bottom right) with the Worker's reason.
- **The shell** (the skill's [Navigation](../.claude/skills/nest-ui-design/SKILL.md#navigation)): a persistent left sidebar (a burger-toggled drawer below `md`). At its top the product's name, small; then **which project**, a switcher (the current project's name; a searchable, keyboard-first list of "All projects" and every project, keeping the view on a pick); then **which view**, the project's Manager (first, the default), Board, Reviews and Settings as flat rows (Board carries its "needs you" count, the one place it shows for the current project; the switcher's list shows every project's); outside a project, the projects list's row only; Admin at its foot. Every row is one `NavRow`; the active one is quiet (the subtle ground, full weight, a 2 px rule in the text color). The page's h1 is the project's name, with the repo, auto-assign and the worker cap below it; no breadcrumb.
- **Settings:** what can be changed (Workers, Auto-merge) as two Panels in one row, saved together by the Save right under them at the bottom right (on a phone, right after the last field); then what's read-only (the project's repo, its secrets) in a row of its own. Panel titles are h4s, and each Panel is as tall as its content.
- **Routes:** `/projects` (the list; `/` redirects there); `/projects/<id>/manager` is the default for `/projects/<id>` (an old link with `?task=` goes to the board); `/projects/<id>/board` ( "Needs you" at the top, its oldest three shown and the rest behind "Show all (n)", then the board at full width, `?task=<id>` opening the task's drawer; an old `/projects/<id>?task=…` link redirects with its task), `/projects/<id>/manager` (the chat; `?view=trace` the manager's live trace), `/projects/<id>/reviews` (ReviewDO's jobs, read-only, each with its reviewer's live trace on demand; a table, or below `sm` a card per review: its PR and title, sha, state, verdicts, when, and its trace), `/projects/<id>/settings`, and `/admin` (the catalog sync and the last one). Each page is a chunk of its own, loaded on first visit; Mantine, React and the other libraries are chunks of their own too (vite.config.ts), cached across releases.
- **The Manager page:** in the same frame as every view: the conversation on the frame's left edge, at least the reading measure, and a context column beside it to the frame's right edge, at most a third of the width, one `2xl` gap away at every width: "Working on" (the tasks under way, `assigned` to `stalled`, newest change first, as task cards; five, then "and N more on the board"; the count is all of them) and "Needs you" (the oldest three asks and blocks, each a link to the Board's "Needs you", or a sentence when there are none). Its status is the header's. Below `lg` the context is a disclosure above the chat ([the chat](#the-manager-chat)). The manager's status comes from `GET /api/projects/<id>/manager` (`src/manager.ts`): attaching, attach failed (with a retry), starting, waiting for a host, running (and what it's doing), errored, ended.
- **History** reads as sentences ("PR #118 opened", "Assigned to agt_…", "Spec written, 3 acceptance criteria"), with who and when; the raw detail is behind "Details".
- **The board's cards** carry `tainted` (any write to the task came from a tainted session), which the task list returns, a "Blocked" badge (warning) while the task is blocked, and a "needs input" marker from the project's open asks.

### The manager chat

`src/ui/features/chat/` (the model in `model.ts`, pure), styled by `layout/ChatLog.tsx`. The bar is Claude.ai's and Linear's.
- **The page never scrolls; the chat does.** From `sm` up the log scrolls in itself, filling down to the viewport's bottom with the composer docked under it (the context column beside it scrolls on its own); on a phone the page's column is the one scroller (the viewport less the top bar), the header and "About the manager" scrolling away above the log and the composer pinned at the bottom. It follows the end only while you're there: then nothing in it anchors the scroll, and new messages and growing content (math, a figure decoding, a chip resolving) keep the end in view. Scrolling up leaves the end; reading back, the browser's scroll anchoring holds your place, on whole messages only (a chip re-wrapping inside one can't move it). A message that arrives meanwhile shows "Jump to latest · n new". Sending goes to the end wherever you were.
- **History pages:** the latest 50 (`GET /api/projects/:id/chat`, `?limit` up to 200), and scrolling near the top loads the 50 before the oldest shown (`?before=<seq>`), keeping your place.
- **Grouping:** by author within five minutes, a separator at each new day ("Today", "Yesterday", the date). The owner's messages are a quiet bubble on the right; the manager's are unboxed prose across the measure; the app's notes are centred captions. A message's time and actions (copy, as Markdown for the manager's; quote in a reply; retry) show on hover or focus, always on touch.
- **The turn in progress,** from the manager's live trace (the same WebSocket as the Trace tab): its text so far as it streams, ending in a static cursor, and what it's doing now as an activity line ("Running rg sslmode", "Editing src/a.ts"). The stream is held until its message lands, so the swap doesn't jump. **Stop** (while a turn runs) is `POST /api/projects/:id/manager/interrupt`, nest's interrupt of the manager's turn.
- **The composer:** Enter sends, Shift+Enter is a new line (on touch, Enter is a new line and Send sends; Stop sits beside it); the draft is kept per project in the browser. A message that isn't taken stays in the log, not delivered, with Retry (no toast besides); the composer is free for the next. An empty chat offers starters that fill the composer, never send.
- **Unread:** the Manager row in the sidebar shows a dot with the count of the manager's messages since you last read the chat in this browser; reading it clears them. A completed reply is announced to screen readers once (never the stream's every token).

### The live trace

**Built (2026-11-02):** an agent's turns as they happen, from nest's live trace ([API](../docs/control-plane/api/), "Live trace"). Code: `src/trace.ts` (the route) and `src/ui/features/trace/` (the viewer, self-contained). Tests: `test/trace.test.ts` (the route, against a WebSocket in the fake nest) and `src/ui/features/trace/trace.test.tsx`.
- **The route:** `GET /api/agents/<id>/trace?after=<seq>`, behind Access like the rest of `/api/`. Only an agent DirectoryDO recorded for one of the app's projects (its manager, a worker, a reviewer); any other id is `404` before nest is asked. Then it opens the upgrade to nest with the client token (`fetch` with `Upgrade: websocket` and `Authorization`, nothing of the browser's forwarded) and returns nest's socket as its own `101`. Workers proxy a WebSocket that way ([Response](https://developers.cloudflare.com/workers/runtime-apis/response/): "This establishes a WebSocket connection proxied through a Worker"), so the app holds no state for it and the token never reaches the browser. nest's retryable `503` (minutes after its deploy) stays a `503`; its `404` is a `404`; any other refusal is a `502` with nest's message.
- **The history route:** `GET /api/agents/<id>/trace/history?before=<cursor>&limit=<n>`, behind Access, for the same agents as the trace (404 before nest is asked otherwise), proxying nest's [trace history](../docs/control-plane/api/) (its stored transcript) with the client token. nest's `400` and its retryable `503` pass on; its `404` is a `404`; anything else a `502`.
- **The viewer** (`TraceView`, and one mount per place: `ManagerTrace` on the Manager page's "Trace" tab, `TaskTraces` for a task's worker in its drawer, `ReviewTrace` for each review job's reviewer), a terminal transcript as Claude Code prints one (2026-11-02, the owner's):
  - **The terminal** (the `Terminal`, `TermLine` and `TermRule` primitives): the `terminal` surface with a hairline, the mono family throughout, long lines wrapped (`pre-wrap`, breaking anywhere: no sideways scroll), code keeping its spacing, and every line text, so it selects and copies.
  - **Its lines:** each turn under a quiet rule (its start time, its input's kind, how it ended, its tokens); the assistant's text after `●`; a tool call as `● Name(argument)` (an MCP tool by its own name, the main argument's first line), a disclosure whose region holds the full input; its result on the next line after `⎿`, the first 3 lines then `… +N lines (expand)`; a running call's `○`; states, asks, rate limits and exits as dim one-liners (`·`, `?`). An error is the danger role's text shade and `✗`, on the result and on the call's bullet. The glyphs are pinned by codepoint (U+25CF, U+25CB, U+23BF, U+2717, U+00B7): none has an emoji presentation, so none renders as an emoji (U+23FA would). `●`, `○`, `✗` and `⎿` are drawn in CSS at the font's stem weight (`Terminal.module.css`): JetBrains Mono's subsets lack all four (and DejaVu Sans Mono and Noto Sans Symbols 2 lack `⎿`), so the character stays in the text and the shape is what shows, the same on every system (unverified in the owner's browser). A finished call's `●` is in the success role, a failed one's in danger; a rate limit shows `!` in warning. The terminal has its own muted (`terminal-muted`) and warning shade, for AA on it, and its own hairline (`terminal-rule`, about 1.4:1) for its border and turn rules. Its rows that act (a call, `… +N lines`, "load earlier") are real buttons as wide as their row: text-line targets, the skill's exception to the 32 px rule.
  - **The assistant's Markdown** (2026-11-03, the owner's: "the cc style trace still isn't doing MD parsing"): its text is Markdown, as Claude Code prints it in a terminal (`TraceMarkdown`, into the `TermProse` primitive). Mono at the terminal's one size: headings and **bold** by weight (headings are bold lines, outside the page's outline), *italic*, inline code in the primary role's text shade, a fence verbatim behind a left hairline (its long lines scroll sideways inside it, and never widen the trace, even in a table's row: `contain: inline-size`), bullet and numbered lists with hanging indents, a task list's boxes as `[x]`/`[ ]`, a quote behind a rule and muted, links underlined and opening in a new tab, a table as a mono grid in hairlines scrolling in its own frame, and a rule. Only the assistant's text: prompts, tool calls, results and errors stay raw text. The chat's safe path with the terminal's own component map: GFM, raw HTML turned into text first (`remarkEscapeHtml`, no `rehype-raw`), links only http, https and mailto, no image loaded (`[image: alt]`), and no SVG figures or math. Half-written Markdown mid-stream parses as what it is so far (an open fence is already a code block), so no text is swallowed. History and live go through the one renderer. On touch, a paragraph or item holding a link is on 24 px lines, so the link is a WCAG 2.5.8 inline target; the rest (fences and tables included) keeps the terminal's 20 px pitch. `scripts/ui-review`'s `trace` check holds a Markdown-heavy answer to the mono, one size, and nothing but a fence or table scrolling sideways (in itself). Tests: `src/ui/features/trace/markdown.test.tsx`.
  - **Backfill:** when nest offers history (its `history` message: the ring starts after the agent did) or reports a gap with a cursor, the viewer loads the history page before it at once, then each older one as the reader scrolls to the top ("loading earlier…", then "the beginning of the trace"), keeping what was being read in place. History shows before the ring, its turns grouped by their starts (they have no ids). After a gap it drops what it held and backfills from the gap's cursor, so nothing shows twice or goes missing (nest's stitching rule).
  - The header shows the connection (Live, Connecting, Reconnecting, Ended) and the agent's last state. It follows the newest line only while scrolled to the bottom; above it, "Jump to live (n new)".
  - **Reconnects** after a drop from the last seq received (`after`), 1 s doubling to 30 s, starting over once a connect's backlog is done; never after `ended`. A repeated seq is dropped. A `ping` every 25 s keeps the socket open without waking the agent's object.
  - **Motion:** a line that arrives after nest's `live` marker fades in (`base`, 180 ms, the `FadeIn` primitive); the backlog, history and everything replayed on a reconnect don't. Reduced motion makes it instant.
  - At most 2,000 ring events are kept per view; older ones are dropped from it, and it says so.
- **The task drawer** (2026-11-02, the owner's): a task that has or had a worker shows its trace beside its details. The sheet has one width whatever the task holds, so its title never moves: from `xl` on `--nest-sheet-wide` (`min(84rem, 100vw - 6rem)`), with two columns that scroll on their own, the details first and wider (`--nest-sheet-details`, 40rem, a reading line) and the trace in the rest, filling its column with its header kept in view. The task is what's read first, the trace its companion ([descriptions](#descriptions), 2026-11-03; it was a third before, which the owner found too narrow). Below `xl` (at 1200 px the wide sheet would cover the page) they're "Details" and "Trace" tabs, each the sheet's full height and kept mounted with `keepMountedMode="display-none"` (Mantine's default, React's `<Activity hidden>`, runs effect cleanups, which closed the trace's socket; the log's scroll is kept across the hide too), so switching keeps the trace's connection, scroll and what's expanded; the trace's status sits on the terminal's first line, with no second heading. A component test can't see the difference (Mantine renders without `<Activity>` in its test environment): `scripts/ui-review`'s `trace-tabs` check drives a real browser through the switch. At the wide width, a task without a worker shows "No worker yet" in the trace column. A task with no worker keeps the single column (at a form's measure in the wide sheet). Tabs are one style everywhere: a hit target's height, 44 px on touch (`global.css`). On touch, every control outside running text is at least 44 px each way, as layout (`global.css`): links, buttons, icon and close buttons, fields; a link inside a sentence keeps its line (the inline exception). A badge with details is a `TriggerBadge`, its tooltip opening on hover, focus and touch; on a card (Board, chat, context) it's plain status on touch (`plainOnTouch`, its name kept), since the card opens the drawer where the same badges explain themselves (the drawer's Tainted, a security signal, always does); a badge that's a link is a `BadgeAnchor`. Number inputs hide their steppers on touch. Rows of controls take a 44 px pitch on touch (`data-touch-pitch`: a dependency's rows, a review's wrapped verdicts), a PR's two control rows have its "Attached by" line between them, a section whose heading has an action keeps a little more room under it, and a table's cells the room for that pitch across rows; a row's action (Detach, Remove) is a 44 px box that keeps its line.

### Descriptions

The owner (2026-11-03): "wysiwyg editor for issues pls? It's also a little narrow in proportion to the worker trace."

- **Markdown on the wire and in storage.** The manager and workers read and write a task's description over MCP as Markdown. Only the page edits it as a document.
- **Read** as the chat renders Markdown (`RichMessage`: the same safe path, no raw HTML, links only http, https and mailto). The drawer's heading is the task's title. "Edit" is at the section's top right while the task can change; a finished task (done, cancelled) is read only.
- **Edited** in Mantine's RichTextEditor over Tiptap (`DescriptionField`, the `RichEditor` primitive), wherever a task is created or edited: the board's new-task form and the drawer's Edit.
  - **The toolbar,** common marks first: bold, italic, inline code; bullet, ordered and task lists; link and unlink; then heading, code block, quote and strikethrough. Below `sm` it's one row that scrolls sideways. There's one Heading control: a description's headings are drawn at one size by weight, as a rich message's are, so three levels would look the same. Inline code and a code block have distinct icons. Each control is 32 px (44 px on touch).
  - **Its content** is drawn in the rich message's prose, so what's typed looks like what's saved. A task's box is the theme's square and check-square icons (as in the chat), a 32 px target (44 px on touch).
  - **Cancel and Save** are the section's actions, at the top right of the Description heading, so they stay in view however long the description is.
  - **Leaving:** Escape, in the title or the description's text alike, leaves a form with no changes (the drawer stays open); inside the link editor it only closes the link editor. Cancel is neutral (gray): the drawer's red Cancel task may sit right above it. With unsaved changes, Cancel, Escape and closing the drawer (its close button, a click outside) all ask "Discard changes?", with Keep editing as the default.
  - **Focus:** opening Edit focuses the title; leaving returns focus to Edit.
  - **Loading:** the editor's code (Tiptap) is its own chunk. It's fetched ahead when the drawer is idle, or when the pointer or focus reaches Edit or New task. Until it's in, the description stays as it reads, so nothing below it moves twice (ui-review's `editor` check).
- **The round trip** (`src/ui/rich/editor-markdown.ts`, pure):
  - **Reading:** each top-level block is read from the renderer's own tree (remark with GFM and math, as the chat parses it) into Tiptap's nodes. It goes into the editor only if Tiptap, writing it back, gives the same tree, so no block is changed silently.
  - **Kept blocks:** a block the editor has no node for is **kept as written** in a `markdownBlock` node. That covers a table, raw HTML, an image, math, a footnote, a reference link and its definition, a link the renderer won't follow, a fence with an info string beyond its language, and a list holding any of these. It shows as its Markdown source, edited in place like code, under a caption saying why ("The editor can't show this (a table); edit its Markdown here"), and it's written back as it stands.
  - **What's shown is what's saved:**
    - Literal text is escaped where Markdown would read it as something else: a line starting `1. `, `- `, `+ `, `#`, a `---` or `===` line, a table's delimiter row, or a heading's trailing `#`s. Tiptap escapes the inline marks itself.
    - Bold and italic happen as you type only where CommonMark reads the delimiters so: `*x*` and `**x**`, never around a space, so `2 * 3 * 4` stays text.
    - A code block's fence is longer than any backtick run in its code.
    - An ordered list not starting at 1 gets a blank line before it, since it can't interrupt a paragraph.
    - Two lists in a row with the same marker would read as one list, so the second takes another marker.
    - A property test writes random documents of the editor's nodes, full of Markdown's own characters, and requires each to read back as the same document.
  - **What can't round-trip:** an empty paragraph, and a bare URL or address that isn't a link (GFM links it in the chat; the editor links it as it's typed).
  - **Why the reading is the renderer's:** Tiptap's own Markdown parser (marked) misread three-deep nesting. Its serializer (`@tiptap/markdown`) writes.
- **Only what changed is saved.** The editor's untouched output is the baseline, so opening and saving a description sends nothing. A title change sends the title only, and the description is never rewritten in the editor's own Markdown unless it was edited.
- **A paste:**
  - **Plain text** is read as Markdown, as an agent's description is, so it shows as it will be saved.
  - **HTML:** ProseMirror parses it by the editor's schema, so no script, style, image or unsafe link survives. A table comes in as its Markdown table, kept as written, with its cells apart. Word's list paragraphs come in as a list.
- **The split** (the task drawer, from `xl`; its details column has `md` of room before its scrollbar): the task is what's read first, so its column is the wider one, `--nest-sheet-details` 40rem (body-lg prose at about 70 characters, inside the reading measure). The trace, its companion, gets the rest: about 37rem to 39rem, roughly 80 columns of its mono. The sheet is `min(84rem, 100vw - 6rem)`, so a sliver of the board stays beside it. Below `xl` they're still tabs. A user-resizable divider was considered and not done: a fixed ratio keeps the frame stable (the skill's rule) and needs no stored width or keyboard handle, and both columns are already at a reading width.

### Rich messages

The manager's messages (in the chat, and its asks and blocks in "Needs you") render; the owner's stay plain text with their line breaks. `src/ui/features/rich/`, `src/ui/rich/`, styled by `layout/Rich.tsx`.

- **Markdown:** `react-markdown` with `remark-gfm` (headings, lists, task lists read-only, tables in a scroll frame, quotes, code in the mono family, links). **A message can't change the page's outline:** its headings are demoted by three (`remarkDemoteHeadings`: `#` is an h4, down to h6) and set at body size by weight. **Raw HTML is never rendered:** it becomes literal text before parsing (`remarkEscapeHtml`), and no `rehype-raw` is in the pipeline.
- **Links** only `http:`, `https:` and `mailto:` (new tab, `noopener noreferrer`); anything else is plain text. **No remote image** (no tracking pixel): `![alt](url)` is a link labelled with the alt text; only a `data:image/png|jpeg|gif|webp` image shows inline, capped.
- **Math:** `remark-math` and `rehype-katex` (inline `$…$`, display `$$` blocks and ```math blocks), with `trust: false` (no `\href`, `\url`, `\includegraphics`, `\htmlClass`, `\htmlId`), `strict: "warn"`, `throwOnError: false` (a bad formula shows its source in the error shade), and `maxSize`/`maxExpand` caps. KaTeX's CSS and fonts come from the package. Display math scrolls in its own frame.
- **SVG, in depth:** found before Markdown (a ```svg block, or an inline `<svg>…</svg>`); sanitized with DOMPurify's SVG profile plus stricter rules (no `foreignObject`, `script`, `on*`, non-fragment `href`/`xlink:href`, outside `<use>`, fetching `<style>`), checked again after, refused above 200 KB; and **shown only as an `<img>`** from a `data:image/svg+xml` URL, never inline, so a sanitizer bug still can't run anything. It sits on a fixed light canvas (white, a hairline) in both schemes, never inverted, so its own colours read as drawn. A click opens it larger (still an image); "View source" shows the sanitized SVG.
- **Task references:** `[text](task:tsk_…)` or a bare `task:tsk_…` is a chip (the live title, then its state badge, at the text's size); a ```tasks block (an id per line, optionally a note) is a card per task, with the Board's card body (`TaskCardBody`: title, state, Blocked, Needs input, Tainted, assignee, PRs with their review) and the note. Always resolved live from the project's board (one query, polled with it); an id the board doesn't have is muted inline code. A chip or card opens the task in the Board's drawer.
- **CSP:** the page's strict policy ([above](#the-ui), `src/csp.ts`) is what a message relies on: `script-src 'self'` (no inline script), `img-src 'self' data:` (the SVG figures and inline rasters, no remote image), `font-src 'self' data:` (KaTeX's), `style-src 'self' 'unsafe-inline'` (Mantine's variables and KaTeX's sizes), connections to this origin only.

### Design system

The values and rules are the [nest-ui-design skill](../.claude/skills/nest-ui-design/SKILL.md)'s; this app implements them.

**Tokens**, defined once in `src/ui/theme.ts` as Mantine theme values and `--nest-*` CSS variables, light and dark (the scheme follows the system):

| Token | Values |
|---|---|
| Fonts | Inter Variable (UI), JetBrains Mono Variable (ids, code, the trace), from `@fontsource-variable/*`; no external request |
| Type | caption 12/16 (`xs`), small 13/20 (`sm`), body 14/20 (`md`), body-lg 16/24 (`lg`); h4 14/20, h3 16/24, h2 20/28, h1 24/32, all 600; weights `regular` 400, `medium` 500, `bold` 600 |
| Spacing | `2xs` 2, `xs` 4, `sm` 8, `md` 12, `lg` 16, `xl` 24, `2xl` 32, `3xl` 48, `4xl` 64 (px) |
| Radii | `sm` 4 (badges, inputs), `md` 8 (panels, buttons) |
| Borders, shadows | a 1 px hairline in `border`; `raised` (a dragged card) and `overlay` (drawers, modals) |
| Neutrals (light / dark) | page `#fafafa` / `#121314`, surface `#ffffff` / `#1a1b1e`, subtle `#f1f3f5` / `#222327`, border `#e9ecef` / `#2c2e33`, text `#212529` / `#e9ecef`, muted `#666e76` / `#9aa0a6` |
| Roles (filled, light / dark) | primary `#3b6fc0` / `#5a8ad6`, danger `#c2414c` / `#d9606a`, warning `#dca71c` / `#e3b341`, success `#2c8152` / `#3f9e6a`; label white (dark on warning) in light, `#121314` in dark |
| Motion | 120 / 180 / 240 ms, `cubic-bezier(0.2, 0, 0, 1)` in, `cubic-bezier(0.4, 0, 1, 1)` out; opacity and transform only; reduced motion honoured; a spinner only after 300 ms |
| Layout | page max 1440 px; gutters `lg` / `xl` / `2xl` (phone / tablet / desktop); sidebar 264 px from 62em (a drawer below), collapsing in 180 ms; reading measure 42rem; board columns at least 8.5rem from 62em (16rem below), all six fitting beside the sidebar at 1280 px |

**Primitives** (`src/ui/layout/`): `AppFrame` (the sidebar: the name small at its top, the places, a footer; a burger-toggled drawer below `md`; and the content), `NavRow`/`NavGroup`/`NavGroups` and `SwitcherTarget` (the sidebar's one row style, its groups, and the switcher's button), `Page` (one frame for every view: the max width, gutters, `2xl` between blocks; it never moves), `Measure` (narrow content, `reading` or `form`, on the frame's left edge), `WithContext` (that content, at least its measure, with a sticky context column beside it to the right edge, at most a third; a disclosure above it below `lg`), `SectionGrid` (sections as Panels, two columns from `lg`, each as tall as its content), `PageHeader` (the one h1 with its actions right on its row, wrapping when narrow, and a meta line; no breadcrumb), `Section` (a heading row of one height: title, count, actions right; `dense` for a board column; `order={4}` inside a Panel), `Panel` (the bordered surface, `lg` padding, `md` when dense; never nested) and `Well` (the borderless subtle region that holds Panels), `Toolbar` (actions `sm` apart, wrapping; destructive ones last after a divider), `Stack` and `Row` (gaps from the scale), `FieldGroup` (fields `lg` apart, actions bottom right), `EmptyState`, `LoadingState`, `ErrorState` and `Notice`, `MetaRow`/`MetaItem` (caption lines), `TableFrame` (a dense table in a frame, scrolling in itself), `CardGrid` and `ColumnGrid` (the projects, the board), `SortablePanel` (a draggable card), `Sheet` (the task drawer; with `beside`, two columns from `xl` and tabs below), `RichEditor` (a Markdown field edited as it renders), `Terminal`, `TermLine`, `TermRule` and `TermProse` (a trace's terminal transcript, and an assistant's Markdown in it), `ChatLog`, `ChatFrame`, `DaySeparator`, `MessageGroup`, `MessageRow`, `JumpPill`, `StreamText`, `ActivityLine`, `ComposerDock` and `CodeFrame` (the chat), `TaskChipPending` (a task chip while the board loads), `TouchTarget` (a small trigger's 44 px room on touch), `ScrollLog` (a log of a fixed height, or with `fill` the rest of a column: a trace), `FadeIn` (something that just arrived, once), `Prose`.

**Rules:**
- **Placement:** a section's primary action at its top right, secondary ones to its left; destructive ones last, set apart, and confirmed. In forms and dialogs the actions are bottom right, the primary rightmost. A status badge right after the thing it's about; who and when on a caption line below.
- **Proximity:** `sm` between a card's lines, `md` between cards, `2xl` between a page's blocks.
- **Similarity:** one card (a Panel), one badge per status, one button hierarchy (filled primary, default secondary, subtle tertiary; red for close and cancel).
- **Enforced** by `src/ui/design.test.ts`: outside `theme.ts` and `layout/`, no inline `style`, `className` or CSS; no raw lengths or literal colors; colors only by role, gray, `dimmed` or `bright`; spacing only by the scale's names; weights by name; and no Mantine layout container (Group, Stack, Paper, Box, …). `src/ui/theme.test.ts` reads the skill's tables and checks every token against them, AA contrast in both schemes, and each status's role. `src/ui/layout/layout.test.tsx` checks the primitives' placement.

```bash
npm run dev    # the page and the API in workerd; without NEST_CLIENT_TOKEN the API answers, but nothing reaches nest
npm test       # two vitest projects: `worker` (workerd) and `ui` (jsdom, Testing Library)
```

**Spawning:** a worker may run Claude Code's own subagents (the `Agent` tool, through nest's `subagents` capability). They live in its brain and reach the same sandbox through its hands, with the same grant and taint. No role gets nest-level spawning (`spawn_agent`, `fork_sandbox`): the app starts every agent itself, one worker per task (`test/catalog-roles.test.ts`).

## Setup (the operator's)

1. Create the client: `POST /v1/admin/clients {name: "projects", grant}`, and store its token as the Worker's secret `NEST_CLIENT_TOKEN`.
2. Cloudflare Access comes from the app's own inframe stack, [`deploy/`](deploy/) (not nest's `edge` stack): the owner's login on `projects-nest.bitcru.sh`, with `/hooks` and `/mcp` bypassed, since they are authenticated by signature and by identity instead. `.github/workflows/deploy-projects-infra.yml` applies it on a push to `main` that touches `deploy/`, with `CLOUDFLARE_ACCESS_API_TOKEN` (Access: Apps and Policies: Edit); or by hand, `inframe plan --stack projects` then `apply` ([deploy/README.md](deploy/README.md#use)). Set `PROJECTS_AUD` in `wrangler.jsonc` to its output `projects_aud`.
3. The Worker deploys by `.github/workflows/deploy-projects.yml` on a push to `main` that touches `projects/` (outside `deploy/`), to `projects-nest.bitcru.sh`. It puts its secrets from the `production` environment's `PROJECTS_NEST_CLIENT_TOKEN`, `PROJECTS_NEST_WEBHOOK_SECRET` and `PROJECTS_GITHUB_WEBHOOK_SECRET` when they're set. Then `POST /api/admin/sync` writes the catalog.
4. `PUT /v1/clients/self/webhook {url: https://projects-nest.bitcru.sh/hooks/nest}` (the app does this at its first start), and store the secret as `NEST_WEBHOOK_SECRET`.
5. Point the GitHub App's webhook at `https://projects-nest.bitcru.sh/hooks/github` (content type `application/json`), with a new secret, stored as `GITHUB_WEBHOOK_SECRET` (`wrangler secret put`). Subscribe the App to the `pull_request` and `check_run` events. The App needs the repository permissions the grant names (Checks: read and write, Administration: read and write, Metadata: read) and Pull requests (read at least), without which GitHub doesn't offer the `pull_request` event. Its installation must cover each attached repo. For auto-merge, the App also needs Contents: read and write, and Pull requests: read and write.
6. **Auto-merge's permissions (2026-11-02):** add `pull_requests: write` and `contents: write` to the live client's `github.permissions`. Use `PATCH /v1/admin/clients/<id>`, which takes the grant ([clients doc](../docs/control-plane/api/clients/)). Until then, turning auto-merge on writes the repo setting, but each PR's auto-merge fails with nest's 403, recorded on its task.

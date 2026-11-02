# nest projects

A task board for GitHub repos, run by agents on nest: an app with its own Worker and Durable Objects, built only on nest's [API clients](../docs/control-plane/api/clients/) interface. nest knows nothing of projects, tasks or reviews. A feature here that seems to need one of nest's internals means that interface is wrong: fix it there, generically, and build this on the result.

**Status:** designed (2026-11-02, the owner's request). **Built:** the core: the Worker, the three Durable Objects, the catalog sync, the JSON API, the MCP servers and nest's webhook ([below](#built-the-core)); attaching a repo and the review pipeline ([below](#built-the-review-pipeline)). **Not built:** the UI (a placeholder page), setting nest's webhook at first start, and starting a new manager once one ends (it's recorded in the chat). Builds on API clients, caller identity, events to the owner and GitHub tokens.

## What it does

- **Projects.** A project is attached to one GitHub repo the owner owns, one that nest's GitHub App is installed on and that the app's grant names.
- **The manager.** One agent per project, the one the owner talks to. It keeps the board, specs each task as it's created, and assigns tasks when the project is set to assign automatically.
- **Tasks.** The owner or the manager creates them, and the manager specs them. They're assigned by hand from the board, or automatically. An assigned task gets a worker of its own: one agent, which sees only that task and opens one PR for it.
- **Review.** Every PR on the repo gets a review by a reviewer agent, asynchronously. The review judges correctness, quality and architectural cohesiveness, and sets a required check. Branch protection, which the app sets up, makes merging wait for that check.
- **Done.** A task is done when its PR is merged. Merging needs the review check to pass.

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
- `repos` and `github.repos`: the attachable repos;
- `github.permissions`: `checks: write` (check runs), `administration: write` and `metadata: read` (branch protection, the default branch). The app reads nothing else on GitHub: a PR's number, head, base and title come in its webhook, and the reviewer reads the code in its sandbox;
- `mcp_urls: [https://projects-nest.bitcru.sh/mcp/]`;
- `max_agents` and `max_sandboxes`.

| Need | Interface |
|---|---|
| Templates for the three roles | `PUT /v1/catalog/templates/projects/{manager,worker,reviewer}` and capabilities `projects/{board,task,review}` (the MCP URLs), synced from this directory at deploy |
| Starting an agent | `POST /v1/sandboxes {cell, labels}`, then `POST /v1/agents {template: "projects/<role>", cell, sandbox, labels, overrides: {repos: [<repo>]}}`, each with an `Idempotency-Key`. Its sandbox pushes only to that repo; the agent clones it |
| Talking to the manager | `POST /v1/agents/<id>/inbox`. Replies arrive as `agent.turn_completed` events |
| Approvals | `agent.ask` events, shown on the board, answered by `POST /v1/agents/<id>/asks/…` |
| Ending a worker or reviewer | `POST /v1/agents/<id>/stop {end: true, destroy_sandbox: true}` |
| Knowing what agents did | Signed webhooks to `/hooks/nest`, deduplicated by event `id`. After a gap (the dropped count rises), it re-reads `GET /v1/agents?label=project=<id>` |
| Check runs and branch protection | `POST /v1/clients/self/github-token {repo, permissions}`, then GitHub's API with that token |
| GitHub's events | The GitHub App's webhook, pointed at `/hooks/github` by the operator (nest consumes none of it) |
| Telling which agent calls the MCP server | The `Nest-Identity` JWT on every request, checked against nest's JWKS |

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
  - A worker reads its `task`, posts progress on it, and says when its PR is open. It sees no other task.
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
- **Merging** is GitHub's, gated by the required check. A `pull_request` `closed` event with `merged: true` marks the PR's task `done` and ends its worker; closed without merging, it's noted in the task's history and the task stays. The owner may also mark a task done by hand once its PR is merged.

## Not decided here

- The reviewer is one agent judging all three dimensions. Three agents, one per dimension, is a later choice if one agent's verdicts prove uneven.
- Tasks without a PR (research, specs) end by the owner marking them done.
- Whether PRs from outside the owner's account are reviewed: on a public repo anyone's PR starts a reviewer (the owner asked for any PR). `max_concurrent_reviews` caps how many run at once, not how many run.

## Built: the core

**Code:** `src/worker.ts` (routes, the Access check of `src/access.ts`, a copy of the dashboard's, and `/hooks/nest`), `src/api.ts` (the JSON API), `src/mcp.ts` and `src/identity.ts` (the MCP servers and Nest-Identity), `src/tools.ts` (each server's tools), `src/catalog.ts` (templates, capabilities, prompts), `src/nest.ts` (the client of nest), `src/tasks.ts` (the state machine, pure), `src/webhook.ts` (`Nest-Signature`), `src/do/` (DirectoryDO, ProjectDO, ReviewDO's schema), `src/sql.ts` (versioned migrations), `deploy/` (Cloudflare Access in front of it: the app's own inframe stack). Nothing imports the control plane (`test/deps.test.ts`).

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
  - **Push scope:** each role template's `repos` is every attached project's repo, and each spawn narrows it to its project's (`overrides.repos`). Creating a project syncs the catalog again first.
  - **Labels:** `project`, `role`, `task` for a worker, and `start`, the task's (or the manager's) start count. They find the app's agents again after a gap (`GET /v1/agents?label=…`).
  - **Creates are idempotent:** each start attempt sends `Idempotency-Key: <project>/<task or manager>/<start>/{sandbox,agent}` with its creates, so a retry after a lost answer gets the same sandbox and agent back. A key nest is still handling (a retryable 409) is retried like a 503; a key bound to another request (a 409 that isn't) is a refusal for good.
  - **First input:** the worker's brief (title, body, spec, repo, branch) and the manager's go to their inbox with a request id, so a retry posts once. A brief for a task any tainted session wrote is posted as relayed text (`from: "projects/board"`), so the worker's session is tainted too.
  - **Retries:** ProjectDO owes nest its manager, workers, stops and chat messages, each retried from its alarm (5 s doubling to 5 min); a retryable 503 or 409 is also retried within the call. A worker nest refuses for good (a 4xx) stalls its task with the reason; the manager is retried until it starts.
- **The board:**
  - **States** (`src/tasks.ts`): `draft` → `ready` (specced) → `assigned` → `in_progress` (worker started) → `in_review` (PR reported) → `done`, with `stalled` and `cancelled`. A task is assigned only once specced. The owner may mark any task done (one with no PR); a draft may be deleted, anything later is cancelled.
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
  - **Reviewers:** made as workers are (`Nest.startAgent`, `Idempotency-Key: <project>/review/<pr>/<sha>/<start>/{sandbox,agent}`), labelled `project`, `role=reviewer`, `pr`, `sha`, `start`, and ended with their sandboxes (`stop {end, destroy_sandbox}`) on a verdict, a newer head, a closed PR, or an exit. Two more starts after an exit without a verdict.
  - **The brief** has only what the app knows from GitHub's routing (repo, number, head, base), none of the PR's own text. `review_get` gives the title.
- **The check:** `nest-projects/review`, created `in_progress` at the head with `details_url` the project's board. On completion:
  - a verdict: `success` only if all three pass, else `failure`. The title names the failed dimensions, the summary is the reviewer's, the text holds each dimension's notes, the reviewer and whether its session was tainted. Clipped to GitHub's 65535 characters (the title to 255; GitHub documents no limit for it);
  - no verdict: `action_required` (above);
  - superseded or closed: `cancelled`.
- **The verdict** (`/mcp/review`): `review_get` and `submit_review {correctness, quality, architecture: {verdict: pass|fail, notes}, summary}`. The caller's `pr` and `sha` labels name its job; only that job's current reviewer may submit, once, while the job runs. A retry with the same call key gets the first answer. The taint is recorded with the verdict.
- **Attaching:**
  - **Required checks that exist** change only their lists (`PATCH …/required_status_checks`), and only when the check is missing or not yet pinned to the App; `strict` and everything else stay. A second attach writes nothing.
  - **A branch protected without required checks** gets its protection written back whole with them (`PUT`, from what `GET` answers). Required signatures aren't in that body (unverified that `PUT` leaves them).
  - **The App's id:** with it known, the check is required from the App (`checks: [{context, app_id}]`), so no other app or commit status can pass it. nest's token answer doesn't name the App, so the app learns its id from its first check run's `app.id`. Until then, the check is required from any source (`contexts`, or `checks` without `app_id` where other entries are pinned, which keeps their pins). The project then attaches again to pin it. Another entry's `app_id: null` (any source) is sent back as `-1`, GitHub's "any app".
  - Rulesets aren't read or changed: a repo protected by rulesets alone gets branch protection besides.
- **Tasks and PRs:** a `pull_request` from the repo's own branch `task/<id>` (not a fork's) links the PR to its task (`pr_opened`) if the worker hadn't reported it. Merged, the task is `done` (through `pr_opened` first if it was still `in_progress`) and its worker ended.

## Setup (the operator's)

1. Create the client: `POST /v1/admin/clients {name: "projects", grant}`, and store its token as the Worker's secret `NEST_CLIENT_TOKEN`.
2. Cloudflare Access comes from the app's own inframe stack, [`deploy/`](deploy/) (not nest's `edge` stack): the owner's login on `projects-nest.bitcru.sh`, with `/hooks` and `/mcp` bypassed, since they are authenticated by signature and by identity instead. `.github/workflows/deploy-projects-infra.yml` applies it on a push to `main` that touches `deploy/`, with `CLOUDFLARE_ACCESS_API_TOKEN` (Access: Apps and Policies: Edit); or by hand, `inframe plan --stack projects` then `apply` ([deploy/README.md](deploy/README.md#use)). Set `PROJECTS_AUD` in `wrangler.jsonc` to its output `projects_aud`.
3. Deploy the Worker to `projects-nest.bitcru.sh`, then `POST /api/admin/sync` to write the catalog.
4. `PUT /v1/clients/self/webhook {url: https://projects-nest.bitcru.sh/hooks/nest}` (the app does this at its first start), and store the secret as `NEST_WEBHOOK_SECRET`.
5. Point the GitHub App's webhook at `https://projects-nest.bitcru.sh/hooks/github` (content type `application/json`), with a new secret, stored as `GITHUB_WEBHOOK_SECRET` (`wrangler secret put`). Subscribe the App to the `pull_request` and `check_run` events. The App needs the repository permissions the grant names (Checks: read and write, Administration: read and write, Metadata: read) and Pull requests (read at least), without which GitHub doesn't offer the `pull_request` event. Its installation must cover each attached repo.

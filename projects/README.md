# nest projects

A task board for GitHub repos, run by agents on nest: an app with its own Worker and Durable Objects, built only on nest's [API clients](../docs/control-plane/api/clients/) interface. nest knows nothing of projects, tasks or reviews. A feature here that seems to need one of nest's internals means that interface is wrong: fix it there, generically, and build this on the result.

**Status:** designed (2026-11-02, the owner's request), not built. Builds on API clients, caller identity, events to the owner and GitHub tokens.

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
| `DirectoryDO` (one) | Projects, repo → project, agent → project and role, the app's catalog sync state |
| `ProjectDO` (one per project) | The project's settings, the board (tasks, specs, assignments, the history of each), the chat with the manager, PR → task |
| `ReviewDO` (one per project) | The review queue: one job per PR head, its reviewer agent, its check run, its verdict. It's an asynchronous process of its own, with its own alarm and an optional concurrency cap (none by default) |

All state is the app's. nest holds the agents, their sandboxes and their transcripts, and labels each agent with `project`, `role` and, for a worker, `task`, or for a reviewer, `pr` and `sha`. The app finds its agents by those labels after losing track of one.

## How it uses nest

Only the client interface. One client, `projects`, has this grant:
- `cells`, and `credentials: [claude_oauth_token]`;
- `repos` and `github.repos`: the attachable repos;
- `github.permissions`: `checks: write`, `administration: write`, `pull_requests: read`, `contents: read`;
- `mcp_urls: [https://projects-nest.bitcru.sh/mcp/]`;
- `max_agents` and `max_sandboxes`.

| Need | Interface |
|---|---|
| Templates for the three roles | `PUT /v1/catalog/templates/projects/{manager,worker,reviewer}` and capabilities `projects/{board,task,review}` (the MCP URLs), synced from this directory at deploy |
| Starting an agent | `POST /v1/agents {template: "projects/<role>", labels, …}`. Its sandbox has the repo checked out, and pushes only to that repo |
| Talking to the manager | `POST /v1/agents/<id>/inbox`. Replies arrive as `agent.turn_completed` events |
| Approvals | `agent.ask` events, shown on the board, answered by `POST /v1/agents/<id>/asks/…` |
| Ending a worker or reviewer | `POST /v1/agents/<id>/stop`, then end |
| Knowing what agents did | Signed webhooks to `/hooks/nest`, deduplicated by event `id`. After a gap (the dropped count rises), it re-reads `GET /v1/agents?label=project=<id>` |
| Check runs and branch protection | `POST /v1/clients/self/github-token {repo, permissions}`, then GitHub's API with that token |
| Telling which agent calls the MCP server | The `Nest-Identity` JWT on every request, checked against nest's JWKS |

## The MCP server: agents see only their own work

- **One URL per role:** `/mcp/board` for the manager, `/mcp/task` for a worker, `/mcp/review` for a reviewer. nest lists a server's tools over one session shared by every agent on it, so a role's tool list is its URL's. Which data a call may touch is decided per call, from the caller's identity.
- **Every request** must carry a valid `Nest-Identity`:
  - signed by a key from nest's JWKS;
  - `aud` is that URL, and `iss` is nest;
  - `client` is the app's own client id;
  - **`owner` is also the app's client id.** Only agents the app created itself are trusted. A spawned agent's labels are whatever its spawner chose, so they mean nothing here.
  - There is no bearer secret: the identity is the credential.
- **Scope comes from the labels:**
  - The manager reads and writes the board of its `project`.
  - A worker reads its `task`, posts progress on it, and says when its PR is open. It sees no other task.
  - A reviewer reads its `pr` at its `sha`, and submits one verdict per dimension (correctness, quality, architectural cohesiveness) with a summary.
- **`tainted`** is recorded with each write and shown on the board. It gates nothing: a worker and a reviewer read repo content by design.

## Flows

- **Attaching a repo.** The owner picks a repo from those both in the grant and in the App's installation. The app then does three things:
  - mints a token with `administration: write`;
  - sets branch protection on the default branch, requiring the check `nest-projects/review` from the App, with nothing else changed;
  - starts the project's manager.
- **A task:**
  1. It's created (`draft`).
  2. The manager specs it (`ready`).
  3. It's assigned (`assigned`), by the owner from the board, by the manager, or automatically. Automatic assignment takes `ready` tasks in board order while the project's live workers are fewer than its `max_workers`.
  4. The app starts a worker labelled with the task (`in_progress`).
  5. The worker pushes a branch `task/<task-id>` and opens a PR (`in_review`). The PR's branch maps it to the task.
  6. The PR is merged (`done`), and the worker is ended.
  
  A worker that exits before opening a PR leaves the task `stalled`, shown on the board, to be reassigned. Cancelling a task stops its worker.
- **Review:**
  1. GitHub's `pull_request` events (`opened`, `synchronize`, `reopened`) reach `/hooks/github`, which checks the signature.
  2. ReviewDO queues a job for the PR's head SHA. A newer head replaces a queued job and stops a running one.
  3. Each job creates a check run (`in_progress`) and starts a reviewer.
  4. The reviewer's verdict completes the check: `success` only if all three dimensions pass, with the summary as the check's output.
  5. A reviewer that exits without a verdict fails the job after retries, and the check completes as `neutral`, which branch protection doesn't accept as passing. A `check_run` `rerequested` queues the job again.
- **Merging** is GitHub's, gated by the required check. A `pull_request` `closed` event with `merged: true` marks the PR's task `done`. The owner may also mark a task done by hand once its PR is merged.

## Not decided here

- The reviewer is one agent judging all three dimensions. Three agents, one per dimension, is a later choice if one agent's verdicts prove uneven.
- Tasks without a PR (research, specs) end by the owner marking them done.

## Setup (the operator's)

1. Create the client: `POST /v1/admin/clients {name: "projects", grant}`, and store its token as the Worker's secret `NEST_CLIENT_TOKEN`.
2. Deploy the Worker to `projects-nest.bitcru.sh`. Put Cloudflare Access in front of it for the owner's login (the `edge` inframe stack), with `/hooks/*` and `/mcp/*` bypassed: they are authenticated by signature and by identity instead.
3. `PUT /v1/clients/self/webhook {url: https://projects-nest.bitcru.sh/hooks/nest}` (the app does this at its first start), and store the secret as `NEST_WEBHOOK_SECRET`.
4. Point the GitHub App's webhook at `https://projects-nest.bitcru.sh/hooks/github`, with a new secret, stored as `GITHUB_WEBHOOK_SECRET`. Subscribe the App to `pull_request` and `check_run` events.

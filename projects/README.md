# nest projects

A task board for GitHub repos, run by agents on nest: an app with its own Worker and Durable Objects, built only on nest's [API clients](../docs/control-plane/api/clients/) interface. nest knows nothing of projects, tasks or reviews. A feature here that seems to need one of nest's internals means that interface is wrong: fix it there, generically, and build this on the result.

**Status:** designed (2026-11-02, the owner's request). **Built:** the core: the Worker, the three Durable Objects, the catalog sync, the JSON API, the MCP servers and nest's webhook ([below](#built-the-core)), and the UI ([below](#the-ui)). **Not built:** attaching a repo on GitHub (branch protection), the review pipeline (`/hooks/github`, ReviewDO's queue, the reviewer's tools) setting the webhook at first start, and starting a new manager once one ends (it's recorded in the chat). Builds on API clients, caller identity, events to the owner and GitHub tokens.

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
| Starting an agent | `POST /v1/sandboxes {cell, labels}`, then `POST /v1/agents {template: "projects/<role>", cell, sandbox, labels, overrides: {repos: [<repo>]}}`, each with an `Idempotency-Key`. Its sandbox pushes only to that repo; the agent clones it |
| Talking to the manager | `POST /v1/agents/<id>/inbox`. Replies arrive as `agent.turn_completed` events |
| Approvals | `agent.ask` events, shown on the board, answered by `POST /v1/agents/<id>/asks/…` |
| Ending a worker or reviewer | `POST /v1/agents/<id>/stop {end: true, destroy_sandbox: true}` |
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
  - There is no bearer secret: the capabilities name no `auth`, so nest sends no `Authorization`, and the identity is the credential.
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
- **Merging** is GitHub's, gated by the required check. A `pull_request` `closed` event with `merged: true` marks the PR's task `done`. Marking done by hand doesn't get past this gate: it's refused for a task with an open PR (`in_review`) and for one with a live worker (`assigned`, `in_progress`, which is cancelled instead).

## Not decided here

- The reviewer is one agent judging all three dimensions. Three agents, one per dimension, is a later choice if one agent's verdicts prove uneven.
- Tasks without a PR (research, specs) end by the owner marking them done, from `draft`, `ready` or `stalled`.

## Built: the core

**Code:** `src/worker.ts` (routes, the Access check of `src/access.ts`, a copy of the dashboard's, and `/hooks/nest`), `src/api.ts` (the JSON API; its request bodies in `src/requests.ts`), `src/mcp.ts` and `src/identity.ts` (the MCP servers and Nest-Identity), `src/tools.ts` (each server's tools), `src/catalog.ts` (templates, capabilities, prompts), `src/nest.ts` (the client of nest), `src/tasks.ts` (the state machine, pure), `src/webhook.ts` (`Nest-Signature`), `src/do/` (DirectoryDO, ProjectDO, ReviewDO's schema), `src/sql.ts` (versioned migrations). Nothing imports the control plane (`test/deps.test.ts`).

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
  - **States** (`src/tasks.ts`): `draft` → `ready` (specced) → `assigned` → `in_progress` (worker started) → `in_review` (PR reported) → `done`, with `stalled` and `cancelled`. A task is assigned only once specced. The owner may mark done only a task with no PR and no live worker (`draft`, `ready`, `stalled`; a stalled task never has a PR, since one with a PR is `in_review`); a draft may be deleted, anything later is cancelled.
  - **A spec** is a goal, acceptance criteria, the files it likely touches and a test plan.
  - **`max_workers`** caps auto-assign and the manager's `assign_task`; the owner's assign by hand isn't capped (nest's `max_agents` still is). A worker counts from its assignment until it exits or the app has stopped it.
  - **History:** every change records who (the owner, the app, or an agent), what, when, and whether the session was tainted.
- **The MCP servers:** no sessions (no `Mcp-Session-Id`), JSON answers only. A worker's tools take no task id: its labels name its task. Every write is answered once per call key (`_meta["nest/call"]`) that begins with the caller's own id, kept 24 h. The reviewer's tools answer "not built" until the review pipeline.
- **Events:** deduplicated by id (DirectoryDO, 7 days) and idempotent besides. An event for an agent the app hasn't recorded is routed by that agent's labels (`GET /v1/agents/<id>`), only if the app is its client and owner; any other agent is remembered as not the app's and acknowledged. A failure answers 5xx, so nest delivers again.

## The UI

**Code:** `src/ui/`, one folder per feature (`projects`, `project`, `board`, `task`, `chat`, `asks`, `settings`, `admin`), each component next to its test. `src/main.tsx` mounts it.

- **Stack:** React 19 with [Mantine](https://mantine.dev/) 9 and a custom theme (`src/ui/theme.ts`), with one CSS module of its own (the board's grid); TanStack Query for all server state (`src/ui/api/`), TanStack Router for typed routes (`src/ui/router.tsx`), dnd-kit for reordering the board, Tabler icons.
- **One API client** (`src/ui/api/client.ts`), same origin, so Access's cookie is the only credential: nothing secret is in the bundle. Its types are the Worker's own, imported by type only; the request bodies' zod schemas live in `src/requests.ts`, which both the Worker and the forms validate with.
- **Live views poll while the tab is visible:** the chat every 3 s, the board and the asks every 5 s, the project every 10 s. The board stops polling while a card is dragged.
- **Optimistic where safe:** reordering (one `ord` written, between the new neighbours'; put back if refused) and a chat message (shown as sending; its text back in the composer if refused). An answer to an ask isn't: the ask stays until nest has taken it.
- **Actions follow the state machine:** a button shows only when `src/tasks.ts` allows its move. Cancelling and marking done are confirmed, and "Mark done" shows only for a task with no PR and no live worker; a failed write is a red notification with the Worker's reason.
- **Routes:** `/` (projects), `/projects/<id>` (board, asks, chat, settings; `?task=<id>` opens the task's drawer), `/admin` (the catalog sync and the last one). Each page is a chunk of its own, loaded on first visit.
- **Layout:** the board's columns share its width, each at least 8.5rem from 62em on (all six fit beside the chat at 1280 px) and 16rem below; past that the row scrolls sideways. A card's badges and details wrap, never clip. The chat is a 320 px side panel from 75em, below the board on narrower screens, and can be hidden (remembered per browser).
- **History** reads as sentences ("PR #118 opened", "Assigned to agt_…", "Spec written, 3 acceptance criteria"), with who and when; the raw detail is behind "Details".
- **The board's cards** carry `tainted` (any write to the task came from a tainted session), which the task list now returns, and a "needs input" marker from the project's open asks.

**The theme:** light only, near-white page (`#fafafa`) with white surfaces, near-black text (`#212529`) and Mantine's grays. Color is only for actions and status, in four roles, each a 10-shade tuple ([`src/ui/theme.ts`](src/ui/theme.ts)), Bootstrap's hues a step muted. Shade 6 is the filled one; filled text is white, or dark on yellow (Mantine's `autoContrast`):

| Role | Shade 6 | Text on it | For |
|---|---|---|---|
| `primary` (blue) | `#3b6fc0` | white, 4.98:1 | primary actions (create, assign, save, send); work in progress (assigned, in progress, in review) |
| `danger` (red) | `#c2414c` | white, 5.05:1 | close, cancel, delete, deny; cancelled |
| `warning` (yellow) | `#dca71c` | dark, 7.21:1 | stalled, needs input (asks), undelivered messages, start errors |
| `success` (green) | `#2c8152` | white, 4.81:1 | mark done, approve; done |

Drafts and ready tasks are gray: no work has started. `src/ui/theme.test.ts` checks every filled label and light badge against WCAG AA (4.5:1), and that components name only these roles and the grays.

```bash
npm run dev    # the page and the API in workerd; without NEST_CLIENT_TOKEN the API answers, but nothing reaches nest
npm test       # two vitest projects: `worker` (workerd) and `ui` (jsdom, Testing Library)
```

## Setup (the operator's)

1. Create the client: `POST /v1/admin/clients {name: "projects", grant}`, and store its token as the Worker's secret `NEST_CLIENT_TOKEN`.
2. Deploy the Worker to `projects-nest.bitcru.sh`, then `POST /api/admin/sync` to write the catalog. Put Cloudflare Access in front of it for the owner's login (the `edge` inframe stack), with `/hooks/*` and `/mcp/*` bypassed: they are authenticated by signature and by identity instead.
3. `PUT /v1/clients/self/webhook {url: https://projects-nest.bitcru.sh/hooks/nest}` (the app does this at its first start), and store the secret as `NEST_WEBHOOK_SECRET`.
4. Point the GitHub App's webhook at `https://projects-nest.bitcru.sh/hooks/github`, with a new secret, stored as `GITHUB_WEBHOOK_SECRET`. Subscribe the App to `pull_request` and `check_run` events.

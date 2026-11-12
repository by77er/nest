# Audit notes (scratch; becomes the PR body, deleted before the PR)

Base: origin/main 6bbf64f.

## Corrections
| Section | Said | Code says | Evidence |
|---|---|---|---|
| Pieces | MCP server at `/mcp/<role>` | the path segment is the server's name (board, task, review, routine), not the role | projects/src/tools.ts:8, projects/src/mcp.ts:31 |
| The MCP server | a worker reads its task, posts progress, blocks/clears, reports its PR | the task server also has `request_secret`, `memory_list`, `memory_get` | projects/src/tools.ts:145,153 |
| Retention | ReviewDO keeps an ended job whose check update is still owed | it also keeps one whose waiting-for-room error's clearing is still owed (`room_told_ms IS NULL` in the prune) | projects/src/do/review.ts:788-791 |
| Setup, step 4 | the app sets its nest webhook at its first start | nothing in projects/src calls `PUT /v1/clients/self/webhook`; only /hooks/nest verifies with NEST_WEBHOOK_SECRET | `grep -rn self/webhook projects/src` (no hit); projects/src/worker.ts:45-47 |
| Dependencies | valid: "never on a task that's over" | the refusal is for a dependent task that's over (`a done task waits on nothing`); a done or cancelled blocker is accepted | projects/src/tasks.ts:181 |
| Dependencies | "Waiting on N" badge is gray, outline | gray, `variant="light"` | projects/src/ui/features/board/WaitingBadge.tsx:36 |
| Models | shared templates "which now carry the defaults" (tombstone wording) | they carry the defaults | projects/src/catalog.ts:172-173 |
| Creating a project | a create is removed after 8 attempts or an unreadable body | also at once on a permanent failure | projects/src/do/directory.ts:141,196-205 |
| Pieces | labels: `project`, `role`, worker `task`, reviewer `pr`/`sha` | also a routine run's `run` and (not dreaming) `routine`, and every start's `start` | projects/src/do/project.ts:3131,3198,4072,4124; do/review.ts:886 |
| How it uses nest | templates `projects/{manager,worker,reviewer,routine}` | the sync also writes `projects/dreaming` | projects/src/catalog.ts:180 |
| The repo's own guidance | "This replaces the runner reading the repo's CLAUDE.md" (change narrative) | the runner reads none of a repo's instructions | docs/agents/runner/README.md:29 |
| Status (line 5) | Not built: starting a new manager once one ends | built: an ended manager is replaced with backoff, up to 3 an hour, then waits for the owner's Restart (as "The manager lifecycle" says) | projects/src/manager.ts:63-101; do/project.ts:3899 |
| The task machine | B2/B3 told as change history ("looked only at", "Now it's refused", "now stalls") | present tense; same rules | projects/src/tasks.ts:118-131 |
| Outboxes | "Stops used to retry everything forever. ReviewDO's queues used to …" (tombstone) | dropped; the table states the current policies | projects/src/outbox.ts:95-113 |
| Outboxes | one-off cleanup "which deleting a draft left before the task machine. Nothing updates them now" | the migration drops orphaned PR rows | projects/src/do/project.ts:516 |
| The manager lifecycle | "a manager that ended used to stay the project's manager" (tombstone) | stated as the rule | projects/src/manager.ts:85-101 |
| Creating a project; Built: the review pipeline; The UI (task drawer) | change-history sentences ("used to be four awaited steps", "Before this, such a job failed…", "it was a third before…") | stated as current rules only | AGENTS.md Docs rules (no tombstones) |
| Built: the core (Retries) | a worker refused for good is "a 4xx" | a 4xx that isn't retryable, 408 or 429 (`at_capacity`) | projects/src/nest.ts:27-30 |
| Blocked; Task changes; PRs | change wording ("as before", "may now be", "It replaces the asks banner", "the old column … is still") | stated as current behaviour | projects/src/tasks.ts:89; api.ts:420 |
| PR upkeep | a failed read backs off past a minute "from the sixth failure in a row" | from the fifth: `max(PR_READ_EVERY_MS, backoff(attempts))`, and backoff(5) = 80 s | projects/src/do/project.ts:1777-1778; nest.ts:332 |
| PR upkeep | change wording ("before this", "as before", "now that", "this change leaves those as they are") | stated as current | projects/src/do/project.ts:584-611 |

## Tools the README never names
- `/mcp/board`: `list_tasks`, `get_task`, `create_task`, `write_spec`, `update_task`, `cancel_task` (no README list is meant to be complete for the manager's tools; listed here, not added).
- `/mcp/task`: `report_progress` (described as "posts progress").

## Unconfirmed
- The repo's binding (~line 281): that GitHub redirects every call nest makes under a transferred repo's old name. Already marked unverified in the doc; nothing in the repo shows it either way.
- Models (~lines 242, 264): whether nest reads a live agent's template again, and how a wrong model id surfaces. Already marked unverified; not traced in control-plane.
- Setup steps 5-8 (lines ~837-840): the live GitHub App's subscriptions/permissions and the live client's grant (dated 2026-11-02/06) are cloud state; not checkable from the repo.

## Suspected code bugs
- `write_spec`'s description (projects/src/tools.ts:78) says "a draft or ready task's spec", but projects/src/tasks.ts:89 allows a spec on ready, assigned, in_progress and in_review, as the README says. Description understates behaviour.

## Drift outside the doc
- projects/wrangler.jsonc comment says the MCP servers are `/mcp/<board|task|review>` (omits `routine`); config, not changed.
- projects/src/mcp.ts:1 header comment lists /mcp/board, /mcp/task, /mcp/review but not /mcp/routine (code comment; not changed).

## Sections done
- PR comments: no drift (CLAIM_LAPSE_MS do/directory.ts:158; once an hour do/project.ts:1175-1176; REVISE_MAX 3/hour :4486-4488; COMMENTS_SEEN_KEEP_MS 30 d :4484; PR_COMMENT_MAX 4000 :4494; pr_inputs :441).
- PR upkeep: one number fixed, wording; the rest matches (FINDINGS_MAX pr-upkeep.ts:45, FAILING :21, PR_READ_BATCH pr-read.ts:47, PR_READ_EVERY_MS/GAP/RETELL/FLAP do/project.ts:606-611, pr_told :584, schedule columns :586-588, pr_read_failed once a day :1781, TRANSIENT_GRAPHQL github.ts:80).
- Blocked: no drift beyond wording (canBlock/canUnblock tasks.ts:234-245; answer api.ts:440; attention/needs_you api.ts:78-142,420).
- Task changes: no drift beyond wording (NOTIFY_WINDOW_MS 10 s do/project.ts:4337, CHANGE_CLIP 600 :4339, request id :1680, worker_not_notified :1673-1685, task_changes :383).
- PRs: no drift beyond wording (prsDone tasks.ts:222; pr_facts do/project.ts:523; routes api.ts:424-432).
- The review gate: no drift (one wording trim, "as before the gate"); review-trust.ts:1-45 (MAX_HELD 50, MAX_OVERFLOW 500, HELD_CHECK_INTERVAL_MS 60 s), needs_approval do/review.ts:131, policy :246, title :1044, routes api.ts:354-356, requests.ts:34.
- Auto-merge: no drift (automerge.ts; merge_method default do/project.ts:354,664; retry api.ts:318; once-a-minute read do/project.ts:1617-1627; records :3820-3828; RATE_LIMITED github.ts:252-260; permissions github.ts:33-41).
- Built: the review pipeline: no drift beyond the tombstone above (ROOM_TELL_AFTER_MS do/review.ts:44, room_waits :160,556, "Waiting for room…" :1053, external_id :863-865, review key :887, MAX_RETRIES :34, review_waiting_for_room do/project.ts:2389, OUTPUT_MAX/TITLE_MAX github.ts:470-472, app_id -1 github.ts:369-381, JOB_STATES review-job.ts:34, REVIEW_DEADLINE_MS :60, SEEN_KEEP_MS do/directory.ts:39).
- Built: the core: one correction; client id nest.ts:97-102, keys do/project.ts:4075,4132 + nest.ts:162-165, backoff 5 s→5 min nest.ts:332, relayed brief do/project.ts:1680, call keys 24 h do/project.ts:320,3408, events 7 days do/directory.ts:39, no sessions mcp.ts:2, read_repos catalog.ts:123-137, deps test test/deps.test.ts:18 match.
- The task machine: table and invariants match tasks.ts:4-143 and test/machine.test.ts:120-131 (only the B2/B3 wording changed); deleteTask do/project.ts:877-900.
- Outboxes: table matches OUTBOX (outbox.ts:95-113), states/events outbox.ts:9-26, stopRefused nest.ts:350-356, routes api.ts:413-417, chat_request do/project.ts:510, SPINNER_AFTER_MS ui/features/chat/ChatView.tsx:210; two tombstones removed.
- The manager lifecycle: MANAGER_RESTARTS=3/hour manager.ts:63-64, restart route api.ts:348, "The previous manager" ui/features/attention/AskItem.tsx:32, 'manager replaced' stop do/project.ts:3899; one tombstone removed.
- Intro, What it does, Pieces, How it uses nest, The repo's own guidance, The MCP server, Flows: corrections above; the rest matches (grant permissions github.ts:25-47; overrides nest.ts:163; stop nest.ts:230-234; label listing nest.ts:207-208,334; github-token nest.ts:327; trace trace.ts:57, api.ts:118-119; grant repos grant-repos.ts, nest.ts:294-305, api.ts:122,158; CHECK_NAME github.ts:23; attach_error/attach_gen do/project.ts:345,542; REVIEW_DEADLINE_MS review-job.ts:60; MAX_RETRIES=2 do/review.ts:34; action_required do/review.ts:40; identity checks identity.ts:122-131; REPO_GUIDANCE/REVIEWER_GUIDANCE catalog.ts:50,58; default max_workers 2 do/project.ts:663).
- Network: no drift (presets network.ts:39-46, ports :24, OUTSIDE :54, clientLayerFor :152; PUT network 403/400 api.ts:454-475; frozen_egress/network_rev do/project.ts:412-415; sidebar order ui/features/shell/Sidebar.test.tsx:98; strings NetworkPage.tsx:123,178,298; sources :370-373; nest's /policy route control-plane/src/index.ts:836).
- Built-in tools: no drift (catalog.ts:19-38,106-107,130-134,178-182; control-plane/src/lib/grants.ts has no rules check).
- Models: one wording fix; settings/defaults/ids (models.ts:10-31, requests.ts:49-50), templates (models.ts:56-60, catalog.ts:126-151), sweep (do/project.ts:1945-2014, outbox.ts:103), switch (nest.ts:197-199, do/project.ts:598-603,3951-4043), nest's 5 failures (control-plane/src/do/agent.ts:85-90) match.
- The repo's binding: no drift (do/directory.ts:65-112,255-356; binding.ts:19-95; api.ts:58-115; ui/features/admin/BindingsSection.tsx).
- Creating a project: one correction; steps creation.ts:51-65, 503 api.ts:181, grace do/directory.ts:139 match.
- Not decided here: no drift (catalog.ts:175; tasks.ts:127-131).
- Waiting: no drift (waits.ts:15-18,36-39,70-84; RECENT_WAITS=10 do/project.ts:593,2440; ManagerWaits.tsx:21,102,106; ManagerContext.tsx:59-72; nest's client timer API is GET/DELETE only, control-plane/src/index.ts:1035-1036).
- Memory: no drift (memory.ts:8,10,12,28; source format do/project.ts:3359; routes api.ts:510-512; nest's memory tools fall to not_implemented, control-plane/src/do/agent.ts:3283; prompts catalog.ts:74,86).
- Dependencies: two corrections; the rest matches (tasks.ts:177-212, api.ts:434-438, do/project.ts:1035).
- Setup: one correction (step 4); workflows, paths, secrets names, Access bypass (deploy/lean/Projects/Test.lean:27-28), `POST /api/admin/sync` (api.ts:100), Sync catalog button (ui/features/admin/AdminPage.tsx:48) match.
- Retention: one correction. Agents that exit before they're named: no drift (early_exits in project.ts:545,3095,3170,4151; review.ts:144,635).
- MCP tools across the whole doc (names, servers, parameters, limits): all match except the above.

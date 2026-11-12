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

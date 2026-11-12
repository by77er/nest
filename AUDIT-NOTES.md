# Audit notes (scratch; becomes the PR body, deleted before the PR)

Base: origin/main 6bbf64f.

## Corrections
| Section | Said | Code says | Evidence |
|---|---|---|---|
| Pieces | MCP server at `/mcp/<role>` | the path segment is the server's name (board, task, review, routine), not the role | projects/src/tools.ts:8, projects/src/mcp.ts:31 |
| The MCP server | a worker reads its task, posts progress, blocks/clears, reports its PR | the task server also has `request_secret`, `memory_list`, `memory_get` | projects/src/tools.ts:145,153 |

## Tools the README never names
- `/mcp/board`: `list_tasks`, `get_task`, `create_task`, `write_spec`, `update_task`, `cancel_task` (no README list is meant to be complete for the manager's tools; listed here, not added).
- `/mcp/task`: `report_progress` (described as "posts progress").

## Unconfirmed

## Suspected code bugs
- `write_spec`'s description (projects/src/tools.ts:78) says "a draft or ready task's spec", but projects/src/tasks.ts:89 allows a spec on ready, assigned, in_progress and in_review, as the README says. Description understates behaviour.

## Drift outside the doc
- projects/src/mcp.ts:1 header comment lists /mcp/board, /mcp/task, /mcp/review but not /mcp/routine (code comment; not changed).

## Sections done
- MCP tools across the whole doc (names, servers, parameters, limits): all match except the above.

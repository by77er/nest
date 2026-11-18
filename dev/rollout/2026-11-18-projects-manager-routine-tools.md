# Projects: the manager's routine tools (2026-11-18)

Not a one-way deploy, and no ordering constraint.

- **What it adds:** the board tools `list_routines`, `create_routine`, `update_routine` and `delete_routine` on `/mcp/board`, each routine's `source` and `tainted`, and a tainted routine's run brief relayed (`from: "projects/board"`) ([projects/README.md#routines](../../projects/README.md#routines)). Stored: `routines.source` (nullable; null reads as `owner`), `routines.name_tainted` and `routines.prompt_tainted` (default 0), and `routine_runs.brief_tainted` (nullable; null reads as untainted), added by a migration the previous release skips. `POST …/routines {preset}` now refuses a preset the project has already (the page offered each once already).
- **After the Worker deploys:** the next catalog sync lists the four tools to the manager, and its next session's prompt names them.
- **What a rollback does:**
  - The previous release's catalog sync lists the board without the tools; a call to one is refused as an unknown tool.
  - It ignores the new columns: a routine a tainted manager wrote runs with its brief posted unrelayed (its text then reaches the run as the owner's), and the owner's saves don't clear the taint columns, which the next roll forward reads as they were left. Disable or delete such routines before rolling back if that matters.
  - It accepts a preset twice again.

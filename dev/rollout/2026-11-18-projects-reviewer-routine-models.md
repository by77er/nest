# Projects: the reviewers' and routine runs' models (2026-11-18)

Not a one-way deploy, and no ordering constraint.

- **What it adds:** the project settings `reviewer_model` and `routine_model` (null: Claude Code's default, the shared templates as before), and the project's own templates `projects/{reviewer,routine,dreaming}-<project>-<model>` ([projects/README.md#models](../../projects/README.md#models)). Stored: three nullable columns (`settings.reviewer_model`, `settings.routine_model`, `routine_runs.model`), added by a migration the previous release skips.
- **In the gap after the Worker deploys:** nothing changes until an owner sets one of the two models. The settings form sends them only when changed, so a save against the previous release still works unless it changes one.
- **What a rollback does:**
  - Reviews and routine runs start on the shared templates again (Claude Code's default model), whatever the settings say. A routine run keeps the shared name in `routine_runs.template`, so the previous release still starts a dreaming run without hands.
  - A start frozen on a model and retried by the previous release names the shared template under the same Idempotency-Key. If its first create reached nest, nest answers 409 `conflict` and that review job or routine run fails once (a new head or the next run starts afresh).
  - The previous release's sweep compares the new templates' rows with `worker_model`, so it deletes them from nest's catalog unless a live agent started from one: a running routine run's template may go while it runs. Whether nest reads a running agent's template again is unverified.

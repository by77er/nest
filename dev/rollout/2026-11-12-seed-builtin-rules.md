# The seed's built-in rules (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No table, column, route or wire field. Seed version 10 rewrites the stored `nest` capability's `rules` once, only where they are still exactly the first seed's (`[mcp__nest__* allow]`), adding an exact-name `allow` for `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `WebSearch`, `WebFetch` and `TodoWrite`; `kv.seed_version` becomes 10 in the same step.

- **What reaches agents:** agents spawned after the deploy get the rules. A running agent gets them only once nest reads capability rules live (PR #249); before that it keeps the rules it copied at spawn.
- **What a `wrangler rollback` does with what this release wrote:** the previous release reads the rewritten row as an ordinary capability with more rules, and sees `seed_version` 10, past its own, so it adds and removes nothing. The rules stay.
- **An operator's edit of `nest`** (any other rules) is left alone; giving it the built-in rules is then the operator's step.
- **No shim to drop.**

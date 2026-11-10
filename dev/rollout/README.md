# Rollout rules, one file per change

Each change that needs a rollout rule adds one file here. The standing rules and the pipeline are in [deploy.md](../deploy.md#rollout-rules).

- **Name:** `YYYY-MM-DD-<slug>.md`: the day the change was written and a few words for it. Sorted by name, the directory reads oldest first.
- **Why a file each:** every change used to append its rule at the same line of `deploy.md`, so any two open PRs conflicted there and each conflict cost a CI run. A new file conflicts with nothing. For the same reason there is no index to edit: list the directory.
- **What a rule says:**
  - whether the deploy is one-way, and any ordering constraint: what must already be true before the Worker deploys;
  - what runs in each gap (apply, then Worker, then release), with hosts one release behind;
  - what a `wrangler rollback` does with what this release wrote (new tables, columns, keys, deadlines, wire fields);
  - the release that drops any shim it adds.
- **A change with no ordering constraint** still gets a file when it adds stored state, a wire field, a route or a DO method: the rule is then "not a one-way deploy, and no ordering constraint", plus the rollback line.
- **Lifetime:** delete the file once nothing depends on it (no rollback reaches the release it describes). Cleanups that are still owed stay listed in `deploy.md`.
- **The PR body** names the file.

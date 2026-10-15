# Repo maintenance (pattern)

Agents maintaining a code repository: they pick up work, change code, review each other's changes, merge through the repo's own gates, and watch what ships. nest's first use is maintaining itself; the repo settings, CI, deploys and metrics it relies on are in [operations/](../../operations/). Like every pattern, this is templates and prompts; no code knows about it.

## Agents

| Agent | Template | Lifetime | Capabilities |
|---|---|---|---|
| **Maintainer** | `maintainer` (a [captain](../captains/) plus GitHub) | Long-lived, no hands | channels, messaging{tree}, spawning{budget}, sandboxes, authority, memory, schedules, hooks, `github_ro`, brokered{`github.create_issue`, `github.comment`} |
| **Worker** | `worker` | One task, until its PR merges or closes | hands on a fork of the repo sandbox (egress binding `github:dev`), messaging{tree}, `github_ro`, brokered{`github.create_pr`}. **No `web`.** |
| **Reviewer** | `reviewer` | One PR head, fresh session | hands on a fork at the PR head, `github_ro`, brokered{`github.review_check`, `github.review_comment`} |
| **Monitor** | `monitor` | Long-lived, no hands | `metrics`, channels, messaging{tree}, memory, schedules, `github_ro`, brokered{`github.dispatch_workflow{rollback.yml}`, `github.create_issue`} |

I spawn the maintainer and the monitor; the maintainer spawns workers and reviewers. GitHub tokens come from the [bindings](../../operations/github/#tokens): workers `github:dev`, reviewers `github:review`, the maintainer and monitor `github:ops`.

## Channels

- **`repo/<name>/github`:** the App's webhook [hook](../../channels/sources/) posts every event here as `github.<event>`, keyed by branch (`ref/<branch>`) when the event has one.
- **The maintainer** subscribes to it, batched, for issues, PR opens, updates and closes, and `deployment_status`.
- **Each worker** subscribes to its own branch's events (`keys: [ref/<branch>]`), so it sleeps at no cost while CI runs.
- **The monitor** subscribes to `deployment_status` and schedules its own checks with `wake_at`.

## The loop

1. **Work arrives:** an issue I label `agent`, a monitor finding, a failure on `main`, or the maintainer's own scheduled sweep.
2. **The maintainer** writes a task (goal, constraints, and done = PR open, CI green, review passed) and spawns a worker on a fresh fork of the `repo` sandbox: a clone with the toolchains and a warm build cache, which the maintainer keeps current.
3. **The worker** changes code, runs the repo's checks in its sandbox, pushes a branch and calls `github.create_pr{auto_merge: true}`. Then it waits on its branch's events:
   - CI failed: it fixes and pushes;
   - the review failed: it addresses each point, or answers it in a comment;
   - merged or closed: it reports and exits.
4. **On each new PR head,** the maintainer spawns a reviewer for it and stops any reviewer of an older head.
5. **The reviewer** starts clean, with a fork at the head, the issue and the diff, never the worker's transcript. It runs the checks itself, reviews against `CLAUDE.md` and the docs' rules, and posts `nest/review` (pass, or fail with reasons) plus line comments.
6. **GitHub merges** once the required checks pass, plus my review for `CODEOWNERS` paths. `deploy.yml` ships it.
7. **The monitor** wakes on each `deployment_status` and on its own schedule. It queries metrics and reports regressions to the maintainer, or dispatches `rollback.yml` for a clear one the health window missed. The maintainer turns findings into tasks.

## Conventions (in prompts)

- The [captain conventions](../captains/#conventions-in-its-prompt) apply: one worker per task, one writer per sandbox, parallel workers only on independent areas, and every spawn prompt says when the work is done.
- **The reviewer is never the author.** It's a separate agent with a clean context, because agents grade their own work too kindly.
- **Small PRs:** one concern each, so a review and a revert are both cheap.
- **What goes to me** (`user`): dependency additions, one-way deploys (Durable Object class changes), a task that fails review three times, and anything ambiguous about intent. `CODEOWNERS` review requests reach me through GitHub itself.
- **The maintainer remembers** open tasks, recurring failures and what I've decided, in memory, so a fresh session loses nothing.

## Why auto-merge is safe enough

CI and the reviewer catch mistakes; they're no defense against a worker that's been prompt-injected, since an injected diff can try to persuade its reviewer too. Auto-merge is safe because nothing from outside reaches this repo's workers:

- **The repo is private,** so issues and comments come from me and the agents.
- **Workers have no `web`,** and the repo sandbox's egress allows only GitHub (through the binding) and the package registries the build uses.
- **New dependencies need me** (manifests and lockfiles are `CODEOWNERS` paths), so workers read only code already in the build.

If any of these changes for a repo (it goes public, workers get `web`), its PRs should wait for me until taint records its source (see [open questions](../../operations/#open-questions)).

## The `reviewer` template

```yaml
launch: {system_prompt: {mode: append, text: <reviewer prompt>}}
hands: {sandbox: <fork at the PR head>}
capabilities:
  - github_ro
  - brokered{actions: [github.review_check, github.review_comment]}   # github:review; scoped to the PR it was spawned for
report_schema: {pr: number, head: sha, verdict: [pass, fail], findings: number}
budget: {depth: 0, concurrent: 1, spawns: 0, turns_per_day: 20}
```

The `maintainer` template is the [`captain`](../captains/#the-captain-template) template plus `github_ro` and its brokered actions. Workers use the `worker` template without `web`. The `monitor` template adds `metrics`.

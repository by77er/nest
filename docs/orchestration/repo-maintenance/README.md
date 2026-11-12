# Repo maintenance (pattern)

Agents maintaining a code repository: they pick up work, change code, review each other's changes, merge through the repo's own gates, and watch what ships. Like every pattern, this is templates and prompts; no code knows about it.

**Status:** designed. None of its templates (`maintainer`, `reviewer`, `monitor`) or capabilities (`coordination`, `authority`, `schedules`, `github_ro`, `metrics`, `web`) is seeded, and `github.review_check`, `github.dispatch_workflow`, `github.create_pr`'s `auto_merge`, sandbox forks and `report_schema` aren't built. **Built as a variant:** the [projects](../../../projects/README.md) app's manager, worker per task, and reviewer per PR head, which sets a required check with the app's own GitHub token; with the project's auto-merge on, the app enables GitHub's auto-merge on each task PR.

## Agents

| Agent | Template | Lifetime | Capabilities |
|---|---|---|---|
| **Maintainer** | `maintainer` (a [captain](../captains/) plus GitHub) | Long-lived, no hands | coordination, spawning{budget}, sandboxes, authority, memory, schedules, `github_ro`, brokered{`github.create_issue`, `github.comment`} |
| **Worker** | `worker` | One task, until its PR merges or closes | hands on a fork of the repo sandbox, with a GitHub binding injected; coordination, `github_ro`, brokered{`github.create_pr`}. **No `web`.** |
| **Reviewer** | `reviewer` | One PR head, fresh session | hands on a fork at the PR head, `github_ro`, brokered{`github.review_check`, `github.review_comment`} |
| **Monitor** | `monitor` | Long-lived, no hands | what it watches (e.g. `metrics`, or the deployed app's metrics API as an `api` capability), coordination, memory, schedules, `github_ro`, brokered{`github.dispatch_workflow{<rollback>}`, `github.create_issue`} |

I spawn the maintainer and the monitor; the maintainer spawns workers and reviewers. GitHub access is a GitHub App whose tokens [BrokerDO](../../control-plane/durable-objects/broker/) narrows per binding: workers can push and open PRs, only reviewers can post the review check, and only the maintainer and monitor can file issues and dispatch workflows.

## GitHub events

The App's webhooks reach agents through the coordination integration ([principle 9](../../README.md#principles)), which delivers each event, tainted, to the inboxes that asked for it:
- **The maintainer:** issues, PR opens, updates and closes, and `deployment_status`, batched.
- **Each worker:** its own branch's events only, so it sleeps at no cost while CI runs.
- **The monitor:** `deployment_status`; it schedules its own checks with a [timer](../../agents/capabilities/timers/).

## The loop

1. **Work arrives:** an issue I label `agent`, a monitor finding, a failure on the default branch, or the maintainer's own scheduled sweep.
2. **The maintainer** writes a task (goal, constraints, and done = PR open, CI green, review passed) and spawns a worker on a fresh fork of the `repo` sandbox: a clone with the toolchains and a warm build cache, which the maintainer keeps current.
3. **The worker** changes code, runs the repo's checks in its sandbox, pushes a branch and calls `github.create_pr{auto_merge: true}`. Then it waits on its branch's events:
   - CI failed: it fixes and pushes;
   - the review failed: it addresses each point, or answers it in a comment;
   - merged or closed: it reports and exits.
4. **On each new PR head,** the maintainer spawns a reviewer for it and stops any reviewer of an older head.
5. **The reviewer** starts clean, with a fork at the head, the issue and the diff, never the worker's transcript. It runs the checks itself, reviews against the repo's own instructions (e.g. `AGENTS.md` or `CLAUDE.md`, which it reads itself through hands: nest loads none), and posts its review check (pass, or fail with reasons) plus line comments.
6. **GitHub merges** once the required checks pass, plus an owner's review for `CODEOWNERS` paths. The repo's own CD ships it.
7. **The monitor** wakes on each `deployment_status` and on its own schedule. It reports regressions to the maintainer, or dispatches the repo's rollback workflow for a clear one. The maintainer turns findings into tasks.

## The repo's gates

Agents change the code, so the checks on their changes must be the repo's, enforced by GitHub, not by nest or by the agents:
- **Branch protection** requires the CI checks and the reviewer's check, **pinned to the App as its source** so nothing else can post a passing one.
- **`CODEOWNERS`** sends the paths that need a human (the gates themselves, dependencies, security-sensitive code) to me.
- **Deploy credentials** stay in the CI system, usable only from the default branch. Agents can dispatch a rollback, never hold the keys.

## Conventions (in prompts)

- The [captain conventions](../captains/#conventions-in-its-prompt) apply: one worker per task, one writer per sandbox, parallel workers only on independent areas, and every spawn prompt says when the work is done.
- **The reviewer is never the author.** It's a separate agent with a clean context, because agents grade their own work too kindly.
- **Small PRs:** one concern each, so a review and a revert are both cheap.
- **What goes to me:**
  - dependency additions;
  - changes that can't be rolled back;
  - a task that fails review three times;
  - anything ambiguous about intent.

  `CODEOWNERS` review requests reach me through GitHub itself.
- **The maintainer remembers** open tasks, recurring failures and what I've decided, in memory, so a fresh session loses nothing.

## Why auto-merge is safe enough

CI and the reviewer catch mistakes; they're no defense against a worker that's been prompt-injected, since an injected diff can try to persuade its reviewer too. Auto-merge is safe only while nothing from outside reaches the repo's workers:

- **The repo is private,** so issues and comments come from me and the agents.
- **Workers have no `web`,** and the repo sandbox's egress allows only GitHub (through the binding) and the package registries the build uses.
- **New dependencies need me** (manifests and lockfiles are `CODEOWNERS` paths), so workers read only code already in the build.

For a repo where any of these fails (it's public, or its workers need `web`), its PRs should wait for me. **Open question:** taint is one bit, and hands output sets it for every worker, so it can't separate a PR built from outside content. Recording a taint *source* (hands, web, hook) per session would let exactly those PRs wait for me.

## The `reviewer` template

```yaml
launch: {system_prompt: {mode: append, text: <reviewer prompt>}}
hands: {sandbox: <fork at the PR head>}
capabilities:
  - github_ro
  - brokered{actions: [github.review_check, github.review_comment]}   # scoped to the PR it was spawned for
report_schema: {pr: number, head: sha, verdict: [pass, fail], findings: number}
budget: {depth: 0, concurrent: 1, spawns: 0, turns_per_day: 20}
```

The `maintainer` template is the [`captain`](../captains/#the-captain-template) template plus `github_ro` and its brokered actions. Workers use a `worker` template without web access (the seeded `worker` launches with `WebSearch` and `WebFetch`).

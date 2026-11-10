---
name: nest-change-flow
description: Use at the start of any nest code or docs change, and again before you commit, open a PR, merge or report. The end-to-end workflow and which skill applies at each step: worktree and branch, implement with the subsystem skill, independent code review (and design review for frontend), fix rounds, PR, merge on green CI, watching main's CI and the deploy, and machine hygiene.
---

# From task to merged change

Your instructions win over this skill where they differ (for example "no PR"). Repo rules are in `AGENTS.md` and [dev/](../../../dev/README.md).

## 1. Start clean

- **Work in your own git worktree,** on a branch from fresh `origin/main` (`git fetch origin`, then `git checkout -b <topic>/<name> origin/main`).
- **The main checkout is shared with other live sessions.** Don't switch its branch, reset it, or use bare `git stash` (the stash stack is shared too); use a WIP commit.
- **Never push `main`, and never force-push.**
- **Read the docs that own the area first** (`docs/<subsystem>/`, lowest level).

## 2. Implement

- **One concern per change,** following the subsystem skill for each area touched (the table in `AGENTS.md`): `nest-control-plane`, `nest-host`, `nest-wire`, `nest-infra`, `nest-verification`; `nest-ui-design` for any web UI.
- **Every behaviour change gets an owning test that fails without it** (`nest-tests`); mutation-check the important fixes.
- **Run what your files touch and read exit codes, not counts** (`nest-validation`). For a frontend change, also run `scripts/ui-review/` yourself before asking for review.

## 3. Independent review, before the PR

- **Code review:** a reviewer with a fresh context, given the goal, the diff (`git diff origin/main...`) and `nest-review`, never your conclusions or transcript. Ask it to find what's wrong: interleavings, rollback, old peers, vacuous tests, docs drift.
- **Design review,** for a frontend change: another fresh reviewer following `nest-design-review`. It must PASS before merge.
- **Fix every finding, or answer it with evidence.** After a high-severity finding or a FAIL, review again from a fresh context until none remain.

## 4. PR and merge

- **Commit:** what and why, ending with the attribution lines your instructions give.
- **Push** with `git push -u origin <branch>`, then report the pushed head from `git ls-remote origin refs/heads/<branch>`, not your local idea of it.
- **Open the PR** with `gh pr create`. The body says what changed and why; the tests added and what was mutated; the evidence tier of each claim; any skipped test; any `CODEOWNERS` paths touched; the design review's verdict, for frontend; the rollout rule's file, if any (`dev/rollout/YYYY-MM-DD-<slug>.md`, one new file per change; never edit `dev/deploy.md` for it, where every open PR would conflict).
- **Wait for CI:** `gh pr checks <n> --watch --required` (`ci-ok` aggregates every job). A red job gets a root cause, not a rerun-until-green; a flaky test is fixed as `nest-tests` says.
- **Self-merge on green:** the owner's standing instruction (2026-10-23), unless your task says otherwise. Use `gh pr merge <n> --squash --auto --delete-branch`; it merges PRs touching `CODEOWNERS` paths too.
  - Never use `--admin` or bypass branch protection in any other way.
  - If a required review blocks auto-merge, stop and tell the owner.
  - `inframe apply`, secrets and the owner's own cloud resources stay the owner's.

## 5. After the merge

- **Watch main's CI:** `gh run list --workflow ci.yml --branch main --limit 3`, then `gh run watch <id> --exit-status`.
- **Watch the deploy:** `gh run list --workflow deploy.yml --branch main --limit 3`. A `skipped` run means its CI run wasn't a push to `main`, or main's CI failed: check which. Read the infra plan summary, and check that the smoke step didn't roll back.
- **If your merge turned main red, it is yours:** fix forward, or revert with a PR.
- **Check the cloud when only the cloud can show it** (hosts, the tunnel, Access, placement): `nest-infra`. Clean up whatever a check creates.

## Machine hygiene

- **One heavy job at a time** (a workspace build, `npm test`, e2e, TLC, Kani, mutants, fuzzing), at about 4 GB RSS and 4 cores: `cargo -j 4`, `TLC_WORKERS=4`.
- **Cargo targets, TLC metadirs and scratch files go under `/var/tmp`** (`CARGO_TARGET_DIR=/var/tmp/<you>-target`); `/tmp` is a small tmpfs that a reboot wipes.
- **Never print a credential.** Don't touch the live cell, Cloudflare or AWS beyond read-only and cloud-check steps.
- **Remove what you created** when you finish: probe files, unneeded target directories, `node_modules` you installed, and worktrees.

## Report

- The branch and the exact pushed head (`git ls-remote`), and the PR and merge commit if any.
- Each item: done, skipped (why), or partly.
- The checks run with their results, the tests added and the mutations run.
- What remains for the owner.

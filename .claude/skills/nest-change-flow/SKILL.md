---
name: nest-change-flow
description: Use at the start of any nest code or docs change, and again before you commit, open a PR, merge or report. The end-to-end workflow: worktree and branch, implement with the subsystem skill, independent adversarial review, fix rounds, PR, merge on green CI, watching main's CI and the deploy, handling flaky tests, cloud checks and machine hygiene.
---

# From task to merged change

Subsystem skills: `nest-control-plane`, `nest-host`, `nest-wire`, `nest-infra`, `nest-verification`. Cross-cutting: `nest-tests`, `nest-validation`, `nest-review`, `nest-ui-design` (any web UI). Repo rules: `CLAUDE.md` and [dev/](../../../dev/README.md).

## 1. Start clean

- **Work in your own git worktree,** on a branch from fresh `origin/main` (`git fetch origin`, then `git checkout -b <topic>/<name> origin/main`).
- **The main checkout is shared with other live sessions.** Don't switch its branch, reset it, or use bare `git stash`: the stash stack is shared too, so use a WIP commit instead.
- **Never push `main`, and never force-push.**
- **Read the docs that own the area first** (`docs/<subsystem>/`, lowest level). Your instructions win over this skill where they differ (for example "no PR").

## 2. Implement

- **One concern per change.** Follow the subsystem skill. Record each decision in the lowest doc that owns it, and update the summaries above it.
- **Every behaviour change gets an owning test that fails without it.** Mutation-check the important fixes (`nest-tests`).
- **Run what your files touch** (`nest-validation`), and read exit codes, not counts.

## 3. Adversarial review, before the PR

- **Use an independent reviewer with a fresh context:** give it the goal, the diff (`git diff origin/main...`) and the `nest-review` skill, not your conclusions or transcript. Ask it to find what's wrong: interleavings, rollback, old peers, vacuous tests, docs drift.
- **Fix every finding, or answer it with evidence.** After a high-severity finding, review again from a fresh context until none remain.

## 4. PR and merge

- **Commit:** say what and why. End with the attribution lines your instructions give.
- **Push:** `git push -u origin <branch>`. Then report the exact pushed head with `git ls-remote origin refs/heads/<branch>`, not your local idea of it.
- **Open the PR** with `gh pr create`. The body says:
  - what changed and why;
  - the tests added and what was mutated;
  - the evidence tier of each claim;
  - any skipped test;
  - any `CODEOWNERS` paths touched;
  - the rollout rule, if any.
- **Wait for CI:** `gh pr checks <n> --watch --required`. `ci-ok` aggregates every job. A red job gets a root cause, not a rerun-until-green.
- **Self-merge on green:** the owner's standing instruction (2026-10-23) is that you merge your own PR once CI is green, unless your task says otherwise. Use auto-merge: `gh pr merge <n> --squash --auto --delete-branch`. It has merged PRs touching `CODEOWNERS` paths too.
  - Never use `--admin`, and never bypass branch protection in any other way.
  - If auto-merge is blocked by a required review, stop and tell the owner.
  - `inframe apply`, secrets and the owner's own cloud resources stay the owner's.

## 5. After the merge

- **Watch main's CI:** `gh run list --workflow ci.yml --branch main --limit 3`, then `gh run watch <id> --exit-status`.
- **Watch the deploy:** `gh run list --workflow deploy.yml --branch main --limit 3`. A `skipped` deploy run means its CI run wasn't a push to `main`, or main's CI failed: check which. Read the infra plan summary in the run, and check that the smoke step didn't roll back.
- **If your merge turned main red, it is yours.** Fix forward, or revert it with a PR.
- **Check the cloud when only the cloud can show it** (hosts, the tunnel, Access, placement): the `nest-infra` skill and [dev/cloud-checks/](../../../dev/cloud-checks/README.md). Clean up whatever a check creates.

## Flaky tests

A test that fails under load and passes alone is a bug, usually in the test:
- an assertion on an intermediate state;
- a wait sized for an idle machine;
- a wait that doesn't cover a retry backoff;
- a shared port or global.

Reproduce it in a loop while the machine is busy, find the cause, and fix the assertion or the budget, naming the timer it covers. Raising a timeout without a cause is not a fix, and neither is a retry. Say in the PR what the cause was and how you reproduced it.

## Machine hygiene

- **Run one heavy job at a time** (a workspace build, `npm test`, e2e, TLC, Kani, mutants, fuzzing), at about 4 GB RSS and 4 cores at most: `cargo -j 4`, `TLC_WORKERS=4`.
- **Keep Cargo targets, TLC metadirs and scratch files under `/var/tmp`** (`CARGO_TARGET_DIR=/var/tmp/<you>-target`). `/tmp` is a small tmpfs that a reboot wipes.
- **e2e needs a short work path:** `NEST_E2E_WORK=/var/tmp/nest-e2e-<tag>`. Unix-socket paths are limited to 108 bytes, and the directory is deleted at each start.
- **Never print a credential.** Don't touch the live cell, Cloudflare or AWS beyond the read-only and cloud-check steps above.
- **Remove what you created** when you finish: probe files, target directories you no longer need, and worktrees.

## Report

- **The branch and the exact pushed head** (`git ls-remote`), and the PR and merge commit if any.
- **Each item:** done, skipped (why), or partly.
- **The checks run, with their results;** the tests added and the mutations run.
- **What remains for the owner.**

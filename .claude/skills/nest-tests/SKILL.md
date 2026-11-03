---
name: nest-tests
description: Use when writing or changing tests in nest (Rust, the TypeScript control plane and apps, Python e2e and repo guards), or when a test is flaky. Rules for tests that catch regressions rather than restate code, and for fixing flakes at their cause.
---

# Writing nest tests

- **Test at the lowest layer that owns the behaviour,** against an independent oracle: a fixture in `protocol/fixtures/`, an observed sample, or a spec, never the code under test.
- **Every test needs a reachable regression:** name the change that would make it fail. If none exists, don't write it.
- **No change-detector tests** that assert implementation details a refactor would legitimately change.
- **A test's name is a claim** its body must be able to falsify.
- **Sweep an enum in one table-driven test,** with an exhaustive `match` in Rust, so a new variant fails to compile until it's covered.
- **When review changes a fix, revise the existing test's inputs** rather than adding another test.
- **Tests must not pass by not running:** privileged tests skip locally with a `NEST-TEST-SKIP:` line and fail in CI; re-executed tests acknowledge they ran (`nestd::net::reexec_in_userns`).
- **Waits use wall-clock budgets,** never iteration counts sized for an idle machine. Outlast the timer the wait covers, with margin, and name that timer; a wait across a retry backoff includes the backoff.
- **Retries:** cover the path that fails twice, not only the one that fails once.
- **Tests run in parallel:** no shared globals, no fixed ports (bind `:0`), no `std::env::set_var` or `remove_var` (clippy denies them; set the environment on the child `Command`).
- **A new guard** (a fence, a lint, a check script) ships with a test that plants a violation and expects failure (`scripts/tests/test_guards.py`).
- **Fewer tests that can fail beat many that can't.** Tests are not evidence of effort.
- **Per-area patterns:** Durable Objects (RPC rejections, real alarms, migrations on the old shape) in `nest-control-plane`; pure-core checks in `nest-host`.

## Flaky tests

A test that fails under load and passes alone is a bug, usually in the test: an assertion on an intermediate state, a wait sized for an idle machine or not covering a retry backoff, a shared port or global.
- Reproduce it in a loop while the machine is busy, find the cause, and fix the assertion or the budget, naming the timer it covers.
- Raising a timeout without a cause is not a fix, and neither is a retry.
- Say in the PR what the cause was and how you reproduced it.

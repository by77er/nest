---
name: nest-tests
description: Use when writing or changing tests in nest (Rust, the TypeScript control plane, Python e2e and repo guards). Rules for tests that catch regressions rather than restate code.
---

# Writing nest tests

- **Test at the lowest layer that owns the behaviour,** against an independent oracle: a fixture in `protocol/fixtures/`, an observed sample, or a spec, never the code under test.
- **Every test needs a reachable regression:** name the change that would make it fail. If none exists, don't write it.
- **No change-detector tests** that assert implementation details a refactor would legitimately change.
- **A test's name is a claim** its body must be able to falsify.
- **Sweep an enum in one table-driven test,** with an exhaustive `match` in Rust, so a new variant fails to compile until it's covered.
- **When review changes a fix, revise the existing test's inputs** rather than adding another test.
- **Tests must not pass by not running:**
  - privileged tests skip locally with a `NEST-TEST-SKIP:` line and fail in CI;
  - re-executed tests acknowledge they ran (see `nestd::net::reexec_in_userns`).
- **Timers:** a test that waits must outlast the timer it depends on, with margin, and say which timer.
- **Retries:** cover the path that fails twice, not only the one that fails once.
- **No `std::env::set_var` or `remove_var`** (clippy denies them); set the environment on the child `Command`.
- **A new guard** (a fence, a lint, a check script) ships with a test that plants a violation and expects failure (`scripts/tests/test_guards.py`).
- **Tests are not evidence of effort.** Fewer tests that can fail beat many that can't.
- **Per-area patterns:**
  - Durable Objects (wrapping RPC rejections, real alarms, migrations on the old shape): the `nest-control-plane` skill;
  - wall-clock waits, parallel-safe Rust tests and pure-core checks: the `nest-host` skill.

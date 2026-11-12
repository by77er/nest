# Verification in CI: the pilots (proposal)

How the study's formal models in [`verification/`](../verification/README.md) (TLA+, Lean and the command-delivery Stateright pilot) would run on every pull request. Why they exist and what they found: [docs/verification/](../docs/verification/README.md). nestd's checks over its real cores are already wired; they are in [ci.md](ci.md#verification). Nothing here is wired yet: adding a job changes `.github/`, which needs my review.

## The job

A `verification` job in `ci.yml`, added to `ci-ok`'s `needs`:

| Step | Runs | Needs | Time (estimate) |
|---|---|---|---|
| TLC | `verification/run.sh --only tla`: every config marked `ci` in `verification/tla/*/expect.tsv`, each asserting its expected outcome (`holds`, or a violation of a named property) | Java 21 (`actions/setup-java`, pinned by commit). `run.sh` fetches the TLA+ tools v1.7.4 and checks their SHA-256 | Measured on 2026-10-26 with 6 workers on a shared 20-core machine: the sandbox-lease tier (13 configs) took 8 min and the agent-brain tier (20 configs) about 20 min. `sandbox-lease` now has 48 `ci` configs and `agent-brain` 28 (unmeasured). Each config finishes in under 3 min on 8 workers. On a standard runner, expect more than 30 min (estimate): see below |
| Lean | `verification/run.sh --only lean`: `lake build` in `verification/lean`, refusing `sorry`, `admit` and `native_decide` | elan with the project's pinned `lean-toolchain` (v4.33.1, the same as `deploy/lean`), restored from the `infra` job's cache key | Seconds after the toolchain |
| Stateright | `verification/run.sh --only stateright`: `cargo test --release --locked` in `verification/stateright` | The pinned Rust toolchain; its own `target/` cache keyed by `verification/stateright/Cargo.lock` | 30 s on an idle machine, 5 min on one shared with TLC runs, plus the build |

- **Expected violations are asserted too.** A bug configuration that stops failing is red, because the model, or the fix it records, changed silently. When a fix lands in the code, the configuration that models main's old behaviour is either deleted or relabelled as the history of that bug.
- **Configs marked `full` don't run on PRs:**
  - they run with `run.sh --all`, by hand or from a nightly `schedule:` workflow;
  - their state queues can reach gigabytes, so the nightly run needs a larger disk or `-Xmx` cap (`TLC_JAVA_OPTS`).
- **Keeping the PR job short.** Before wiring, split `ci` into two tiers:
  - a PR tier: the bug reproductions (most finish in seconds) plus one small exhaustive `holds` run per spec, run only when `verification/` or a file cited by a spec's action table changes;
  - the rest of today's `ci` lines: nightly.
  Alternatively, use a larger runner.
- **No secrets, no network beyond the TLA+ download and crates.io,** as in the other jobs.

## Keeping models honest

- **A model is a hand translation** (nestd's checks aren't: they run the real cores). Each spec's header and its pilot doc map actions to file:line. A PR that changes a modelled handler updates the spec or that table in the same PR.
- **Proposed guard** (`scripts/`): for each spec, a list of the source files its action table cites. A diff that touches one of them must also touch the spec, its conformance doc, or a `verification-reviewed:` line in the PR body. This is not built.
- **The reviewer skill** ([.claude/skills/](../.claude/skills/)) would add one check: for a PR touching a modelled handler, re-run the conformance table for the changed actions.
- **Evidence tiers** ([practices.md](practices.md)):
  - "the model holds" is evidence about the design within its bounds, not about the code;
  - a claim about the code needs the conformance check or a test against the real DO.

## Cost

- One more job on PRs that touch modelled code, kept to about 10 minutes by the PR tier ([cost](ci.md#cost)).
- The nightly `full` tier would take about 1–2 h of runner time at current bounds (estimate). Run it weekly if minutes are short.

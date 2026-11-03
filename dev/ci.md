# CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. Branch protection requires one check, `ci-ok`, so adding a job never needs a settings change (see [github.md](github.md)). Every job but `plan` and `ci-ok` runs only when the change touches its inputs ([what runs](#what-runs)).

| Job | Runs | Needs |
|---|---|---|
| `plan` | The repo checks every change gets, then which jobs below the change needs. Guards: doc links (`scripts/check-doc-links.py`), source fences (`scripts/check-fences.py`), nestd-core's manifest (`scripts/check-core-manifest.py`: no dependency, no build script), every workflow parses as YAML (`scripts/check-workflows.py`: GitHub never runs an unparseable one and nothing else fails), and the guards' own tests (`scripts/tests/`). Secrets: gitleaks over the full history (`.gitleaks.toml`: default rules plus nest's token formats) | Python 3.11+; PyYAML pinned by hash (`scripts/requirements-guards.txt`) in a venv; gitleaks built from source (verified by Go's checksum database) and cached by version |
| `rust` | `cargo clippy --workspace --all-targets -- -D warnings`, `cargo build -p nestd-core --target x86_64-unknown-none` (the core without `std`), `cargo test --workspace`, then `cargo deny check` (`deny.toml`: RustSec advisories, licenses, wildcards, unknown sources) for the workspace and the standalone verification crates' lockfiles | cargo-deny, built from crates.io and cached; iproute2, nftables and unprivileged user namespaces for nestd's netns tests |
| `control-plane` | `npm ci`, `npm run typecheck`, `npm test` (vitest in workerd) | Node 22 |
| `dashboard`, `projects` | Each app's `npm ci`, `npm run typecheck`, `npm test` and `npm run build` (the projects app's tests run in workerd, against a fake nest) | Node 22 |
| `e2e` | The `claude-verify` harness tests (with a stub, never the real binary), then `e2e/run.sh` with the fake brain | The above, plus outbound access to `registry.npmjs.org` and `httpbin.org`; logs are uploaded on failure |
| `infra` | `inframe test` for nest's stacks (`use1`: the cell stack's IAM theorems and graph policies; `edge`) and for the projects app's own (`projects/deploy/`, `--stack projects`: Access only for the owner, bypass only on `/hooks` and `/mcp`), with no cloud credentials (plans run only in [deploy.yml](deploy.md) and `deploy-projects-infra.yml`) | elan and the inframe CLI (`scripts/infra-tools.sh`, pinned) |
| `verify-nestd` | The Stateright checks of nestd's real cores at CI bounds (`verification/nestd/check`, `cargo test --release`), then `cargo mutants -p nestd-core --in-place` (0 missed expected) | cargo-mutants, pinned and cached ([verification](#verification)) |
| `kani-nestd` | `cargo kani -p nestd-core`: the proofs of nestd-core's decision functions | kani-verifier, pinned and cached |
| `fuzz-nestd` | The fuzz seeds still decode, and every target in `verification/nestd/fuzz` replays the seeds and the cached corpus once (no timed fuzzing: `fuzz.yml` does that weekly) | the pinned nightly in that directory, cargo-fuzz |
| `ci-ok` | Fails unless `plan` passed and every other job passed if `plan` said the change needs it and was skipped if not. On a pull request it then uploads the artifact `ci-passed-<tree>` | — |

## What runs

- **By path:** `plan` lists the paths the change touches (a pull request: its merge commit against the base; a push: against the previous `main`) and `scripts/ci-changes.py` maps each to the jobs that read it, including the cross-directory reads (nestd's test of `fleet.ts`, the dashboard's import of the admin view, the fixtures in `protocol/`). A path no rule names runs every job, as does a change to `ci.yml` or the mapping; docs, `dev/`, skills and the other workflows run only `plan`. `scripts/tests/test_ci_changes.py` holds the cases. A dispatch runs everything.
- **A merge isn't tested twice:** the push of a squash merge whose tree is the tree the pull request's run passed (`main` didn't move in between) finds that run's `ci-passed-<tree>` artifact and runs no job again; `ci-ok` still reports, so the deploy still follows. If `main` moved, the push runs what its own diff needs. The artifact counts only if its run was `ci.yml` on the pull request this push merged (same head commit) and succeeded: a pull request runs its own copy of `ci.yml`, so another one's run could upload an artifact for any tree, and only the merged pull request's own run is trusted for its merge.
- **Fail fast:** every job waits for `plan`, so a failing guard or leaked secret costs no Rust build.

- **Pinned:** the Rust toolchain (`rust-toolchain.toml`), every action by commit, cargo-deny and gitleaks by version. A new stable Rust or a moved action tag can't break an unrelated PR; bumps are their own PRs.
- **Skips fail in CI:** `NEST_CI_REQUIRE_USERNS=1` turns a test's "no user namespaces, skipping" into a failure (see [practices.md](practices.md#tests)).
- **Runner setup:** `ubuntu-24.04` restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), which breaks `unshare --map-root-user` and bubblewrap. The jobs turn it off with `sysctl`, which is safe on a single-use runner VM ([Ubuntu 24.04 notes](https://documentation.ubuntu.com/release-notes/24.04/)).
- **No secrets:** CI runs with `permissions: contents: read`, checks out without persisted credentials, and holds no secrets, so a PR's code runs with nothing to leak.
- **Caches:** cargo registry and `target/` keyed by the toolchain and `Cargo.lock`; npm keyed by `package-lock.json`.
- **Changes to CI and its configs need my review** (`.github/`, `scripts/`, `rust-toolchain.toml`, `clippy.toml`, `deny.toml` and `.gitleaks.toml` are in `CODEOWNERS`), so agents can't weaken the checks that gate their own merges.

## Verification

nestd's cores are checked as shipped ([docs/verification/nestd/](../docs/verification/nestd/)). The checker and the fuzz crate are standalone (each has its own `[workspace]` and lockfile), so `cargo test --workspace` doesn't see them; `rust` runs cargo-deny over their lockfiles with the same `deny.toml`. The `rust` job builds `crates/nestd-core` for `x86_64-unknown-none` (no `std`, so the compiler enforces its purity); its manifest check and purity fence run in `plan`. No PR check fuzzes for a time. Two inputs still vary between runs: the fuzz replay reads the corpus the latest weekly run saved, and cargo-mutants times a mutant out after 60 s of wall clock.

| Check | On every PR | Longer |
|---|---|---|
| Model checks | the specs in `verification/nestd/check/tests/variants.rs`: about 10 s on 4 threads locally | by hand: `cargo test --release -- --include-ignored` adds every fault at once; `cargo run --release -- <spec>` explores other bounds and prints shortest counterexamples |
| Mutation testing | `cargo mutants -p nestd-core --in-place --timeout 60` (in place, so the cached `target/` is the one it builds in): 233 mutants, about 4 min at one job locally | — |
| Kani | every harness (kani-verifier 0.68.0): about 2 min locally, under 1.5 GB | — |
| Fuzzing | the seeds decode, and every target replays the seeds and the cached corpus once (`run.sh <target> replay`) | weekly (Sunday) in `fuzz.yml`: 10 min for the guest targets, 3 min for the rest; it saves the corpus the PR job replays |

- **Bumps:** stateright is pinned exactly (`=0.31.0`), cargo-mutants, kani-verifier and cargo-fuzz by version, the fuzz nightly by date.
- **Open:** should the checker's every-fault run gate merges? It would take about a minute on CI hardware (unmeasured); today it runs only by hand with `--include-ignored`.
- **When a check fails:** a model check names the property and prints the shortest counterexample with `cargo run --release -- <spec>`; replay it as a step test in `crates/nestd-core/tests/`. A fuzz crash is uploaded as the `fuzz-artifacts` artifact; reproduce with `cargo fuzz run --fuzz-dir verification/nestd/fuzz <target> <file>`.

## Not in CI

| What | Why | Where it runs instead |
|---|---|---|
| Real Claude Code (`claude-verify`, `NEST_E2E_CLAUDE=real`) | Needs the subscription token and spends quota; the token never goes to GitHub | The cloud dev environment, by hand ([setup stage 1](../docs/setup/#stage-1-real-claude-code-no-cloud-no-kvm)) |
| Firecracker | Needs KVM with nested virtualization; whether GitHub's standard runners expose `/dev/kvm` is unverified | The [first spike](../docs/README.md#first-spike) on AWS |
| `cargo fmt --check` | The tree isn't rustfmt-formatted yet (about 1,300 hunks) | A first maintenance task: format in one PR, then add the check |

## Cost

The repo is private, so runs use the account's included Actions minutes, billed per job and rounded up to the minute. Measured over 2026-10-16..30 (about 2,800 minutes, before [what runs](#what-runs)): `rust` and `e2e` took about 5 minutes each per run and 41% of the total; the push to `main` after each merge repeated the pull request's run (37%); the one-minute jobs (`guards`, `deny`, `secrets`, `ci-ok`) cost about 4 minutes a run between them; the deploy's `release` build about 4 minutes a merge. Hence: path-gated jobs, no second run of a passed tree, the small checks in `plan`, and `release` building only when its inputs changed ([deploy.md](deploy.md)). Timed fuzzing is about 40 minutes a run, so it runs weekly. `concurrency` cancels superseded runs on a pull request.

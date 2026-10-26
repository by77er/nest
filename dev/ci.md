# CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. Branch protection requires one check, `ci-ok`, which passes only when every job below succeeded, so adding a job never needs a settings change (see [github.md](github.md)).

| Job | Runs | Needs |
|---|---|---|
| `rust` | `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` | iproute2, nftables and unprivileged user namespaces for nestd's netns tests |
| `control-plane` | `npm ci`, `npm run typecheck`, `npm test` (vitest in workerd) | Node 22 |
| `e2e` | The `claude-verify` harness tests (with a stub, never the real binary), then `e2e/run.sh` with the fake brain | The above, plus outbound access to `registry.npmjs.org` and `httpbin.org`; logs are uploaded on failure |
| `infra` | `inframe test --stack use1`: the cell stack's IAM theorems and graph policies, with no AWS credentials (plans run only in [deploy.yml](deploy.md)) | elan and the inframe CLI (`scripts/infra-tools.sh`, pinned) |
| `guards` | Doc links (`scripts/check-doc-links.py`), source fences (`scripts/check-fences.py`), and the guards' own tests (`scripts/tests/`) | Python 3.11+ |
| `deny` | `cargo deny check` (`deny.toml`): RustSec advisories, licenses, wildcards, unknown sources | cargo-deny, built from crates.io and cached |
| `secrets` | gitleaks over the full history (`.gitleaks.toml`): default rules plus nest's token formats | gitleaks, built from source and verified by Go's checksum database |
| `verify-nestd` | The Stateright checks of nestd's real cores at CI bounds (`verification/nestd/check`, `cargo test --release`), then `cargo mutants -p nestd-core` (0 missed expected) | cargo-mutants, pinned and cached ([verification](#verification)) |
| `kani-nestd` | `cargo kani -p nestd-core`: the proofs of nestd-core's decision functions | kani-verifier, pinned and cached |
| `fuzz-nestd` | Every fuzz target in `verification/nestd/fuzz` for 60 s | the pinned nightly in that directory, cargo-fuzz |
| `ci-ok` | Fails unless every job above succeeded | — |

- **Pinned:** the Rust toolchain (`rust-toolchain.toml`), every action by commit, cargo-deny and gitleaks by version. A new stable Rust or a moved action tag can't break an unrelated PR; bumps are their own PRs.
- **Skips fail in CI:** `NEST_CI_REQUIRE_USERNS=1` turns a test's "no user namespaces, skipping" into a failure (see [practices.md](practices.md#tests)).
- **Runner setup:** `ubuntu-24.04` restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), which breaks `unshare --map-root-user` and bubblewrap. The jobs turn it off with `sysctl`, which is safe on a single-use runner VM ([Ubuntu 24.04 notes](https://documentation.ubuntu.com/release-notes/24.04/)).
- **No secrets:** CI runs with `permissions: contents: read`, checks out without persisted credentials, and holds no secrets, so a PR's code runs with nothing to leak.
- **Caches:** cargo registry and `target/` keyed by the toolchain and `Cargo.lock`; npm keyed by `package-lock.json`.
- **Changes to CI and its configs need my review** (`.github/`, `scripts/`, `rust-toolchain.toml`, `clippy.toml`, `deny.toml` and `.gitleaks.toml` are in `CODEOWNERS`), so agents can't weaken the checks that gate their own merges.

## Verification

nestd's cores are checked as shipped ([docs/verification/nestd/](../docs/verification/nestd/)). The checker and the fuzz crate are standalone (each has its own `[workspace]` and lockfile), so `cargo test --workspace` doesn't see them, and cargo-deny doesn't cover their lockfiles. The purity fence on `crates/nestd-core` runs in `guards`.

| Check | On every PR | Longer (by hand or a scheduled run; not wired yet) |
|---|---|---|
| Model checks | the specs in `verification/nestd/check/tests/variants.rs`: about 16 s on 4 threads locally | `cargo test --release -- --include-ignored` adds every fault at once (about 21M states, 40 s on 8 threads locally); `cargo run --release -- <spec>` explores other bounds and prints shortest counterexamples |
| Mutation testing | `cargo mutants -p nestd-core --timeout 60 -j 2`: 192 mutants, about 2 min at `-j 1` locally | — |
| Kani | every harness: about 1 min locally (kani-verifier 0.68.0) | — |
| Fuzzing | 60 s per target | 10 min for the guest targets and 3 min for the rest, with the corpus kept in a cache |

- **Bumps:** stateright is pinned exactly (`=0.31.0`), cargo-mutants, kani-verifier and cargo-fuzz by version, the fuzz nightly by date.
- **When a check fails:** a model check names the property and prints the shortest counterexample with `cargo run --release -- <spec>`; replay it as a step test in `crates/nestd-core/tests/`. A fuzz crash is uploaded as the `fuzz-artifacts` artifact; reproduce with `cargo fuzz run --fuzz-dir verification/nestd/fuzz <target> <file>`.

## Not in CI

| What | Why | Where it runs instead |
|---|---|---|
| Real Claude Code (`claude-verify`, `NEST_E2E_CLAUDE=real`) | Needs the subscription token and spends quota; the token never goes to GitHub | The cloud dev environment, by hand ([setup stage 1](../docs/setup/#stage-1-real-claude-code-no-cloud-no-kvm)) |
| Firecracker | Needs KVM with nested virtualization; whether GitHub's standard runners expose `/dev/kvm` is unverified | The [first spike](../docs/README.md#first-spike) on AWS |
| `cargo fmt --check` | The tree isn't rustfmt-formatted yet (about 1,300 hunks) | A first maintenance task: format in one PR, then add the check |

## Cost

The repo is private, so runs use the account's included Actions minutes. A full run is ten jobs, most of them under 5 minutes, `e2e` up to 20 and the three nestd verification jobs up to about 15 each (estimated; not yet measured on a runner); how many minutes the plan includes is unverified for GitHub Pro. `concurrency` cancels superseded runs on a PR.

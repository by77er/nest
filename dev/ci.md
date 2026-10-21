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
| `ci-ok` | Fails unless every job above succeeded | — |

- **Pinned:** the Rust toolchain (`rust-toolchain.toml`), every action by commit, cargo-deny and gitleaks by version. A new stable Rust or a moved action tag can't break an unrelated PR; bumps are their own PRs.
- **Skips fail in CI:** `NEST_CI_REQUIRE_USERNS=1` turns a test's "no user namespaces, skipping" into a failure (see [practices.md](practices.md#tests)).
- **Runner setup:** `ubuntu-24.04` restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), which breaks `unshare --map-root-user` and bubblewrap. The jobs turn it off with `sysctl`, which is safe on a single-use runner VM ([Ubuntu 24.04 notes](https://documentation.ubuntu.com/release-notes/24.04/)).
- **No secrets:** CI runs with `permissions: contents: read`, checks out without persisted credentials, and holds no secrets, so a PR's code runs with nothing to leak.
- **Caches:** cargo registry and `target/` keyed by the toolchain and `Cargo.lock`; npm keyed by `package-lock.json`.
- **Changes to CI and its configs need my review** (`.github/`, `scripts/`, `rust-toolchain.toml`, `clippy.toml`, `deny.toml` and `.gitleaks.toml` are in `CODEOWNERS`), so agents can't weaken the checks that gate their own merges.

## Not in CI

| What | Why | Where it runs instead |
|---|---|---|
| Real Claude Code (`claude-verify`, `NEST_E2E_CLAUDE=real`) | Needs the subscription token and spends quota; the token never goes to GitHub | The cloud dev environment, by hand ([setup stage 1](../docs/setup/#stage-1-real-claude-code-no-cloud-no-kvm)) |
| Firecracker | Needs KVM with nested virtualization; whether GitHub's standard runners expose `/dev/kvm` is unverified | The [first spike](../docs/README.md#first-spike) on AWS |
| `cargo fmt --check` | The tree isn't rustfmt-formatted yet (about 1,300 hunks) | A first maintenance task: format in one PR, then add the check |

## Cost

The repo is private, so runs use the account's included Actions minutes. A full run is seven jobs, most of them under 5 minutes and `e2e` up to 20; how many minutes the plan includes is unverified for GitHub Pro. `concurrency` cancels superseded runs on a PR.

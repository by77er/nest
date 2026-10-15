# CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. Its four jobs are the required checks for merging (see [github.md](github.md)).

| Job | Runs | Needs |
|---|---|---|
| `rust` | `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` | iproute2, nftables and unprivileged user namespaces for nestd's netns tests |
| `control-plane` | `npm ci`, `npm run typecheck`, `npm test` (vitest in workerd) | Node 22 |
| `e2e` | The `claude-verify` harness tests (with a stub, never the real binary), then `e2e/run.sh` with the fake brain | The above, plus outbound access to `registry.npmjs.org` and `httpbin.org`; logs are uploaded on failure |
| `docs` | `scripts/check-doc-links.py`: every relative Markdown link and `#anchor` resolves | Python 3 |

- **Runner setup:** `ubuntu-24.04` restricts unprivileged user namespaces through AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`), which breaks `unshare --map-root-user` and bubblewrap. The jobs turn it off with `sysctl`, which is safe on a single-use runner VM ([Ubuntu 24.04 notes](https://documentation.ubuntu.com/release-notes/24.04/)).
- **No secrets:** CI runs with `permissions: contents: read` and holds no credentials, so a PR's code runs with nothing to leak.
- **Caches:** cargo registry and `target/` keyed by `Cargo.lock`; npm keyed by `package-lock.json`.
- **Changes to the workflow need my review** (`/.github/` and `/scripts/` are in `CODEOWNERS`), so agents can't weaken the checks that gate their own merges.

## Not in CI

| What | Why | Where it runs instead |
|---|---|---|
| Real Claude Code (`claude-verify`, `NEST_E2E_CLAUDE=real`) | Needs the subscription token and spends quota; the token never goes to GitHub | The cloud dev environment, by hand ([setup stage 1](../docs/setup/#stage-1-real-claude-code-no-cloud-no-kvm)) |
| Firecracker | Needs KVM with nested virtualization; whether GitHub's standard runners expose `/dev/kvm` is unverified | The [first spike](../docs/README.md#first-spike) on AWS |
| `cargo fmt --check` | The tree isn't rustfmt-formatted yet (about 1,300 hunks) | A first maintenance task: format in one PR, then add the check |

## Cost

The repo is private, so runs use the account's included Actions minutes. A full run is four jobs of 5–20 minutes each; how many minutes the plan includes is unverified for GitHub Pro. `concurrency` cancels superseded runs on a PR.

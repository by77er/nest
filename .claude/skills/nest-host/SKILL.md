---
name: nest-host
description: Use when changing nest's host-side Rust code: nestd and nestd-core, nest-runner, nest-proxy, nest-gateway, nest-guest, nest-hands-client or nest-cli, including fencing, incarnations, the runner, proxy and gateway links, drivers and host tests. Covers the sans-IO core / thin shell rule and its checks (no-std build, manifest check, Stateright, Kani, cargo-mutants, fuzzing), and the fencing invariants.
---

# Changing host code

**Where things are:** each crate has a README with its tests. The design is in:
- [docs/compute/nestd/](../../../docs/compute/nestd/README.md);
- [docs/sandbox/](../../../docs/sandbox/README.md): fencing, gateway, guest agent, networking, drivers;
- [docs/agents/runner/](../../../docs/agents/runner/README.md);
- [docs/interfaces/host-internal/](../../../docs/interfaces/host-internal/README.md).

How the cores are verified is in [docs/verification/nestd/](../../../docs/verification/nestd/README.md). A wire change also follows the `nest-wire` skill. `nest-proxy`, `nest-runner`, `nestd/src/net.rs`, `nestd/src/driver/` and `nest-protocol/src/host.rs` are `CODEOWNERS` paths.

## New decision logic goes in a pure core

- **Where:** `crates/nestd-core`. It is `no_std` with `alloc`, has no dependencies, and forbids `unsafe`.
- **Shape:** `step(&mut state, now, input) -> Vec<Effect>`.
  - Effects are a closed enum, and every outcome, failure included, comes back as an input.
  - Timers are core state (`wake_at()`). The shell reads the clocks and passes them in.
  - Durable state is written ahead: the shell persists it before performing the step's effects. Effects carry ids, so a replay is idempotent.
- **The shell decides nothing.** It decodes an input, reads clocks, calls `step`, persists, and performs effects with one I/O operation per arm. Update the shell's audit table (effect → I/O → where) in the verification doc.
- **Runtime invariants** go through `nestd_core::invariant`: they panic in debug builds and are logged in release.
- **Purity is enforced three ways; run all three:**
  - `rustup target add x86_64-unknown-none && cargo build -p nestd-core --target x86_64-unknown-none --locked`
  - `python3 -I scripts/check-core-manifest.py`: no dependency, no build script, no `cfg(target_*)`, no `#[path]` or `include!`;
  - `python3 -I scripts/check-fences.py`: the `nestd-core-purity` fence. No `HashMap` (use `BTreeMap`), no `Instant`, `std::fs` or `async`.

## Verifying a core

Bounds and results are recorded in the verification doc. Say which bound a claim holds for.
- **Unit tests:** `cargo test -p nestd-core`. Replay each counterexample as a step test in `crates/nestd-core/tests/`.
- **Stateright, over the real core:**
  - `cd verification/nestd/check && cargo test --release --locked` runs every spec at CI bounds (about 20 s on 4 threads).
  - `cargo run --release -- <spec>` prints the shortest counterexample.
  - `cargo test --release -- --include-ignored` runs every fault at once.
  - Rules:
    - a new fix gets a variant with that fix off, pinned in `tests/variants.rs` as a violation;
    - every fault class gets a `sometimes` example, so a pass isn't vacuous;
    - keep the FleetDO peer model in step with `fleet.ts`: a checker against a stale peer proves little.
- **Kani:**
  - one harness at a time: `cargo kani -p nestd-core --harness <module>::proofs::<name> --exact`;
  - bound loops with `#[kani::unwind]`;
  - CBMC stalls on `BTreeMap` and `VecDeque`, so make the code generic over its map and prove it over a fixed-array stand-in (`ResultCache`, `TombstoneMap`).
  - Mutate the property to show the harness can fail.
- **cargo-mutants:**
  - `cargo mutants -p nestd-core --in-place --timeout 60` (a few minutes); 0 missed is required.
  - `--in-place` edits your sources while it runs: build nothing else, and check `git status` afterwards.
  - An equivalent mutant is excluded in `.cargo/mutants.toml` by function and mutation (never by line), with a reason. Otherwise write the missing test.
- **Fuzzing:** new parsers at a trust boundary get a target in `verification/nestd/fuzz` (its README). Seeds come from `protocol/fixtures/`.
  - `cd verification/nestd/fuzz && python3 -I gen_seeds.py && cargo test --locked` checks that the seeds decode.
  - `./run.sh <target> replay` replays the seeds and corpus once (the PR gate).
  - `./run.sh <target> 600` fuzzes for a time.
  - It needs the pinned nightly; put `~/.cargo/bin` first on `PATH` if a tool manager's shim overrides `rust-toolchain.toml`.

## Invariants that must survive

- **No VM outlives nestd:**
  - the VMMs run in its delegated cgroup;
  - each child is spawned with `PR_SET_PDEATHSIG` (`driver/supervise.rs`);
  - a starting nestd kills leftovers (by pidfd), netns mounts and runtime directories before its first hello.
- **A fence is per `(sandbox, epoch)`:**
  - `Fenced` is terminal for its epoch;
  - each incarnation has its own directories (`<state_dir>/sandboxes/<sandbox>/<epoch>/`);
  - an older epoch never touches a newer one's row, pause handle or directory;
  - tombstones refuse creates at or below a fenced epoch.
- **A sandbox fence never touches brains.** Brains are fenced by the host lease and their agent epoch. A start never outlives a lease lapse.
- **Dirty work ends as a head, an orphan, or a logged final refusal,** never a silent delete.
- **A brain host runs no sandbox machinery** (`Config::validate`, `host_kind_refusal`).
- **The `AGENTS.md` invariants are fenced** (`scripts/fences.toml`): the guest and the gateway name no credential; only the runner launches `claude`, never with permission bypass; only nest-proxy terminates TLS. Never widen an `allow` list.
- **Hosts lag the Worker by a release, and a brain host and a sandbox host may be a release apart** (`nest-wire`).

## Tests

- **Commands:** `cargo clippy --workspace --all-targets --locked -- -D warnings` and `cargo test -p <crate>`. Run nestd's with `NEST_CI_REQUIRE_USERNS=1` so a netns test can't skip (it needs `ip`, `nft` and unprivileged user namespaces).
- **Waits, parallel safety and flakes** follow `nest-tests`.
- **Cross-component changes** (runner, nestd, proxy, gateway, guest, control plane) run e2e (`nest-validation`).
- **Evidence tiers:** the process driver proves no Firecracker, snapshot, real vsock or tunnel behaviour. `nest-guest` changes need a hand rebuild of the guest image (`images/guest/build-on-ec2.sh`, [dev/deploy.md](../../../dev/deploy.md)); say so in the PR.

## Done

- Clippy, the crate's tests, the no-std build and the guards pass.
- For a core change: the checker, Kani and mutants (0 missed) pass, and fuzz replay too if a parser changed.
- The verification doc's tables, bounds and results are updated.
- e2e passed if components interact.
- Conformance is checked if the runner link or the one-brain path changed (the `nest-control-plane` skill).

# nestd-core

nestd's pure state-machine cores. Each is a synchronous `step(state, input) -> effects` with no I/O: no clock, filesystem, network, processes, randomness or async runtime. The shell in `crates/nestd` reads the clock and the wire, feeds what it read in as inputs, and performs the effects. That is what lets the model checker, Kani and cargo-mutants run against the shipped code rather than a parallel model.

- **Design:** `docs/verification/nestd/` (the approach and what each core covers), `docs/compute/nestd/` (the behaviour).
- **Purity is enforced:** CI `rust` builds the crate for `x86_64-unknown-none` (no `std`); in CI `guards`, `scripts/check-core-manifest.py` and the `nestd-core-purity` fence (`scripts/fences.toml`) reject dependencies, build scripts, target `cfg`s and other escapes. See the crate doc in `src/lib.rs`.

## Modules

| Module | Decides |
|---|---|
| `fleet` | nestd's side of the fleet link to FleetDO: connect and backoff, hello and what its ack resets, the reliable `events` outbox (seq, cumulative acks, resend, audit coalescing and shedding), inbound command dedup |
| `lease` | The lease watchdog: self-fence once the deadline passes on `CLOCK_MONOTONIC` or `CLOCK_BOOTTIME` |
| `incarnation` | One sandbox incarnation's lifetime: its fenced-epoch tombstone, the scan a starting nestd makes of what the last one left, and salvage on retire |
| `results` | The bounded `cmd` → outcome cache, so a redelivered command answers with its first outcome |
| `invariant` | Runtime assertions: a violation panics under `debug_assertions` (tests, the checker) and is an effect, never an abort, in release |

## Checks

| Check | Where | Runs |
|---|---|---|
| Unit and property tests | `src/`, `tests/` | `cargo test -p nestd-core`, CI `rust` |
| No-std build | — | `cargo build -p nestd-core --target x86_64-unknown-none`, CI `rust` |
| Model checking (Stateright) of the real cores | `verification/nestd/check/` | CI `verify-nestd` |
| Mutation testing, 0 missed | — | `cargo mutants -p nestd-core`, CI `verify-nestd` |
| Kani proofs of the decision functions | `#[cfg(kani)]` harnesses | `cargo kani -p nestd-core`, CI `kani-nestd` |
| Fuzzing | `verification/nestd/fuzz/` | CI `fuzz-nestd` (replay), nightly `fuzz.yml` |

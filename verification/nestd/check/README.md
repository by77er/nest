# nestd-check

Stateright checks of nestd's real cores (`crates/nestd-core`) composed with models of their peers. Design, properties, bounds and results: [docs/verification/nestd/](../../../docs/verification/nestd/README.md).

It's a standalone crate (its own `[workspace]` and lockfile), so `cargo test --workspace` at the repo root doesn't run it. Build in release: the checker is CPU-bound, and release keeps debug assertions on, so a core invariant that fails panics the run.

| Command | What |
|---|---|
| `cargo test --release` | the expected outcome of every spec at CI bounds (`tests/variants.rs`) |
| `cargo test --release -- --include-ignored` | plus the fleet link with every fault at once (about 21M states) |
| `cargo run --release -- <spec> ...` | check specs and print the shortest counterexample of each violated property |
| `cargo run --release --example walk -- <seed>` | a random walk, for finding paths that never stop changing the state |

**Specs:**

- **Fleet link:** `<variant>[,cmds=N][,drops=N][,restarts=N][,resets=N][,broker=N][,secrets=0]`.
  - `variant` is `fixed`, `main` (FleetDO as on `edf6829`), or `fixed` with one fix removed: `no-baseline`, `late-capture`, `volatile-capture`, `broker-quiet`, `stale-hello` or `stale-events`.
  - The defaults are 3 commands and one of each fault.
- **Lease:** `lease[,unit=MS][,horizon=STEPS][,drops=N][,suspends=N][,suspend=STEPS][,inflight=N]`.
- **Unchanged disk:** `sentinel[,async][,trust-running][,writes=N][,commits=N][,restarts=N]`; `async` and `trust-running` are the two broken shells, each expected to fail.
- **Incarnation lifecycle:** `incarnation[,today][,same-epoch][,stuck-archive][,lapsed-create][,disk-only][,cmds=N][,fences=N][,epochs=N]`. The default is the shell with the audit's three fixes, which holds; `today` is the shell as it is, and `same-epoch`, `stuck-archive` and `lapsed-create` each remove one fix. Each is expected to fail the property its fix is there for. `unfenced-resume` makes a resume ignore the fence, which fails the fenced-VM property (so that property can fail).

**Environment variables:**

- `CHECK_THREADS` sets the worker threads (default: the CPUs, at most 4).
- `CHECK_MAX_DEPTH` bounds the search depth, to measure growth.

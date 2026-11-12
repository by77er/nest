# verification

Formal models, proofs and checkers of nest's protocols. Docs: [docs/verification/](../docs/verification/README.md), which say what each covers, what it found, and what it abstracts.
- **The study's pilots** (`tla/`, `lean/`, `stateright/`, `repro/`) are models, not tests of the code. Each one is a hand translation, and its doc has an action-to-code table.
- **`nestd/`** checks nestd's real cores (`crates/nestd-core`) and fuzzes its parsers; it runs in CI ([dev/ci.md](../dev/ci.md#verification)).

| Path | Tool | What | Build |
|---|---|---|---|
| `tla/sandbox-lease/` | TLA+/TLC | Placement, leases, fencing, STONITH, salvage and commit as on `main` at `edf6829`; `SlotFollowups.tla`: a command result's and a placement's follow-ups, the slots and `resolve` (2026-11-06); `PlacementRetry.tla`: a refused placement's bounded retries and give-up; `FailedRelease.tla`: a failed sandbox's lease released, and the incarnation it leaves (2026-11-09) | `run.sh --only tla` |
| `tla/agent-brain/` | TLA+/TLC | The brain lifecycle and the one-brain rule: 65bf6ef, the single-record design and its amendments, and the record as built (merged as #30), with a previous-release host | `run.sh --only tla` |
| `tla/live-rules/` | TLA+/TLC | Live capability rules: the watch, nudges by `rev`, the nudge alarm and the agents' reads, with lost replies, resets, a lost watch and a rollback (2026-11-12) | `run.sh --only tla` |
| `lean/` | Lean 4 (core, v4.33.1) | SandboxDO's commit chain and the object-store GC: proved invariants and checked counterexamples | `lake build` in `lean/` |
| `stateright/` | Stateright 0.31.0 | FleetDO → nestd command delivery at `edf6829`, and two fixes (superseded by `nestd/check/`) | `cargo test --release` in `stateright/` (its own workspace) |
| `nestd/check/` | Stateright 0.31.0 | nestd's real fleet-link core and lease decision composed with a FleetDO peer model ([README](nestd/check/README.md)) | `cargo test --release` in `nestd/check/` (its own workspace) |
| `nestd/fuzz/` | cargo-fuzz | Every parser nestd runs on input from across a trust boundary ([README](nestd/fuzz/README.md)) | `cargo fuzz` in `nestd/fuzz/` (its own workspace, a pinned nightly) |
| `repro/` | vitest | Reproductions of model counterexamples against the real Durable Objects. Not part of `npm test`; copy one into `control-plane/test/` to run it | — |

`run.sh` runs the pilots (not `nestd/`):
- It fetches the pinned TLA+ tools (v1.7.4, checked by SHA-256) into `.tools/`.
- It runs each TLC configuration listed in `tla/*/expect.tsv` and checks its outcome: `holds`, or a violation of a named property. A model whose bug configuration stops failing is a red result too.
- It builds the Lean project, refusing `sorry`, and runs the Stateright tests.
- By default it runs only the configurations marked `ci`; `--all` runs every configuration, and some take more than 10 minutes.
- TLC writes its state queue to `.tlc-states/`, which can reach gigabytes for the large configurations.

CI wiring for the pilots is proposed in [dev/verification.md](../dev/verification.md).

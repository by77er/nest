# verification

Formal models and proofs of nest's protocols: the sources for the pilots in [docs/verification/](../docs/verification/README.md), which say what each model covers, what it found, and what it abstracts. These are models, not tests of the code. Each one is a hand translation, and its doc has an action-to-code table.

| Path | Tool | What | Build |
|---|---|---|---|
| `tla/sandbox-lease/` | TLA+/TLC | Placement, leases, fencing, STONITH, salvage and commit as on `main` | `run.sh --only tla` |
| `tla/agent-brain/` | TLA+/TLC | The brain lifecycle and the one-brain rule: 65bf6ef, the single-record design and its amendments, and `deferred/brain-record` as built | `run.sh --only tla` |
| `lean/` | Lean 4 (core, v4.33.1) | SandboxDO's commit chain and the object-store GC: proved invariants and checked counterexamples | `lake build` in `lean/` |
| `stateright/` | Stateright 0.31.0 | FleetDO → nestd command delivery on `main`, and two fixes | `cargo test --release` in `stateright/` (its own workspace) |
| `repro/` | vitest | Reproductions of model counterexamples against the real Durable Objects. Not part of `npm test`; copy one into `control-plane/test/` to run it | — |

`run.sh` runs everything:
- It fetches the pinned TLA+ tools (v1.7.4, checked by SHA-256) into `.tools/`.
- It runs each TLC configuration listed in `tla/*/expect.tsv` and checks its outcome: `holds`, or a violation of a named property. A model whose bug configuration stops failing is a red result too.
- It builds the Lean project, refusing `sorry`, and runs the Stateright tests.
- By default it runs only the configurations marked `ci`; `--all` runs every configuration, and some take more than 10 minutes.
- TLC writes its state queue to `.tlc-states/`, which can reach gigabytes for the large configurations.

CI wiring is proposed in [dev/verification.md](../dev/verification.md).

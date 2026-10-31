# Verification roadmap

What is next: open findings, models, runtime assertions, conformance and CI. It follows from the [inventory](../README.md#inventory), the [methods](../methods/) evaluation, the pilots and the [direction](../README.md#verification): new protocol logic goes into pure cores checked as the real code. State as of 2026-10-29 (`main` at b63c0a3); what is done is in the [status](../README.md#verification). CI specifics are in [dev/ci.md](../../../dev/ci.md#verification) (what runs) and [dev/verification.md](../../../dev/verification.md) (the pilots' proposal).

## Open findings, each with a test that fails before the fix

Found by the study on `main` (`edf6829`) and still in the code; [the bug table](../README.md#real-bugs-found) has each one's state. Each needs a regression test written first.

| Finding | Test to write | Owner doc |
|---|---|---|
| nestd drops a dirty incarnation's work when a resent `unanswered` commit is refused `stale_epoch` before the salvage is prepared | nestd harness: persist an unanswered `turn_end` at epoch e, restart, SandboxDO at e+1; assert an orphan lands. Phase 2's incarnation checker should reproduce it first ([nestd/](../nestd/#phase-2-design)) | [nestd-incarnations/](../nestd-incarnations/) |
| Salvage refused after a no-capacity epoch rollback | vitest sketch in [sandbox-lease/](../sandbox-lease/#8-real-and-suspected-bugs); waits on the owner's decision about the rollback | [sandbox-lease/](../sandbox-lease/) |
| `destroy` during an in-flight placement resurrects the sandbox | `const p = stub.wake(); await stub.destroy(); await p` and assert it stays `destroyed` with no lease | [sandbox-lease/](../sandbox-lease/) |
| Double run after a lapse: a `sandbox_create` run after the host's lease lapsed; STONITH counting `shutting-down` as dead | nestd harness: a create that arrives while lapsed is refused. The STONITH half is done: vitest `lifecycle.test.ts` (B-2) and `agent-seams.test.ts` (A6) keep a `shutting-down` host `stonith_pending` and not lost | [sandbox-lease/pilot/](../sandbox-lease/pilot/) |
| Stuck sandboxes: a late placement answer adopts a lost host (L1); `INSERT OR IGNORE` drops a reassignment (L2) | vitest per trace in the pilot | [sandbox-lease/pilot/](../sandbox-lease/pilot/) |
| A resent commit has no age bound against the GC grace (B1, proved as a Lean counterexample) | fake-S3 test: prepare, age 25 h, GC with no roots, evaluate the saved request, expect a refusal | [commit-gc/](../commit-gc/) |

The hosts, gateway and channel inventories list more suspected bugs, each with a confirming test.

## Runtime assertions to add now

They are cheap and catch drift that the models can't see. Each throws in tests and logs plus counts a metric in production ([metrics](../../control-plane/metrics/)). nestd's cores already assert theirs (`nestd_core::invariant`, [nestd/](../nestd/)); none of these control-plane or commit-client ones is built yet.

| Assertion | Where | Property |
|---|---|---|
| A placement continuation never writes over `destroyed`; `destroyed` is never left | SandboxDO `placeCurrentEpoch`, `reconcilePlacing` | destroyed is terminal |
| `FleetDO.place` logs when `req.epoch` is at or below the highest epoch ever leased for the sandbox | FleetDO | no leased epoch reused |
| A committed or orphaned generation's `parent` is recorded or null; no orphan after `destroyed` | SandboxDO `commit` | chain is a tree |
| `queueReassign` logs when `INSERT OR IGNORE` skipped a different `(host, epoch)` | FleetDO | no lost reassignment |
| An `unanswered` commit older than `G − R − 1 h` is dropped and prepared afresh | nestd commit client | A1 for GC |
| A session is current only when `brain.phase != condemned` and its epoch equals `brain.epoch`, re-checked after every await | AgentDO | one acting brain |

## Next, in order

| # | What | Tool | Why now |
|---|---|---|---|
| 1 | nestd phase 2: incarnations, the gateway link, the runner link's brain table, and the proxy link once its rework (PR #28) merges, each as a pure core with its shell ([design](../nestd/#phase-2-design)) | Stateright over the real cores; Kani; shuttle for the shells that keep shared-memory concurrency; cargo-mutants | The direction; the incarnation core should reproduce the open incarnation bug above |
| 2 | The brain record's remaining assurance, on a dedicated machine: the epochs ≤ 3 sweep and the drain run to exhaustion (both stopped at 15-min cuts on a shared box), liveness with faults, more than 2 hosts, and epoch-less exits ([pilot](../agent-brain/pilot/#next-steps)). Re-run the conformance check over what merged after the checked heads: #36's final head (later than fe7b0d0) and #39's FleetDO send chain | TLA+/TLC; conformance review | The sweep is depth-bounded at 34-44; C6 shows epochs ≤ 3 still finds things |
| 3 | Extend the sandbox lease model with host lifecycle and STONITH by fence (stonith_pending, re-activation, drain) | TLA+/TLC | Most of the hosts inventory's suspected bugs sit on that boundary |
| 4 | Gateway bindings: detach window, attach/detach ordering, the ghost fenced epoch | TLA+ | Bounded windows of a second binding are the remaining one-brain gap for hands |
| 5 | GC with retention and `isRestoreSource` once retention lands | Lean (extend the pilot) | Deletion of generations becomes possible; the pilot's invariant carries over |
| 6 | DO await interleavings: `Deadlines`, `SerialQueue`, `ReliableChannels` | fast-check `fc.scheduler`, `fc.commands` | Lessons 2 and 6; unit-level. Pure cores for the DOs would replace this for the logic they hold (open question) |

## Conformance

nestd's checks run the real cores, so they need no conformance step. The TLA+, Lean and command-delivery pilots are hand translations; nothing ties them to the code but review. In order:
1. **Conformance reviews** at each change to a modelled handler: a table from model action to file:line at a named commit, done for the brain record from `deferred/brain-record` through #32 and #36's checked head ([conformance](../agent-brain/conformance/)). It's cheap, and it found divergences on the first run.
2. **Model-based tests:** generate traces from the model (TLC `-simulate file=…` or Apalache ITF; Quint `--mbt` if a spec moves to Quint) and replay them against the real Durable Objects in vitest, comparing a projection of their SQLite. Do it first for SandboxDO placement and commit, which have the simplest interfaces. An action with no driver fails the build.
3. **Trace validation** of e2e logs against the specs comes later ([methods](../methods/#conformance-keeping-specs-and-code-in-sync)).

## CI

- **Built:** nestd's checks run on every PR (`verify-nestd`, `kani-nestd`, `fuzz-nestd`) and fuzzing runs weekly ([dev/ci.md](../../../dev/ci.md#verification)).
- **Proposed** ([dev/verification.md](../../../dev/verification.md)): one `verification` job for the pilots, running `verification/run.sh` (TLC configurations that finish in minutes, expected outcomes asserted; `lake build` in `verification/lean`; `cargo test --release` in `verification/stateright`). Larger TLC bounds run nightly or by hand. The job joins `ci-ok`, so a red model blocks a merge like a red test.

## Open questions

- **The Durable Objects' checks** (pure cores and how they're checked; TLA+ or Quint for their design models): see [the README](../README.md#open-questions).
- **Spec ownership:** who updates a spec when an agent changes a modelled handler? Proposal: the same PR, enforced by a guard in `scripts/` that fails when a file named in a spec's action-to-code table changes without the spec or its conformance table changing.

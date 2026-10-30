# Verification roadmap

What to model next, how checks reach CI, and which invariants become runtime assertions or tests now. It follows from the [inventory](../README.md#inventory), the [methods](../methods/) evaluation and the pilots. CI specifics are in [dev/verification.md](../../../dev/verification.md).

## Now: fix-first findings, each with a test that fails before the fix

The study found these on `main` (`edf6829`) or on the brain branch. Each one needs a regression test written first. The study doesn't fix code.

| Finding | Where | Test to write | Owner doc |
|---|---|---|---|
| Fleet commands lost by reordering: a later batch is sent before an earlier one that awaits BrokerDO, or before hello's resend. nestd has no gap check, so the cumulative ack deletes the earlier batch. Reproduced by the Stateright pilot (8 steps, no fault) | `fleet.ts:1169-1171`, `:699-723`, `:762-778`; `fleet.rs:394-404` | vitest: a stub BrokerDO delays one `agent_start` while a `commit_result` is issued; assert the host receives seqs in order. cargo: nestd given seq N+1 before N closes and asks for a resend | [reliable-channels/pilot/](../reliable-channels/pilot/) |
| nestd drops a dirty incarnation's work when a resent `unanswered` commit is refused `stale_epoch` before the salvage is prepared | `host.rs:2052-2058`, `:1193` | nestd harness: persist an unanswered `turn_end` at epoch e, restart, SandboxDO at e+1; assert an orphan lands | [nestd-incarnations/](../nestd-incarnations/) |
| Salvage refused after a no-capacity epoch rollback | `sandbox.ts:312`, `:575`, `:585` | vitest sketch in [sandbox-lease/](../sandbox-lease/#8-real-and-suspected-bugs) | [sandbox-lease/](../sandbox-lease/) |
| `destroy` during an in-flight placement resurrects the sandbox | `sandbox.ts:304-319`, `:507-519` | `const p = stub.wake(); await stub.destroy(); await p` and assert it stays `destroyed` with no lease | [sandbox-lease/](../sandbox-lease/) |
| A resent commit has no age bound against the GC grace (B1, proved as a Lean counterexample) | `host.rs:2052`, `sandbox.ts:552`, `gc.rs:97` | fake-S3 test: prepare, age 25 h, GC with no roots, evaluate the saved request, expect a refusal | [commit-gc/](../commit-gc/) |
| Brain record: six design holes (amendments A1 to A6) and 38 code divergences across five heads; N25 (old sandbox hosts wedged in the mixed-version window) and a few lows still open at 36b60d5 | `origin/deferred/brain-record` | one test per amendment and per N item, mirroring the TLC trace or the conformance interleaving; the untested lines listed in the conformance doc | [agent-brain/conformance/](../agent-brain/conformance/) |

The hosts, gateway and channel inventories list more suspected bugs, each with a confirming test.

## Runtime assertions to add now

They are cheap and catch drift that the models can't see. Each throws in tests and logs plus counts a metric in production ([metrics](../../control-plane/metrics/)).

| Assertion | Where | Property |
|---|---|---|
| A placement continuation never writes over `destroyed`; `destroyed` is never left | SandboxDO `placeCurrentEpoch`, `reconcilePlacing` | destroyed is terminal |
| `FleetDO.place` logs when `req.epoch` is at or below the highest epoch ever leased for the sandbox | FleetDO | no leased epoch reused |
| A committed or orphaned generation's `parent` is recorded or null; no orphan after `destroyed` | SandboxDO `commit` | chain is a tree |
| Commands arrive at `last + 1`, or close and resend | nestd `fleet.rs` | in-order processing |
| `queueReassign` logs when `INSERT OR IGNORE` skipped a different `(host, epoch)` | FleetDO | no lost reassignment |
| An `unanswered` commit older than `G − R − 1 h` is dropped and prepared afresh | nestd commit client | A1 for GC |
| A session is current only when `brain.phase != condemned` and its epoch equals `brain.epoch`, re-checked after every await | AgentDO | one acting brain |

## Next models, in order

| # | What | Tool | Why now |
|---|---|---|---|
| 1 | Finish the brain record's follow-up assurance on a dedicated machine: the epochs ≤ 3 sweep and the drain run to exhaustion (both stalled at 15-min cuts on a shared box), liveness with faults, and more than 2 hosts. Re-run the conformance check for code merged after fe7b0d0 | TLA+/TLC (pilot) | The sweep is depth-bounded at 34-44; C6 shows epochs ≤ 3 still finds things |
| 2 | Extend the sandbox lease model with host lifecycle and STONITH by fence (stonith_pending, re-activation, drain) | TLA+/TLC | Most of the hosts inventory's suspected bugs sit on that boundary |
| 3 | Port the command-channel model's fixed variant to whichever fix lands, then run it as a regression | Stateright (pilot) | Already written; it checks the fix's pieces, not just the idea |
| 4 | Gateway bindings: detach window, attach/detach ordering, the ghost fenced epoch | TLA+ | Bounded windows of a second binding are the remaining one-brain gap for hands |
| 5 | nestd incarnation recovery: crash points over the `meta.json` write order, and retire racing destroy | Kani for the recovery decision; shuttle for the tasks | In-process; protocol models can't see it |
| 6 | GC with retention and `isRestoreSource` once retention lands | Lean (extend the pilot) | Deletion of generations becomes possible; the pilot's invariant carries over |
| 7 | DO await interleavings: `Deadlines`, `SerialQueue`, `ReliableChannels` | fast-check `fc.scheduler`, `fc.commands` | Lessons 2 and 6; unit-level |

## Conformance

The pilots are hand translations; nothing yet ties them to the code. In order:
1. **Conformance reviews** at each change to a modelled handler: a table from model action to file:line, done for the brain record against `deferred/brain-record` ([conformance](../agent-brain/conformance/)). It's cheap, and it found divergences on the first run.
2. **Model-based tests:** generate traces from the model (TLC `-simulate file=…` or Apalache ITF; Quint `--mbt` if a spec moves to Quint) and replay them against the real Durable Objects in vitest, comparing a projection of their SQLite. Do it first for SandboxDO placement and commit, which have the simplest interfaces. An action with no driver fails the build.
3. **Trace validation** of e2e logs against the specs comes later ([methods](../methods/#conformance-keeping-specs-and-code-in-sync)).

## CI

Proposal in [dev/verification.md](../../../dev/verification.md): one `verification` job with:
- `verification/run.sh` (TLC configurations that finish in minutes, expected outcomes asserted);
- `lake build` in `verification/lean`;
- `cargo test --release` in `verification/stateright`.

Larger TLC bounds run nightly or by hand. The job joins `ci-ok`, so a red model blocks a merge like a red test.

## Open questions

- **Spec language:** TLA+ for protocol models (the pilots) or Quint (the methods survey's pick, for its model-based-testing path)? See [the recommendation](../README.md#recommendation).
- **Spec ownership:** who updates a spec when an agent changes a modelled handler? Proposal: the same PR, enforced by a guard in `scripts/` that fails when a file named in a spec's action-to-code table changes without the spec or its conformance table changing.

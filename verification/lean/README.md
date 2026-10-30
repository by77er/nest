# nest verification in Lean 4

Proofs about the commit chain and object-store GC, from the pilot in [docs/verification/commit-gc/pilot](../../docs/verification/commit-gc/pilot/README.md). Lean core only (no mathlib, no dependencies), toolchain `leanprover/lean4:v4.33.1`.

## Build

```
cd verification/lean
lake build
```

About 3 s from clean. Build output prints the axioms check (`#print axioms` in `Nest.lean`). `lake build` fails on any proof error; there is no `sorry`, `admit` or `native_decide` in the project.

If your default elan toolchain differs and you run lake from outside this directory, call the pinned one directly: `~/.elan/toolchains/leanprover--lean4---v4.33.1/bin/lake -d verification/lean build`.

## Theorems

`Nest/CommitChain.lean` models `SandboxDO.commit` (`control-plane/src/do/sandbox.ts:552-613`) plus an arbitrary placement step. For every reachable state:

| Theorem | Says |
|---|---|
| `head_recorded` | the head is none or a recorded, non-orphan generation |
| `tree` | every non-orphan's parent is none or a recorded non-orphan with a smaller id (acyclic) |
| `orphan_never_head` | no orphan is ever head |
| `head_moves_only_by_cas` | a call that moves the head was a fresh request from `(info.host, info.epoch)` whose parent was the old head, and the new head is the committed non-orphan |
| `replay` | re-evaluating an answered request, from any host, returns the stored outcome and changes nothing |
| `idempotent` | the same holds after any later commits and placements (`commits` is never pruned) |
| `orphan_parent_unchecked` | **negative:** a reachable state holds an orphan whose parent was never recorded |
| `orphan_after_destroy` | **negative:** a salvage is accepted as an orphan after `destroy` (host = none) |

`Nest/Gc.lean` models S3 Last-Modified times, reuse at prepare, pending requests, evaluation by `CommitChain.commit`, GC passes and time:

| Theorem | Says |
|---|---|
| `safe` | under A1, every key of every recorded generation (orphans included) is present, and so is every key of every pending request A1 still lets be evaluated |
| `never_deletes_protected` | under A1, a delete step from a reachable state removes no such key |
| `b1_unsafe` | **counterexample (B1):** without A1, with `R = 12`, `G = 24`, a 6-step trace commits as head a generation whose chunk a pass already deleted |
| `b1_pending_lost` | the same trace loses a pending request's chunk before its evaluation |
| `a1_not_vacuous` | under A1 a commit becomes head and a pass still deletes garbage (the guarded model is not vacuous) |

## Axioms

Every theorem above depends on at most `propext`, `Classical.choice` and `Quot.sound` (the standard axioms); the counterexamples use `decide` and the kernel only, without `Classical.choice`.

# Pilot: commit chain and GC safety in Lean 4

One of three pilots weighing Lean 4 (already used for infrastructure in `deploy/lean`) against TLA+/TLC. This one **proves** invariants, unbounded, over the inventory in [commit-gc](../README.md). Project: [verification/lean](../../../../verification/lean/) (Lean core only, toolchain `v4.33.1`, no dependencies).

**Result:** everything asked for is proved with no `sorry`; B1 is a checked 6-step counterexample. Clean build ~3 s.

## Inventory claims checked against the code

All the inventory claims this pilot relies on match main `edf6829`: the commit guard order (`sandbox.ts:571-597`); `gcRoots` returns every row, orphans included (`:496-505`); the claim inserts the run (mark `T = now`) before reading roots (`fleet.ts:1635-1640`); the judge spares `max LM ≥ T − G` (`gc.rs:92-112`); reuse needs `now − LM < R` (`s3.rs:312-326`). One nuance: `SentCommit` stores no epoch (`recovery.rs:55-64`). A re-send uses the `Sbx`'s epoch (`host.rs:2090`), which is fixed per incarnation and restored from `meta.json` (`host.rs:484-485`), so in practice the request does go out with its original epoch, as the inventory says.

## Model

| Model (Lean) | Code |
|---|---|
| `CommitChain.State {epoch, host, head, gens, commits, history, next}` | `info.{epoch, host, head, history}`, `generations`, `commits` (`sandbox.ts:44-56`, `:125-127`) |
| `CommitChain.commit`, guard for guard | `decideCommit` (`control-plane/src/lib/sandbox-lease.ts`, pure, table-tested in `control-plane/test/sandbox-lease-core.test.ts`); the shell `SandboxDO.commit` stores the generation and the record |
| `CommitChain.Step.place e h hist`: sets epoch, host, history to anything | placement, eviction, lease loss, destroy (`sandbox.ts:236-317`, `:348`, `:411`, `:468`, `:513`) |
| `Gen.keys`: closure of the disk and memory manifests | `cl(m)` in the inventory; `gc.rs:76-89` |
| `World.store : key → Option LM` (newest version's Last-Modified) | versioned cell bucket |
| `Gc.reuse`: keep `k` if `now < LM + R`, else re-PUT with `LM := now` | `s3.rs:312-326`, `:475-507` |
| `Step.prepare` (adds a `Pending` with `v := now`) | `host.rs:2124-2148` |
| `Step.evaluate` (repeatable), with the A1 guard on the first one | `host.rs:2052-2058` re-send; `sandbox.ts:552` |
| `Step.drop` (answered, or lost for good) | `host.rs:2108-2111` |
| `Step.claim T` with `T ≤ now`, marking every generation's keys | `fleet.ts:1619-1652` |
| `Step.delete`: `k` unmarked and `LM + G < T` | `gc.rs:91-160` |
| `Step.put`: anything re-uploads any key | other sandboxes sharing chunks |
| `Step.tick d` | time |

**Over-approximations** (the model allows more than the code, so safety carries over): any number of passes at once, never finishing, with no deadline `W`; root-read failures that would abort a pass are ignored; the mark `T` may be any time up to the read (a real pass marks after `T`, so its root set is a superset); `put` at any time; placement unconstrained.

**Abstractions**, and why they are sound or not:

| Abstraction | Sound? |
|---|---|
| One sandbox, never destroyed | Sound for S1/S2 of a live sandbox; S6 (destroy) and the registry gap (S5) are out of scope |
| One clock | Unsound if skew matters; the inventory assumes skew ≪ 1 h (unverified) |
| A key's versions collapse to the newest LM | Sound: a pass deletes exactly the versions it listed (listed after `T`), so a key re-uploaded after the listing keeps a version with `LM ≥ T`, which the model's judge also spares |
| The `uploaded` memo folded into "present and young" | Sound while safety holds: a memo entry younger than `R` means `LM > now − R > T − G`, so no pass deleted the key |
| Generation ids from a counter | Assumes `newId` never collides |
| `history` arbitrary (the 50-entry cap is not modelled) | B4 is not checked |
| Messages: re-sends, loss and duplicates collapse to "evaluate any pending request, any number of times" plus `drop` | Sound for safety; liveness is out of scope |

## Theorems

### Commit chain (`Nest/CommitChain.lean`), for every reachable state

| Lean name | English |
|---|---|
| `head_recorded` | S3: head is none or a recorded non-orphan |
| `tree` | S3: every non-orphan's parent is none or a recorded non-orphan with a smaller id (so acyclic) |
| `orphan_never_head` | an orphan is never head |
| `head_moves_only_by_cas` | a head move comes from a fresh request from `(info.host, info.epoch)` whose parent was the previous head; the new head is the committed non-orphan |
| `replay` | S4: a replay, from any host, returns the stored outcome and changes nothing |
| `idempotent` | S4 for ever: after any later commits and placements, the same request id gets the same outcome and no change, so at most one generation per id |

Inductive invariant `Inv`: ids below `next`, ids unique, head recorded non-orphan, non-orphan parents recorded non-orphans with smaller ids. Four clauses; the uniqueness clause was needed for `orphan_never_head`.

### GC (`Nest/Gc.lean`)

| Lean name | English |
|---|---|
| `safe` | S1 + S2 under A1: every key of every recorded generation (orphans included) is present; so is every key of every pending request that A1 still lets be evaluated |
| `never_deletes_protected` | a delete from a reachable state removes no such key |
| `delete_spares` | the core lemma: from the invariant, a pass's delete guard excludes those keys |
| `a1_not_vacuous` | under A1 a commit becomes head and a pass still deletes garbage |

Inductive invariant (five clauses): LM never in the future; S1; each eligible pending key present with `v ≤ LM + R`; every pass marked in the past; every generation key is marked by each pass or has `LM + G ≥ T`. This is simpler than the inventory's candidate. Its clause 4 (per-pass read times, "evaluated after the read") is not needed, because A1 at evaluation plus `T ≤ now` gives `LM + G > T` directly.

**Findings from the proof:**
- **`G > R` is not a hypothesis.** The theorem holds for all `R`, `G`. A1 (`now + R < v + G`) can only be met when `G > R`, so the `s3.rs:690-704` test protects liveness (commits can be accepted at all), not safety.
- **`W` is not used** (as the inventory says), and neither is FleetDO's one-run-at-a-time rule: overlapping passes are safe.

## Proved negatives and counterexamples

| Lean name | What it shows |
|---|---|
| `orphan_parent_unchecked` | B3: placements at epoch 1 on host 7, then epoch 2 on host 8; a salvage from host 7 for epoch 1 with parent 42 is stored as an orphan, and no generation has id 42. The tree property does not cover orphans (`sandbox.ts:579-581`) |
| `orphan_after_destroy` | B3: with `host = none` (destroy), the same salvage is still accepted as an orphan |
| `b1_unsafe` | **B1**, with `R = 12`, `G = 24` (hours). Place at epoch 1 on host 7. Hour 0: prepare uploads chunk 5 and the request is lost. Hour 25: a pass with no roots deletes chunk 5 (`0 + 24 < 25`). The re-sent request is evaluated and becomes **head**, naming a deleted chunk. `¬ Safe` and the final state are checked by `decide` |
| `b1_pending_lost` | the same trace: the pending request's chunk is gone before evaluation, and A1 would have refused it (`25 + 12 < 24` is false) |

## Effort and verdict

822 lines of Lean (`CommitChain` 390, `Gc` 414), about 1.5 agent-hours, a clean build in about 3 s. The effort went to proof engineering (tactics), not invariant discovery: the key step was an `Effect` inductive naming `commit`'s four outcomes with their guards, and the GC invariant went through first time because the inventory's lemma had done the thinking.

Lean is viable and cheap here because the invariant was known and the state is small; it proves unbounded results (any keys, passes, `R`, `G`) and findings no bounded run states, but its counterexamples are hand-built (checked by `decide`), with no search. So: TLC first, to find bugs and validate the invariant on small bounds; then Lean to prove it unbounded. Both are hand translations, so the code can drift from either.

## Not proved

- Liveness (L1) and S5, S6, S7: no destroy, registry, dry runs or abort paths in the model.
- B4 (the 50-entry history cap): `history` is arbitrary.
- Clock skew: one clock.
- Model-to-code conformance: the model is checked by reading only.

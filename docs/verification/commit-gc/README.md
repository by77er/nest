# Commit chain and object-store GC

Inventory for modelling: the generation chain in SandboxDO, FleetDO's GC registry and runs, and nestd's chunk upload and mark/sweep. Code is cited at main `edf6829`; design at [sandbox/state](../../sandbox/state/README.md) and [object-store](../../sandbox/state/object-store/README.md).

**Pilot:** [pilot/](pilot/), the Lean 4 proofs over this inventory.

> **Status** (by reading `main`, 2026-11-02): the retention-enums branch in the table below merged as #32: the GC-root registry is written at `create`, a destroyed sandbox is never re-registered, salvage is authorized against SandboxDO's full `epochs` table (B4 fixed), and commit records are pruned by age unless their generation is still in the chain. Generation retention (`isRestoreSource`, `deleting` generations, the placement pin) is built (#85) and modelled in [Retention](#retention) below. B1 and B3 are open.

## Scope and actors

| Actor | State (exact) | Code |
|---|---|---|
| SandboxDO (one per sandbox, single writer) | `info.{epoch, host, head, state, history[≤50]}`; `generations(id, record, orphaned, created_ms)`; `commits(request PK, outcome)`, never pruned on main | `control-plane/src/do/sandbox.ts:125-127`, `:94` |
| FleetDO (one per cell) | `sandboxes(sandbox PK, registered_ms, destroyed_ms?)`; `gc_runs(run, host, marked_ms, dry_run, mark_version, roots, finished_ms?, report?)`; kv `gc_requested` | `control-plane/src/do/fleet.ts:224-230` |
| nestd committer | `uploaded: key → ms` (local reuse memo); `Sbx.{head, unanswered}`; persisted `meta.json.unanswered` | `crates/nestd/src/s3.rs:312-342`, `crates/nestd/src/host.rs:129-133` |
| nestd GC pass (burst host) | a `Claim{run, marked_ms, dry_run, roots, grace_ms, deadline_ms, max_deletes}`; `marked`, `doomed` sets | `crates/nestd/src/gc.rs:25-34`, `:73-163` |
| S3 cell bucket | versioned (`deploy/lean/Cell/Stack.lean:256`); per key a set of versions `(vid, LM)`; noncurrent versions expire after 1 day (`:265-267`) | |

Constants: `R = REUSE_MS = 12 h` (`s3.rs:54`), `G = GC_GRACE_MS = 24 h`, `W = GC_WINDOW_MS = 12 h`, interval 24 h, cap 10k, `GC_MARK_VERSION = 1` (`fleet.ts:128-134`). A test pins `G > R` (`s3.rs:690-704`).

At `edf6829` there was no retention: resume loaded `head` (`sandbox.ts:282`, `:442`), GC kept every recorded generation (`sandbox.ts:496-505`), and the drain gate was "suspended then evicted" (`fleet.ts:1017-1018`).

## State machines

### Commit (`decideCommit` in `lib/sandbox-lease.ts`; the shell `SandboxDO.commit`)

One synchronous block (no await before the `commits` insert), so a commit is atomic in DO SQLite.

| Transition | Guard (evaluated in order) | Effect | Ref |
|---|---|---|---|
| Replay | `commits[request]` exists | return stored outcome, no write | `:553-554` |
| Reject invalid | `(kind = checkpoint) ≠ (mem_manifest present)` | store `rejected(invalid_message)` | `:568-571` |
| Orphan | `reason = salvage ∧ ev.epoch < info.epoch ∧ (ev.epoch, host) ∈ history` | insert gen `orphaned=1`, parent = `ev.parent` (unchecked); store; post `orphaned_work` after the store | `:575-584`, `:599-609` |
| Reject salvage | same, `(ev.epoch, host) ∉ history` (also when evicted from the 50-entry cap) | store `rejected(stale_epoch)` | `:576-578` |
| Reject stale | `ev.epoch ≠ info.epoch ∨ host ≠ info.host` (includes destroyed: `host = null`) | store `rejected(stale_epoch)` | `:585-586` |
| Reject parent | `ev.parent ≠ info.head` | store `rejected(parent_mismatch, head)` | `:587-588` |
| Commit | otherwise | insert gen `orphaned=0`; `head := gen.id`; store | `:589-596` |

No state guard: an orphan is accepted after `destroy` (`state = destroyed`), and `orphaned_work` is posted for a destroyed sandbox.

### nestd commit client (`host.rs:2040-2175`)

| Step | Effect | Ref |
|---|---|---|
| `prepare` | chunk every non-zero 4 MB block; reuse a chunk only if `recent` (this process uploaded it < R ago, or HEAD `Last-Modified` < R ago), else PUT; then the manifest under the same rule; new request id | `storage.rs:118-163`, `s3.rs:312-326`, `:475-507`, `host.rs:2124-2148` |
| `send` | persist `meta.unanswered := c` **before** emitting `commit_request` to the in-memory outbox (a failed persist fails the commit, retryable, unsent); wait unlocked up to `commit_timeout` (60 s) | `host.rs:2076-2121`, `config.rs:275-277` |
| timeout | keep `unanswered := c` (persisted) | `host.rs:2112-2115` |
| next commit | re-send `unanswered` under the same id with its **original manifest and epoch**, adopt the outcome; only then prepare | `host.rs:2052-2071` |
| `Committed` | `head := gen`; `clean := vm none ∨ paused` | `host.rs:2152-2161` |
| `Rejected(stale_epoch \| parent_mismatch)` | fence this incarnation (epoch-checked) | `host.rs:2163-2172` |

### GC run (FleetDO + nestd)

| Transition | Actor | Guard | Effect | Ref |
|---|---|---|---|---|
| Register | FleetDO.place | any placement | `INSERT OR IGNORE sandboxes` (never clears `destroyed_ms`) | `fleet.ts:1197` |
| Unregister | SandboxDO.destroy → FleetDO | after `state := destroyed` | `destroyed_ms := now` | `sandbox.ts:507-520`, `fleet.ts:1597-1600` |
| Claim | burst host, hourly | host active burst; no unfinished run (runs older than W marked abandoned first); due (24 h since last mark, or requested) | insert run `marked_ms = T`, `dry_run = ¬∃ finished run of this version without "abandoned"/"error"`; then sequentially `gcRoots()` of every registry-live sandbox; any throw ends the run with `error` and returns nothing | `fleet.ts:1619-1652` |
| Mark | nestd | — | for each root: GET manifest, verify hash, parse; any failure aborts the pass before listing | `gc.rs:76-89` |
| Judge | nestd | — | ListObjectVersions under `chunks/`, `manifests/`; key doomed iff recognized ∧ unmarked ∧ `max LM < T − G` | `gc.rs:91-121` |
| Sweep | nestd | `¬dry_run`; first `max_deletes`; each delete only while host `now < T + W` | DeleteObject by version id | `gc.rs:122-160` |
| Report | nestd → FleetDO | run unfinished and same host | `finished_ms`, report | `fleet.ts:1654-1657` |

## Assumptions

- **Delivery:** host events are at-least-once from an in-memory outbox, resent on reconnect, **lost if nestd dies** (`crates/nestd/src/fleet.rs:5-16`, `:369`); `commit_result` rides FleetDO's reliable command channel (`fleet.ts:1139-1142`). SandboxDO calls are serialized per object.
- **S3:** strong read-after-write for PUT, HEAD and LIST ([AWS](https://aws.amazon.com/s3/consistency/)); versioning makes delete-by-version exact, so a version uploaded after the listing survives. `Last-Modified` of a multipart object is the initiation time (unverified; only manifests > 8 MiB go multipart).
- **Clocks:** `T` is FleetDO's clock, `LM` S3's, reuse and deadline checks the host's. Skew ≪ 1 h assumed (unverified).
- **A1 (commit latency):** every `commit_request` is first evaluated by SandboxDO less than `G − R = 12 h` after its `prepare`. Not enforced anywhere (see B1).
- Generations are never deleted at `edf6829` (no retention).

## Safety

Let `cl(m)` = `{manifests/m} ∪ {chunks/c | c ∈ m}`; `Live` = generations of sandboxes with `state ≠ destroyed`; `Pend` = prepared requests not yet evaluated, each with prepare time `v_q`.

- **S1 (no reachable object deleted):** for all `g ∈ Live`, every key in `cl(g)` has a current version in S3. Includes orphans: `gcRoots` reads all rows (`sandbox.ts:499`).
- **S2 (pending protected):** for all `q ∈ Pend` that will commit, every key in `cl(q)` survives until evaluation. Holds only under A1.
- **S3 (tree):** `head = null ∨ head ∈ generations`; for every non-orphan `g`, `g.parent = null ∨ g.parent ∈ generations`. Holds by construction (`:587-596`). Orphan parents are not checked (`:579-581`); they hold only because nestd sends a head it got from SandboxDO.
- **S4 (idempotent):** two evaluations of one `request` return equal outcomes and create at most one generation. Holds at `edf6829` because `commits` is never pruned; with pruning (#32) a main-chain re-ask after pruning meets the CAS ([Retention](#retention)).
- **S5 (complete roots or no run):** a non-dry pass deletes only if `gcRoots` succeeded for every registry-live sandbox and every root manifest parsed. Holds (`fleet.ts:1639-1646`, `gc.rs:76-89`). **Gap:** "registry ⊇ sandboxes with generations" holds only for sandboxes placed since the registry shipped; older ones need `registerSandboxes` (`fleet.ts:1603`).
- **S6 (destroyed):** a sandbox's objects are unprotected only after `state = destroyed` (`gcRoots` returns `[]`, `:497`); a destroyed sandbox is never re-placed (`:262`) or re-registered live (`INSERT OR IGNORE`, `fleet.ts:1197`), and `create` of an existing id is a no-op (`:177-178`).
- **S7 (dry first):** a non-dry pass needs a finished, non-error, non-abandoned run of the same `GC_MARK_VERSION`.

**Why S1/S2 hold (the core lemma).** A pass with mark `T` deletes key `k` only if `max LM(k) < T − G` at listing. A request prepared at `v_q` saw every key with `LM ≥ v_q − R` (or uploaded it). So `k ∈ cl(q)` is safe from that pass iff `T − G ≤ v_q − R`, i.e. `T ≤ v_q + (G − R)`. A pass with `T` after evaluation `c` has `q`'s generation in its roots (snapshot read after `T ≥ c`). A pass with `T ≤ c` is safe when `c < v_q + 12 h` (A1). The deadline `W` is not used in this argument: the cutoff is anchored at `T` (`gc.rs:97`), not at delete time. `W` is defence in depth.

## Liveness

- **L1:** an object not in `cl(Live ∪ Pend)` whose newest version is older than `T − G` is deleted by the first non-dry pass with mark `T` that finishes within `W`, given fairness: a burst S3 host claims at least daily, every live SandboxDO answers `gcRoots`, every root manifest is readable, and leftovers above the 10k cap go in later passes.
- **L1 is fragile:** one unreadable root manifest stops every pass forever (fail closed). S1 is a precondition of L1.

## Past bugs and the property that catches each

| Bug | Fix | Property |
|---|---|---|
| A timed-out commit re-sent with a stale parent → `parent_mismatch` → fence | `6d1586f`: re-ask under the same id | S4 plus the client model |
| Reuse window could exceed the grace | `6d1586f`: test `G > R` | lemma (`G − R > 0`) |
| A commit whose `kind` disagrees with `mem_manifest` | `e76fe31` (`sandbox.ts:568-571`) | restore well-formedness |
| `commits` and the registry grow forever; a destroyed sandbox re-registered by `create`; salvage authorized against a 50-entry history | `origin/deferred/retention-enums` (`fdf121d`, `dede063` L3, L6, M3), merged as #32 | S4 with pruning; S6; salvage acceptance |

## Bugs

**B1 (real, by code reading; medium confidence it triggers): no age bound between chunk verification and a commit's first evaluation.** `unanswered` is persisted before the send (`host.rs:2084`), survives restarts (`recovery.rs` `SentCommit`) and is re-sent with its original manifest, unbounded in time, before every later commit and every salvage retry (`host.rs:2052-2058`, `:1184-1203`); the outbox resends unacked events whenever it reconnects. SandboxDO checks no age (`sandbox.ts:552-598`). Interleaving: prepare at `v` reusing a chunk last uploaded at `v − 11 h`; the request is lost (crash, or a partition while STONITH is unconfirmed, so `info.epoch/host` don't move); a GC mark lands at `T > v + 12 h` and deletes the chunk (`LM < T − 24 h`); the re-sent request is then evaluated: committed as **head** (same epoch and host) or as an **orphan** (salvage). Broken: S1 and S2; the generation's restore fails, and as a root it makes every later pass fail closed (L1). Repro: unit test with the fake S3 (`s3.rs` tests, `age_all`): prepare, age the objects 25 h, run `gc::run` with no roots, then evaluate the saved request in a SandboxDO test and mark again; expect a missing root. Fix direction (not applied): carry `prepared_ms` and refuse a commit older than `G − R` minus a margin, or have nestd drop an `unanswered` older than that and prepare afresh. The retention branch makes it reachable more often: once an orphan's `commits` row is pruned, a late re-ask creates a second orphan from an old manifest.

**B2 (docs ahead of code at `edf6829`; closed by #85):** docs named one `isRestoreSource` predicate, `deleting` generations, retention and pins before any existed.

**B3 (low):** orphans accepted after destroy and with an unchecked parent (`sandbox.ts:575-584`). Harmless to GC. It does break S3 if nestd ever sends a foreign parent, for example a fork's head from another sandbox (`host.rs:1849-1872`).

**B4 (low, fixed in #32 by the full `epochs` table):** a salvage from an epoch older than the last 50 placements is refused `stale_epoch` (`sandbox.ts:94`, `:576-578`), which nestd takes as final (`host.rs:2216-2218`), so the work is dropped and only logged.

## Modelling notes

- **Abstraction:** keys are atoms; a manifest is a finite set of keys; S3 is a map `key → set (vid, LM)`; time is discrete with `R < G`. Sandboxes 2, generations 3 per sandbox, keys 4, one concurrent GC run plus one late host. Model the outbox as a bag with loss on crash and duplication.
- **Actions:** `Prepare(q)` (touch or upload `cl(q)` at `now`), `Send/Resend(q)`, `Evaluate(q)` (the commit table), `Destroy(s)`, `Claim(T)` (snapshot per sandbox, interleavable with `Evaluate`), `List`, `Delete(k, vid)` (guarded `now < T + W`), `Tick`, `CrashHost` (drops the outbox, keeps `unanswered`).

| Action | Code |
|---|---|
| Prepare | `storage.rs:118-163`, `s3.rs:312-326`, `:475-507` |
| Send / Resend | `host.rs:2076-2121`, `:2052-2058`; `fleet.rs:291` |
| Evaluate | `decideCommit`, `SandboxDO.commit` |
| Destroy | `sandbox.ts:507-520`, `fleet.ts:1597` |
| Claim | `fleet.ts:1619-1652`, `sandbox.ts:496-505` |
| List / Judge / Delete | `gc.rs:91-160` |

- **Candidate inductive invariant (for a Lean 4 pilot).** With `prot_r(k)` = "run `r` will not delete every present version of `k`":
  1. `∀ g ∈ Live, ∀ k ∈ cl(g): present(k)`.
  2. `∀ q ∈ Pend, ∀ k ∈ cl(q): ∃ (vid, LM) ∈ S3[k], LM ≥ v_q − R` and `now < v_q + (G − R)` (A1 as a state predicate; `Tick` is enabled only while it holds, or prove the weaker theorem with A1 as a hypothesis).
  3. `∀ r` in flight: `doomed_r ⊆ {(k, vid) | k ∉ cl(Roots_r) ∧ maxLM_list(k) < T_r − G}`, and `∀ s ∈ snapshot_r: Roots_r ⊇ cl(gens(s) at read_r(s))`, and `T_r ≤ now`.
  4. `∀ r, ∀ g ∈ Live \ Roots_r`: `g` was evaluated after `read_r(s)`, from a `q` with `T_r ≤ v_q + (G − R)`.

  Then 1 is preserved by `Delete` (from 3 and 4 with the lemma), by `Evaluate` (from 2) and by `Claim` (snapshots only grow coverage). 2 is preserved by `Delete` because the witnessing version has `LM ≥ v_q − R ≥ T_r − G`, so it is not doomed. The theorem: invariant ∧ A1 ⇒ S1 ∧ S2. Dropping A1 gives the B1 counterexample.

## Runtime assertions and tests to add now

- SandboxDO: a committed or orphaned generation's `parent` exists in `generations`, or is null. Refuse an orphan when `state = destroyed`.
- nestd: log or refuse re-sending an `unanswered` older than `G − R − 1 h`. A test: restart with an old `unanswered`.
- GC: a test that an object reused at `R − ε` and committed `ε'` later survives a pass marked at the worst `T`; plus a test documenting the B1 counterexample.
- FleetDO: `gcClaim` asserts `live` ⊇ every sandbox with a lease; a test that a sandbox registered during root collection is protected by the reuse rule.

## Retention

Checked on branch `build/retention` (2026-11-01, on main `180f46a`; merged as #85). Code: `control-plane/src/lib/retention.ts` (pure) and `src/do/sandbox.ts`. Model: [`verification/lean/Nest/Retention.lean`](../../../verification/lean/Nest/Retention.lean), the GC model above with `deleting`, pins and a guarded `retire`.

**Proved (Lean, unbounded, under A1):**

| Theorem | Says |
|---|---|
| `Retention.safe` | every key of every generation that isn't `deleting` is present; so is every key of every eligible pending request; the head and every pinned generation are never `deleting` |
| `Retention.source_present` | GC and retention never delete a restore source's keys |
| `Retention.load_never_deleting` | what a placement loads (the head, or a pinned generation) is a restore source, never `deleting` |
| `Retention.unguarded_unsafe` | **mutation:** without retention's guard (it may mark the head), a 7-step trace deletes the head's chunk |
| `Retention.retention_not_vacuous` | with the guard, a dropped generation's own chunk is deleted and the head's survives |

Mutations of the proof: dropping the `pins` half of the guard breaks the `pins` clause (build fails); a pass that marks nothing breaks `cover`.

**Conformance map (by hand):**

| Model | Code | Conforms |
|---|---|---|
| `World.deleting`, one-way (only `retire` adds) | `generations.state = 'deleting'`, set only by `runRetention` (`sandbox.ts:674`) with `AND state IS NULL`; nothing clears it | yes |
| `Step.retire g`, guard `head ≠ g ∧ g ∉ pins` | `runRetention` marks `retention(...).drop` (`retention.ts:140`), which excludes every `isRestoreSource` generation (`retention.ts:95`); read and marked in one synchronous step, no await | yes; the code's guard is stronger (tiers, turn ends, orphan heads) |
| `Step.claim T` marks `liveKeys` | `SandboxDO.gcRoots` → `gcRootsOf` (`sandbox.ts:541`, `retention.ts:185`) skips `deleting` rows and memory marked unrooted, from durable marks only; FleetDO snapshots after inserting the run (`fleet.ts:2234`) | partly: the model doesn't split memory out (below) |
| `Step.pin`: pins the head | `placeCurrentEpoch` reads the source with `restoreSource` and records `restore_pin` in the claim's `decide` (`sandbox.ts:353-356`), before any await | yes |
| `Step.unpin` (any time) | `livePins` (`retention.ts:108`) ends the pin on running, suspend, failure, destroy or a newer epoch | yes (the model allows more) |
| a placement loads the head or a pin | `restoreSource` (`sandbox.ts:653`) checks `isRestoreSource` and refuses otherwise; used by `placeCurrentEpoch` and `createBody` (`:575`) | yes |
| new generations are never `deleting` (`fresh`) | a commit inserts a row with `state` null under a fresh random id | yes, assuming ids don't collide |
| `commits` never pruned (the model's `idempotent`) | a main-chain `deleting` row and its commit record are pruned a week after marking; an orphan's row and record never are | partly: a main-chain re-ask after pruning meets the compare-and-set (parent mismatch), as before retention; a salvage, which has no parent check, always finds its first answer |

**Mapped by hand, not modelled:**
- **Memory unrooting:** the model's `Gen.keys` covers both manifests. The code marks the memory of a ready generation that isn't a restore source unrooted (`memoryToUnroot`, `retention.ts:175`; one-way `mem_unrooted_ms`), and roots follow the mark in every mode. Safe because only a restore source's memory is loaded (the restore rule) and a generation that stops being a restore source never becomes one again; the latter, and "every restore source's manifests are roots", are property-tested (`test/retention-core.test.ts`, 60 seeded walks with pruning), not proved.
- **Orphan heads:** not restore sources in the model (it may retire any orphan). The code keeps an orphan branch's head 30 days; that only keeps more. Orphan rows are never pruned, so the set of orphan parents only grows.
- **Mode switches:** roots don't read the mode. The dry run after switching on is FleetDO's `retention_on_ms` (`fleet.ts:2234`); a window where SandboxDOs see `on` before FleetDO does can skip it (dev/deploy.md, unverified).
- **Rollback:** a previous release ignores `state` and `mem_unrooted_ms` and roots every row and memory manifest. If GC has already swept one, that release's passes fail closed (a missing root manifest stops the pass before any delete): no loss, GC stalls until the roll forward. It never restores a `deleting` generation: it restores only the head.

**Tests that fail without each guard** (mutation-checked, vitest, 2026-11-01): dropping the pin clause, the head clause, the `deleting` check in the predicate or in `gcRootsOf`, the turn-end keep, the orphan-parent check, the claim's pin, the placement's predicate check, the pin's end, `memoryToUnroot`'s restore-source check, `gcRootsOf`'s unrooted-memory check, the orphan-row exception to pruning, and either half of FleetDO's `retention_on_ms` rule.

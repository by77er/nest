import Nest.Gc

/-!
# Generation retention: GC never deletes a restore source

`Nest.Gc` with retention added: generations can be marked `deleting` (one-way), a GC pass marks only
the generations that aren't, and in-flight claims pin generations by id. The theorem: under A1,
every key of every generation that isn't `deleting` is present, the head and every pinned
generation are never `deleting` (so a resume, which loads only a restore source, never loads a
`deleting` generation), and so every restore source's keys are present. Without the guard on
`retire` (retention marking a restore source), a concrete trace deletes the head's chunk.

| Model | Code (`control-plane/`) |
|---|---|
| `World.deleting`: ids with `state = 'deleting'` | `generations.state`, `src/do/sandbox.ts` `runRetention` |
| `World.pins`: ids pinned by in-flight claims | `SandboxInfo.restore_pin`, `livePins` in `src/lib/retention.ts` |
| `Source`: not deleting, and the head or pinned | `isRestoreSource` (`src/lib/retention.ts`), less the orphan-head clause |
| `Step.retire g`, guarded by `¬ Source` | `runRetention` marks only `retention(...).drop`, which excludes every restore source |
| `Step.claim T`: marks `liveKeys` (generations not `deleting`) | `gcRootsOf` via `SandboxDO.gcRoots`, `FleetDO.gcClaim` |
| `Step.pin`: a claim pins the head | `placeCurrentEpoch`: the source is the head, pinned in the claim's step |
| `Step.unpin`: any pins end | `livePins`: the restore ran, failed, or a newer epoch was claimed |
| everything else | as in `Nest.Gc` |

Over-approximations, on top of `Nest.Gc`'s: `retire` may mark any recorded generation that isn't a
restore source, at any time (the code marks only what the tiers, the turn-end bound and orphan expiry
drop, so the theorem holds for any retention policy); pins may end at any time; orphan branch heads
are not restore sources in the model (the code keeps them 30 days, which only keeps more); `deleting`
rows are never pruned (the code prunes main-chain ones a week after marking, which removes no live generation's keys, and never an orphan's).

Not modelled: memory manifests. `Gen.keys` is the closure of both manifests, so the model roots a
kept checkpoint's memory; the code unroots the memory of a ready generation that isn't a restore
source. That is safe because only a restore source's memory is ever loaded (the restore rule loads
memory only with its head) and a generation that stops being a restore source never becomes one
again; the second is property-tested (`control-plane/test/retention-core.test.ts`, random
histories), not proved here.
-/

namespace Nest.Retention

open Nest.CommitChain Nest.Gc

structure World where
  w : Gc.World
  deleting : List Nat
  pins : List Nat

def World.init : World := { w := Gc.World.init, deleting := [], pins := [] }

/-- The keys a GC pass marks: every generation not marked `deleting`. -/
def liveKeys (gens : List Gen) (deleting : List Nat) : List Nat :=
  (gens.filter (fun g => !(deleting.contains g.id))).flatMap (·.keys)

/-- A restore source (`isRestoreSource` without the orphan-head clause). -/
def Source (x : World) (id : Nat) : Prop := id ∉ x.deleting ∧ (x.w.sb.head = some id ∨ id ∈ x.pins)

/-- The steps. `guarded = false` drops retention's guard (a mutation: retention may mark a restore
source). Evaluation is always under A1. -/
inductive Step (R G : Nat) (guarded : Bool) : World → World → Prop
  | prepare (x : World) (req : Request) (host : Nat) :
      Step R G guarded x { x with w := { x.w with store := reuse R x.w.store req.keys x.w.now,
                                                  pend := ⟨req, host, x.w.now⟩ :: x.w.pend } }
  | evaluate (x : World) (q : Pending) (hq : q ∈ x.w.pend)
      (ha1 : x.w.sb.commits.lookup q.req.request = none → x.w.now + R < q.v + G) :
      Step R G guarded x { x with w := { x.w with sb := (commit x.w.sb q.host q.req).1 } }
  | drop (x : World) (pend : List Pending) (h : ∀ q ∈ pend, q ∈ x.w.pend) :
      Step R G guarded x { x with w := { x.w with pend } }
  | place (x : World) (e : Nat) (h : Option Nat) (hist : List (Nat × Nat)) :
      Step R G guarded x { x with w := { x.w with sb := { x.w.sb with epoch := e, host := h, history := hist } } }
  | claim (x : World) (T : Nat) (hT : T ≤ x.w.now) :
      Step R G guarded x { x with w := { x.w with runs := ⟨T, liveKeys x.w.sb.gens x.deleting⟩ :: x.w.runs } }
  | delete (x : World) (r : Run) (hr : r ∈ x.w.runs) (k t : Nat) (hk : k ∉ r.marked)
      (ht : x.w.store k = some t) (hcut : t + G < r.T) :
      Step R G guarded x { x with w := { x.w with store := fun k' => if k' = k then none else x.w.store k' } }
  | put (x : World) (k : Nat) :
      Step R G guarded x { x with w := { x.w with store := fun k' => if k' = k then some x.w.now else x.w.store k' } }
  | tick (x : World) (d : Nat) : Step R G guarded x { x with w := { x.w with now := x.w.now + d } }
  | pin (x : World) (id : Nat) (h : x.w.sb.head = some id) : Step R G guarded x { x with pins := id :: x.pins }
  | unpin (x : World) (pins : List Nat) (h : ∀ p ∈ pins, p ∈ x.pins) : Step R G guarded x { x with pins }
  | retire (x : World) (g : Gen) (hg : g ∈ x.w.sb.gens)
      (hs : guarded = true → x.w.sb.head ≠ some g.id ∧ g.id ∉ x.pins) :
      Step R G guarded x { x with deleting := g.id :: x.deleting }

inductive Reachable (R G : Nat) (guarded : Bool) : World → Prop
  | init : Reachable R G guarded World.init
  | step {x x' : World} : Reachable R G guarded x → Step R G guarded x x' → Reachable R G guarded x'

/-- **The safety property.** -/
def Safe (R G : Nat) (x : World) : Prop :=
  (∀ g ∈ x.w.sb.gens, g.id ∉ x.deleting → ∀ k ∈ g.keys, ∃ t, x.w.store k = some t) ∧
  (∀ q ∈ x.w.pend, Eligible R G x.w q → ∀ k ∈ q.req.keys, ∃ t, x.w.store k = some t) ∧
  (∀ id, x.w.sb.head = some id → id ∉ x.deleting) ∧
  (∀ id ∈ x.pins, id ∉ x.deleting)

/-! ### What a commit does to the fields retention reads -/

theorem commit_shape (s : State) (host : Nat) (ev : Request) :
    ((commit s host ev).1.gens = s.gens ∧ (commit s host ev).1.head = s.head ∧
      (commit s host ev).1.next = s.next) ∨
    (s.commits.lookup ev.request = none ∧ (commit s host ev).1.gens = record s ev true :: s.gens ∧
      (commit s host ev).1.head = s.head ∧ (commit s host ev).1.next = s.next + 1) ∨
    (s.commits.lookup ev.request = none ∧ (commit s host ev).1.gens = record s ev false :: s.gens ∧
      (commit s host ev).1.head = some s.next ∧ (commit s host ev).1.next = s.next + 1) := by
  have he := commit_effect s host ev
  generalize commit s host ev = p at he ⊢
  cases he with
  | replay => exact .inl ⟨rfl, rfl, rfl⟩
  | reject => exact .inl ⟨rfl, rfl, rfl⟩
  | orphan h => exact .inr (.inl ⟨h, rfl, rfl, rfl⟩)
  | commit h => exact .inr (.inr ⟨h, rfl, rfl, rfl⟩)

/-! ### The inductive invariant -/

structure Inv (R G : Nat) (x : World) : Prop where
  past : ∀ k t, x.w.store k = some t → t ≤ x.w.now
  live : ∀ g ∈ x.w.sb.gens, g.id ∉ x.deleting → ∀ k ∈ g.keys, ∃ t, x.w.store k = some t
  pend : ∀ q ∈ x.w.pend, Eligible R G x.w q → ∀ k ∈ q.req.keys, ∃ t, x.w.store k = some t ∧ q.v ≤ t + R
  runs : ∀ r ∈ x.w.runs, r.T ≤ x.w.now
  cover : ∀ r ∈ x.w.runs, ∀ g ∈ x.w.sb.gens, g.id ∉ x.deleting → ∀ k ∈ g.keys,
    k ∈ r.marked ∨ ∃ t, x.w.store k = some t ∧ r.T ≤ t + G
  /-- Recorded ids are below the counter, and so are `deleting` ones: a new generation is never `deleting`. -/
  ids : ∀ g ∈ x.w.sb.gens, g.id < x.w.sb.next
  fresh : ∀ id ∈ x.deleting, id < x.w.sb.next
  head : ∀ id, x.w.sb.head = some id → id ∉ x.deleting
  pins : ∀ id ∈ x.pins, id ∉ x.deleting

theorem inv_init (R G : Nat) : Inv R G World.init := by
  constructor <;> simp [World.init, Gc.World.init, CommitChain.State.init]

/-- The store changed in a way that keeps every present key present and no younger. -/
theorem inv_grows {R G : Nat} {x : World} (hi : Inv R G x) {st' : Nat → Option Nat}
    (hg : Grows x.w.store st') (hp : ∀ k t, st' k = some t → t ≤ x.w.now) :
    Inv R G { x with w := { x.w with store := st' } } where
  past := hp
  live := by
    intro g hgm hd k hk
    obtain ⟨t, ht⟩ := hi.live g hgm hd k hk
    obtain ⟨t', ht', _⟩ := hg k t ht
    exact ⟨t', ht'⟩
  pend := by
    intro q hq he k hk
    obtain ⟨t, ht, hv⟩ := hi.pend q hq he k hk
    obtain ⟨t', ht', hle⟩ := hg k t ht
    exact ⟨t', ht', by omega⟩
  runs := hi.runs
  cover := by
    intro r hr g hgm hd k hk
    rcases hi.cover r hr g hgm hd k hk with hm | ⟨t, ht, hT⟩
    · exact .inl hm
    · obtain ⟨t', ht', hle⟩ := hg k t ht
      exact .inr ⟨t', ht', by omega⟩
  ids := hi.ids
  fresh := hi.fresh
  head := hi.head
  pins := hi.pins

/-- **The core lemma.** A pass never deletes a key of a generation that isn't `deleting`, or of an
eligible pending request. -/
theorem delete_spares {R G : Nat} {x : World} (hi : Inv R G x) {r : Run} (hr : r ∈ x.w.runs)
    {k t : Nat} (hk : k ∉ r.marked) (ht : x.w.store k = some t) (hcut : t + G < r.T) :
    (∀ g ∈ x.w.sb.gens, g.id ∉ x.deleting → k ∉ g.keys) ∧
    (∀ q ∈ x.w.pend, Eligible R G x.w q → k ∉ q.req.keys) := by
  constructor
  · intro g hg hd hkg
    rcases hi.cover r hr g hg hd k hkg with hm | ⟨t', ht', hT⟩
    · exact hk hm
    · rw [ht] at ht'; cases ht'; omega
  · intro q hq he hkq
    obtain ⟨t', ht', hv⟩ := hi.pend q hq he k hkq
    rw [ht] at ht'; cases ht'
    have := hi.runs r hr
    unfold Eligible at he
    omega

/-- A key of the new generation a commit records is present and young enough for every pass. -/
theorem new_gen_keys {R G : Nat} {x : World} (hi : Inv R G x) {q : Pending} (hq : q ∈ x.w.pend)
    (ha : x.w.now + R < q.v + G) {k : Nat} (hk : k ∈ q.req.keys) :
    (∃ t, x.w.store k = some t) ∧ ∀ r ∈ x.w.runs, ∃ t, x.w.store k = some t ∧ r.T ≤ t + G := by
  obtain ⟨t, ht, hv⟩ := hi.pend q hq ha k hk
  refine ⟨⟨t, ht⟩, fun r hr => ⟨t, ht, ?_⟩⟩
  have := hi.runs r hr
  omega

theorem inv_step {R G : Nat} {x x' : World} (hi : Inv R G x) (hs : Step R G true x x') :
    Inv R G x' := by
  cases hs with
  | prepare req host =>
    have hg := reuse_grows (R := R) (keys := req.keys) hi.past
    have hp := reuse_past (R := R) (keys := req.keys) hi.past
    have h1 := inv_grows hi hg hp
    refine ⟨h1.past, h1.live, ?_, h1.runs, h1.cover, h1.ids, h1.fresh, h1.head, h1.pins⟩
    intro q hq he k hk
    simp only [List.mem_cons] at hq
    rcases hq with rfl | hq
    · exact reuse_young hk
    · exact h1.pend q hq he k hk
  | evaluate q hq ha1 =>
    rcases commit_shape x.w.sb q.host q.req with ⟨hgs, hh, hn⟩ | ⟨hl, hgs, hh, hn⟩ | ⟨hl, hgs, hh, hn⟩
    · refine ⟨hi.past, ?_, hi.pend, hi.runs, ?_, ?_, ?_, ?_, hi.pins⟩
      · intro g hg; rw [hgs] at hg; exact hi.live g hg
      · intro r hr g hg; rw [hgs] at hg; exact hi.cover r hr g hg
      · intro g hg; rw [hgs] at hg; rw [hn]; exact hi.ids g hg
      · intro id hid; rw [hn]; exact hi.fresh id hid
      · intro id h; rw [hh] at h; exact hi.head id h
    all_goals
      have ha := ha1 hl
      have hnd : x.w.sb.next ∉ x.deleting := fun h => Nat.lt_irrefl _ (hi.fresh _ h)
      refine ⟨hi.past, ?_, hi.pend, hi.runs, ?_, ?_, ?_, ?_, hi.pins⟩
      · intro g hg hd k hk
        rw [hgs] at hg
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · exact (new_gen_keys hi hq ha hk).1
        · exact hi.live g hg hd k hk
      · intro r hr g hg hd k hk
        rw [hgs] at hg
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · exact .inr ((new_gen_keys hi hq ha hk).2 r hr)
        · exact hi.cover r hr g hg hd k hk
      · intro g hg
        rw [hgs] at hg; rw [hn]
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · exact Nat.lt_succ_self _
        · exact Nat.lt_succ_of_lt (hi.ids g hg)
      · intro id hid; rw [hn]; exact Nat.lt_succ_of_lt (hi.fresh id hid)
    · intro id h; rw [hh] at h; exact hi.head id h
    · intro id h; rw [hh] at h; cases h; exact hnd
  | drop pend h =>
    exact ⟨hi.past, hi.live, fun q hq => hi.pend q (h q hq), hi.runs, hi.cover, hi.ids, hi.fresh, hi.head, hi.pins⟩
  | place =>
    exact ⟨hi.past, hi.live, hi.pend, hi.runs, hi.cover, hi.ids, hi.fresh, hi.head, hi.pins⟩
  | claim T hT =>
    refine ⟨hi.past, hi.live, hi.pend, ?_, ?_, hi.ids, hi.fresh, hi.head, hi.pins⟩
    · intro r hr
      simp only [List.mem_cons] at hr
      rcases hr with rfl | hr
      · exact hT
      · exact hi.runs r hr
    · intro r hr g hg hd k hk
      simp only [List.mem_cons] at hr
      rcases hr with rfl | hr
      · refine .inl (List.mem_flatMap.mpr ⟨g, List.mem_filter.mpr ⟨hg, ?_⟩, hk⟩)
        simpa using hd
      · exact hi.cover r hr g hg hd k hk
  | delete r hr k t hk ht hcut =>
    obtain ⟨hlive, hpend⟩ := delete_spares hi hr hk ht hcut
    refine ⟨?_, ?_, ?_, hi.runs, ?_, hi.ids, hi.fresh, hi.head, hi.pins⟩
    · intro k' t' h'
      by_cases e : k' = k
      · simp [e] at h'
      · simp only [e, if_false] at h'; exact hi.past k' t' h'
    · intro g hg hd k' hk'
      have e : k' ≠ k := fun e => hlive g hg hd (e ▸ hk')
      simp only [e, if_false]; exact hi.live g hg hd k' hk'
    · intro q hq he k' hk'
      have e : k' ≠ k := fun e => hpend q hq he (e ▸ hk')
      simp only [e, if_false]; exact hi.pend q hq he k' hk'
    · intro r' hr' g hg hd k' hk'
      have e : k' ≠ k := fun e => hlive g hg hd (e ▸ hk')
      simp only [e, if_false]; exact hi.cover r' hr' g hg hd k' hk'
  | put k =>
    apply inv_grows hi
    · intro k' t h'
      by_cases e : k' = k
      · subst e; exact ⟨x.w.now, by simp, hi.past k' t h'⟩
      · exact ⟨t, by simp [e, h'], Nat.le_refl t⟩
    · intro k' t h'
      by_cases e : k' = k
      · simp [e] at h'; omega
      · simp only [e, if_false] at h'; exact hi.past k' t h'
  | tick d =>
    refine ⟨?_, hi.live, ?_, ?_, hi.cover, hi.ids, hi.fresh, hi.head, hi.pins⟩
    · intro k t h; have := hi.past k t h; dsimp only; omega
    · intro q hq he k hk
      have he' : Eligible R G x.w q := by unfold Eligible at he ⊢; dsimp only at he; omega
      exact hi.pend q hq he' k hk
    · intro r hr; have := hi.runs r hr; dsimp only; omega
  | pin id h =>
    refine ⟨hi.past, hi.live, hi.pend, hi.runs, hi.cover, hi.ids, hi.fresh, hi.head, ?_⟩
    intro p hp
    simp only [List.mem_cons] at hp
    rcases hp with rfl | hp
    · exact hi.head p h
    · exact hi.pins p hp
  | unpin pins h =>
    exact ⟨hi.past, hi.live, hi.pend, hi.runs, hi.cover, hi.ids, hi.fresh, hi.head, fun p hp => hi.pins p (h p hp)⟩
  | retire g hg hs =>
    obtain ⟨hnh, hnp⟩ := hs rfl
    have notIn : ∀ {id}, id ∉ g.id :: x.deleting → id ∉ x.deleting := fun h h' => h (List.mem_cons_of_mem _ h')
    refine ⟨hi.past, fun g' hg' hd => hi.live g' hg' (notIn hd), hi.pend, hi.runs,
      fun r hr g' hg' hd => hi.cover r hr g' hg' (notIn hd), hi.ids, ?_, ?_, ?_⟩
    · intro id hid
      simp only [List.mem_cons] at hid
      rcases hid with rfl | hid
      · exact hi.ids g hg
      · exact hi.fresh id hid
    · intro id h hd
      simp only [List.mem_cons] at hd
      rcases hd with rfl | hd
      · exact hnh h
      · exact hi.head id h hd
    · intro p hp hd
      simp only [List.mem_cons] at hd
      rcases hd with rfl | hd
      · exact hnp hp
      · exact hi.pins p hp hd

theorem inv_reachable {R G : Nat} {x : World} (h : Reachable R G true x) : Inv R G x := by
  induction h with
  | init => exact inv_init R G
  | step _ hs ih => exact inv_step ih hs

/-- **Retention safety under A1.** Every key of every generation that isn't `deleting` is present,
so is every key of every eligible pending request, and the head and every pinned generation are
never `deleting`. -/
theorem safe (R G : Nat) {x : World} (h : Reachable R G true x) : Safe R G x := by
  have hi := inv_reachable h
  exact ⟨hi.live, fun q hq he k hk => (hi.pend q hq he k hk).elim fun t ht => ⟨t, ht.1⟩, hi.head, hi.pins⟩

/-- **GC and retention never delete a restore source:** every key of a restore source is present. -/
theorem source_present (R G : Nat) {x : World} (h : Reachable R G true x) {g : Gen}
    (hg : g ∈ x.w.sb.gens) (hs : Source x g.id) : ∀ k ∈ g.keys, ∃ t, x.w.store k = some t :=
  (inv_reachable h).live g hg hs.1

/-- **A resume never loads a `deleting` generation:** what a placement loads is the head or a pinned
generation, and neither is ever `deleting`. -/
theorem load_never_deleting (R G : Nat) {x : World} (h : Reachable R G true x) {id : Nat}
    (hl : x.w.sb.head = some id ∨ id ∈ x.pins) : Source x id := by
  have hi := inv_reachable h
  rcases hl with hh | hp
  · exact ⟨hi.head id hh, .inl hh⟩
  · exact ⟨hi.pins id hp, .inr hp⟩

/-! ### Without retention's guard the theorem fails

Place at epoch 1 on host 7; at hour 0 prepare and commit a generation with chunk 5 (it becomes
head, id 0); retention marks the head `deleting` (the guard dropped); 25 hours later a pass marks
no generation and deletes chunk 5. The head names a deleted chunk. -/

def req0 : Request :=
  { request := 1, epoch := 1, parent := none, checkpoint := false, hasMem := false, salvage := false, keys := [5] }

def x1 : World := { World.init with w := { World.init.w with sb := { World.init.w.sb with epoch := 1, host := some 7, history := [(1, 7)] } } }
def x2 : World := { x1 with w := { x1.w with store := reuse 12 x1.w.store req0.keys x1.w.now, pend := [⟨req0, 7, 0⟩] } }
def x3 : World := { x2 with w := { x2.w with sb := (commit x2.w.sb 7 req0).1 } }
def x4 : World := { x3 with deleting := 0 :: x3.deleting }
def x5 : World := { x4 with w := { x4.w with now := x4.w.now + 25 } }
def x6 : World := { x5 with w := { x5.w with runs := ⟨25, liveKeys x5.w.sb.gens x5.deleting⟩ :: x5.w.runs } }
def x7 : World := { x6 with w := { x6.w with store := fun k' => if k' = 5 then none else x6.w.store k' } }

theorem unguarded_reachable : Reachable 12 24 false x7 := by
  have r1 : Reachable 12 24 false x1 := .step .init (.place _ 1 (some 7) [(1, 7)])
  have r2 : Reachable 12 24 false x2 := .step r1 (.prepare x1 req0 7)
  have r3 : Reachable 12 24 false x3 := .step r2 (.evaluate x2 ⟨req0, 7, 0⟩ (by decide) (fun _ => by decide))
  have r4 : Reachable 12 24 false x4 := .step r3 (.retire x3 ⟨0, none, 1, false, [5]⟩ (by decide) (fun h => by cases h))
  have r5 : Reachable 12 24 false x5 := .step r4 (.tick x4 25)
  have r6 : Reachable 12 24 false x6 := .step r5 (.claim x5 25 (by decide))
  exact .step r6 (.delete x6 ⟨25, []⟩ (by decide) 5 0 (by decide) (by decide) (by decide))

/-- **Mutation: retention marks the head.** A reachable state's head names a deleted chunk. -/
theorem unguarded_unsafe : Reachable 12 24 false x7 ∧ x7.w.sb.head = some 0 ∧
    x7.w.sb.gens = [⟨0, none, 1, false, [5]⟩] ∧ x7.w.store 5 = none ∧ ¬ Safe 12 24 x7 := by
  refine ⟨unguarded_reachable, by decide, by decide, by decide, ?_⟩
  intro ⟨_, _, hhead, _⟩
  exact hhead 0 (by decide) (by decide)

/-! ### The guarded model is not vacuous

Two generations: 0 (chunk 5) and then 1 (chunk 6), which becomes head. Retention marks 0 `deleting`
(not head, not pinned), and a pass 25 hours later deletes chunk 5, while chunk 6 survives. -/

def req1 : Request :=
  { request := 2, epoch := 1, parent := some 0, checkpoint := false, hasMem := false, salvage := false, keys := [6] }

def y4 : World := { x3 with w := { x3.w with store := reuse 12 x3.w.store req1.keys x3.w.now, pend := ⟨req1, 7, 0⟩ :: x3.w.pend } }
def y5 : World := { y4 with w := { y4.w with sb := (commit y4.w.sb 7 req1).1 } }
def y6 : World := { y5 with deleting := 0 :: y5.deleting }
def y7 : World := { y6 with w := { y6.w with now := y6.w.now + 25 } }
def y8 : World := { y7 with w := { y7.w with runs := ⟨25, liveKeys y7.w.sb.gens y7.deleting⟩ :: y7.w.runs } }
def y9 : World := { y8 with w := { y8.w with store := fun k' => if k' = 5 then none else y8.w.store k' } }

theorem retention_not_vacuous : Reachable 12 24 true y9 ∧ y9.w.sb.head = some 1 ∧ 0 ∈ y9.deleting ∧
    y9.w.store 5 = none ∧ y9.w.store 6 = some 0 := by
  have r1 : Reachable 12 24 true x1 := .step .init (.place _ 1 (some 7) [(1, 7)])
  have r2 : Reachable 12 24 true x2 := .step r1 (.prepare x1 req0 7)
  have r3 : Reachable 12 24 true x3 := .step r2 (.evaluate x2 ⟨req0, 7, 0⟩ (by decide) (fun _ => by decide))
  have r4 : Reachable 12 24 true y4 := .step r3 (.prepare x3 req1 7)
  have r5 : Reachable 12 24 true y5 := .step r4 (.evaluate y4 ⟨req1, 7, 0⟩ (by decide) (fun _ => by decide))
  have r6 : Reachable 12 24 true y6 :=
    .step r5 (.retire y5 ⟨0, none, 1, false, [5]⟩ (by decide) (fun _ => ⟨by decide, by decide⟩))
  have r7 : Reachable 12 24 true y7 := .step r6 (.tick y6 25)
  have r8 : Reachable 12 24 true y8 := .step r7 (.claim y7 25 (by decide))
  have r9 : Reachable 12 24 true y9 :=
    .step r8 (.delete y8 ⟨25, [6]⟩ (by decide) 5 0 (by decide) (by decide) (by decide))
  exact ⟨r9, by decide, by decide, by decide, by decide⟩

end Nest.Retention

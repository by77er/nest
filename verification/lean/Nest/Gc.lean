import Nest.CommitChain

/-!
# Object-store GC safety

One sandbox, its S3 objects and any number of GC passes, with evaluation done by the real
`CommitChain.commit`. The theorem: under A1, no key reachable from a recorded generation or from
a pending commit that may still be evaluated is ever deleted. Without A1, a concrete trace
deletes a chunk that a later commit makes head (bug B1).

| Model | Code |
|---|---|
| `store k = some t`: key `k` has versions, the newest with Last-Modified `t` | S3 versioned bucket |
| `reuse`: at prepare time `v`, keep `k` if `v < t + R`, else re-PUT (`t := v`) | `s3.rs:312-326`, `:475-507` |
| `Step.prepare`: chunk, reuse or upload, emit a request stamped `v := now` | `host.rs:2124-2148`, `storage.rs:118-163` |
| `Step.evaluate`: `SandboxDO.commit`; may repeat (re-sends, outbox duplicates) | `sandbox.ts:552-613`, `host.rs:2052-2058` |
| `Step.drop`: a request is answered or lost for good | `host.rs:2108-2111` |
| `Step.claim T`: a pass marked at `T ≤ now`, marking every recorded generation's keys | `fleet.ts:1619-1652`, `sandbox.ts:496-505`, `gc.rs:76-89` |
| `Step.delete`: a pass deletes unmarked `k` with newest `t < T − G` | `gc.rs:91-160` |
| `Step.put`: anything else re-uploads a key (other sandboxes share chunks) | `s3.rs:475-482` |
| `Step.tick`, `Step.place` | clocks; placement (`CommitChain.Step.place`) |

Over-approximations (the real system has fewer behaviours, so safety carries over): any number of
concurrent passes; a pass never ends and has no deadline `W`; root reads that would abort the
pass are ignored; the mark `T` may be any time up to the read (the real read happens after the
mark, so a real pass marks a superset of what the model's does); `put` re-uploads any key at any
time; placement sets epoch, host and history to anything.

Abstractions: one sandbox, never destroyed (S6 is out of scope); one clock (no skew); a key's
versions collapse to the newest Last-Modified (a pass deletes exactly the versions it listed, so
a key re-uploaded after the listing keeps a version with `LM ≥ T`, which the model's judge also
spares); the reuse memo in `s3.rs` is folded into "present and young", which is equivalent while
safety holds (a memo entry younger than `R` means `LM > now − R > T − G`, so no pass has deleted
the key since).
-/

namespace Nest.Gc

open Nest.CommitChain

/-- A prepared `commit_request` waiting to be (re-)evaluated, with its prepare time. -/
structure Pending where
  req : Request
  host : Nat
  v : Nat
  deriving DecidableEq, Repr

/-- A GC pass: its mark `T` and the keys it marked (the closure of its roots). -/
structure Run where
  T : Nat
  marked : List Nat
  deriving DecidableEq, Repr

structure World where
  sb : CommitChain.State
  store : Nat → Option Nat
  pend : List Pending
  runs : List Run
  now : Nat

def World.init : World :=
  { sb := CommitChain.State.init, store := fun _ => none, pend := [], runs := [], now := 0 }

/-- Every key of every recorded generation, orphans included (`gcRoots` reads every row). -/
def allKeys (gens : List Gen) : List Nat := gens.flatMap (·.keys)

/-- The store after preparing `keys` at time `now`: reuse what is younger than `R`, re-PUT the rest. -/
def reuse (R : Nat) (st : Nat → Option Nat) (keys : List Nat) (now : Nat) : Nat → Option Nat :=
  fun k =>
    if k ∈ keys then
      match st k with
      | some t => if now < t + R then some t else some now
      | none => some now
    else st k

/-- The system's steps. `a1 = true` adds assumption A1 as a guard on evaluation: a request is
first evaluated only while `now − v < G − R` (written `now + R < v + G`); replays of an
answered request are unguarded (they change nothing). -/
inductive Step (R G : Nat) (a1 : Bool) : World → World → Prop
  | prepare (w : World) (req : Request) (host : Nat) :
      Step R G a1 w { w with store := reuse R w.store req.keys w.now,
                             pend := ⟨req, host, w.now⟩ :: w.pend }
  | evaluate (w : World) (q : Pending) (hq : q ∈ w.pend) (ha1 : a1 = true → w.sb.commits.lookup q.req.request = none → w.now + R < q.v + G) :
      Step R G a1 w { w with sb := (commit w.sb q.host q.req).1 }
  | drop (w : World) (pend : List Pending) (h : ∀ q ∈ pend, q ∈ w.pend) :
      Step R G a1 w { w with pend }
  | place (w : World) (e : Nat) (h : Option Nat) (hist : List (Nat × Nat)) :
      Step R G a1 w { w with sb := { w.sb with epoch := e, host := h, history := hist } }
  | claim (w : World) (T : Nat) (hT : T ≤ w.now) :
      Step R G a1 w { w with runs := ⟨T, allKeys w.sb.gens⟩ :: w.runs }
  | delete (w : World) (r : Run) (hr : r ∈ w.runs) (k t : Nat) (hk : k ∉ r.marked)
      (ht : w.store k = some t) (hcut : t + G < r.T) :
      Step R G a1 w { w with store := fun k' => if k' = k then none else w.store k' }
  | put (w : World) (k : Nat) :
      Step R G a1 w { w with store := fun k' => if k' = k then some w.now else w.store k' }
  | tick (w : World) (d : Nat) : Step R G a1 w { w with now := w.now + d }

inductive Reachable (R G : Nat) (a1 : Bool) : World → Prop
  | init : Reachable R G a1 World.init
  | step {w w' : World} : Reachable R G a1 w → Step R G a1 w w' → Reachable R G a1 w'

/-- A pending request that A1 still lets be evaluated. -/
def Eligible (R G : Nat) (w : World) (q : Pending) : Prop := w.now + R < q.v + G

/-- **The safety property (S1 and S2).** -/
def Safe (R G : Nat) (w : World) : Prop :=
  (∀ g ∈ w.sb.gens, ∀ k ∈ g.keys, ∃ t, w.store k = some t) ∧
  (∀ q ∈ w.pend, Eligible R G w q → ∀ k ∈ q.req.keys, ∃ t, w.store k = some t)

/-! ### The inductive invariant -/

structure Inv (R G : Nat) (w : World) : Prop where
  /-- Last-Modified is never in the future. -/
  past : ∀ k t, w.store k = some t → t ≤ w.now
  /-- S1: every key of every recorded generation is present. -/
  live : ∀ g ∈ w.sb.gens, ∀ k ∈ g.keys, ∃ t, w.store k = some t
  /-- S2, strengthened: an eligible request's keys are present and were young at its prepare. -/
  pend : ∀ q ∈ w.pend, Eligible R G w q → ∀ k ∈ q.req.keys, ∃ t, w.store k = some t ∧ q.v ≤ t + R
  /-- Every pass was marked in the past. -/
  runs : ∀ r ∈ w.runs, r.T ≤ w.now
  /-- Every generation key is marked by a pass, or too young for it to delete. -/
  cover : ∀ r ∈ w.runs, ∀ g ∈ w.sb.gens, ∀ k ∈ g.keys,
    k ∈ r.marked ∨ ∃ t, w.store k = some t ∧ r.T ≤ t + G

theorem inv_init (R G : Nat) : Inv R G World.init := by
  constructor <;> simp [World.init, CommitChain.State.init]

/-- A commit adds at most generations carrying the request's keys. -/
theorem commit_gens (s : CommitChain.State) (host : Nat) (ev : Request) :
    ∀ g ∈ (commit s host ev).1.gens, g ∈ s.gens ∨ g.keys = ev.keys := by
  have he := commit_effect s host ev
  generalize commit s host ev = p at he ⊢
  cases he with
  | replay => intro g hg; exact .inl hg
  | reject => intro g hg; exact .inl hg
  | orphan | commit =>
    intro g hg
    simp only [List.mem_cons] at hg
    rcases hg with rfl | hg
    · exact .inr rfl
    · exact .inl hg

/-- Stores only grow: a present key stays present with a Last-Modified at least as new. -/
def Grows (st st' : Nat → Option Nat) : Prop :=
  ∀ k t, st k = some t → ∃ t', st' k = some t' ∧ t ≤ t'

theorem inv_grows {R G : Nat} {w : World} (hi : Inv R G w) {st' : Nat → Option Nat}
    (hg : Grows w.store st') (hp : ∀ k t, st' k = some t → t ≤ w.now) :
    Inv R G { w with store := st' } where
  past := hp
  live := by
    intro g hgm k hk
    obtain ⟨t, ht⟩ := hi.live g hgm k hk
    obtain ⟨t', ht', _⟩ := hg k t ht
    exact ⟨t', ht'⟩
  pend := by
    intro q hq he k hk
    obtain ⟨t, ht, hv⟩ := hi.pend q hq he k hk
    obtain ⟨t', ht', hle⟩ := hg k t ht
    exact ⟨t', ht', by omega⟩
  runs := hi.runs
  cover := by
    intro r hr g hgm k hk
    rcases hi.cover r hr g hgm k hk with hm | ⟨t, ht, hT⟩
    · exact .inl hm
    · obtain ⟨t', ht', hle⟩ := hg k t ht
      exact .inr ⟨t', ht', by omega⟩

theorem reuse_grows {R : Nat} {st : Nat → Option Nat} {keys : List Nat} {now : Nat}
    (hp : ∀ k t, st k = some t → t ≤ now) : Grows st (reuse R st keys now) := by
  intro k t ht
  unfold reuse
  by_cases hk : k ∈ keys
  · rw [if_pos hk, ht]
    dsimp only
    by_cases hy : now < t + R
    · rw [if_pos hy]; exact ⟨t, rfl, Nat.le_refl t⟩
    · rw [if_neg hy]; exact ⟨now, rfl, hp k t ht⟩
  · rw [if_neg hk]; exact ⟨t, ht, Nat.le_refl t⟩

theorem reuse_past {R : Nat} {st : Nat → Option Nat} {keys : List Nat} {now : Nat}
    (hp : ∀ k t, st k = some t → t ≤ now) : ∀ k t, reuse R st keys now k = some t → t ≤ now := by
  intro k t ht
  unfold reuse at ht
  by_cases hk : k ∈ keys
  · rw [if_pos hk] at ht
    cases hs : st k with
    | none => rw [hs] at ht; cases ht; exact Nat.le_refl _
    | some t0 =>
      rw [hs] at ht
      dsimp only at ht
      by_cases hy : now < t0 + R
      · rw [if_pos hy] at ht; cases ht; exact hp k _ hs
      · rw [if_neg hy] at ht; cases ht; exact Nat.le_refl _
  · rw [if_neg hk] at ht; exact hp k t ht

/-- A prepared key is present and young enough for its request. -/
theorem reuse_young {R : Nat} {st : Nat → Option Nat} {keys : List Nat} {now : Nat} {k : Nat}
    (hk : k ∈ keys) : ∃ t, reuse R st keys now k = some t ∧ now ≤ t + R := by
  unfold reuse
  rw [if_pos hk]
  cases hs : st k with
  | none => exact ⟨now, rfl, Nat.le_add_right _ _⟩
  | some t0 =>
    dsimp only
    by_cases hy : now < t0 + R
    · rw [if_pos hy]; exact ⟨t0, rfl, Nat.le_of_lt hy⟩
    · rw [if_neg hy]; exact ⟨now, rfl, Nat.le_add_right _ _⟩

/-- **The core lemma.** A pass never deletes a key of a recorded generation or of an eligible
pending request. -/
theorem delete_spares {R G : Nat} {w : World} (hi : Inv R G w) {r : Run} (hr : r ∈ w.runs)
    {k t : Nat} (hk : k ∉ r.marked) (ht : w.store k = some t) (hcut : t + G < r.T) :
    (∀ g ∈ w.sb.gens, k ∉ g.keys) ∧ (∀ q ∈ w.pend, Eligible R G w q → k ∉ q.req.keys) := by
  constructor
  · intro g hg hkg
    rcases hi.cover r hr g hg k hkg with hm | ⟨t', ht', hT⟩
    · exact hk hm
    · rw [ht] at ht'; cases ht'; omega
  · intro q hq he hkq
    obtain ⟨t', ht', hv⟩ := hi.pend q hq he k hkq
    rw [ht] at ht'; cases ht'
    have := hi.runs r hr
    unfold Eligible at he
    omega

theorem inv_step {R G : Nat} {w w' : World} (hi : Inv R G w) (hs : Step R G true w w') :
    Inv R G w' := by
  cases hs with
  | prepare req host =>
    have hg := reuse_grows (R := R) (keys := req.keys) hi.past
    have hp := reuse_past (R := R) (keys := req.keys) hi.past
    have h1 := inv_grows hi hg hp
    refine ⟨h1.past, h1.live, ?_, h1.runs, h1.cover⟩
    intro q hq he k hk
    simp only [List.mem_cons] at hq
    rcases hq with rfl | hq
    · exact reuse_young hk
    · exact h1.pend q hq he k hk
  | evaluate q hq ha1 =>
    cases hl : w.sb.commits.lookup q.req.request with
    | some o =>
      rw [commit_of_lookup hl]
      exact ⟨hi.past, hi.live, hi.pend, hi.runs, hi.cover⟩
    | none =>
      have ha := ha1 rfl hl
      refine ⟨hi.past, ?_, hi.pend, hi.runs, ?_⟩
      · intro g hg k hk
        rcases commit_gens w.sb q.host q.req g hg with hg | hkeys
        · exact hi.live g hg k hk
        · rw [hkeys] at hk
          obtain ⟨t, ht, _⟩ := hi.pend q hq ha k hk
          exact ⟨t, ht⟩
      · intro r hr g hg k hk
        rcases commit_gens w.sb q.host q.req g hg with hg | hkeys
        · exact hi.cover r hr g hg k hk
        · rw [hkeys] at hk
          obtain ⟨t, ht, hv⟩ := hi.pend q hq ha k hk
          have := hi.runs r hr
          exact .inr ⟨t, ht, by omega⟩
  | drop pend h =>
    exact ⟨hi.past, hi.live, fun q hq => hi.pend q (h q hq), hi.runs, hi.cover⟩
  | place =>
    exact ⟨hi.past, hi.live, hi.pend, hi.runs, hi.cover⟩
  | claim T hT =>
    refine ⟨hi.past, hi.live, hi.pend, ?_, ?_⟩
    · intro r hr
      simp only [List.mem_cons] at hr
      rcases hr with rfl | hr
      · exact hT
      · exact hi.runs r hr
    · intro r hr g hg k hk
      simp only [List.mem_cons] at hr
      rcases hr with rfl | hr
      · exact .inl (List.mem_flatMap.mpr ⟨g, hg, hk⟩)
      · exact hi.cover r hr g hg k hk
  | delete r hr k t hk ht hcut =>
    obtain ⟨hlive, hpend⟩ := delete_spares hi hr hk ht hcut
    refine ⟨?_, ?_, ?_, hi.runs, ?_⟩
    · intro k' t' h'
      by_cases e : k' = k
      · simp [e] at h'
      · simp only [e, if_false] at h'; exact hi.past k' t' h'
    · intro g hg k' hk'
      have e : k' ≠ k := fun e => hlive g hg (e ▸ hk')
      simp only [e, if_false]; exact hi.live g hg k' hk'
    · intro q hq he k' hk'
      have e : k' ≠ k := fun e => hpend q hq he (e ▸ hk')
      simp only [e, if_false]; exact hi.pend q hq he k' hk'
    · intro r' hr' g hg k' hk'
      have e : k' ≠ k := fun e => hlive g hg (e ▸ hk')
      simp only [e, if_false]; exact hi.cover r' hr' g hg k' hk'
  | put k =>
    apply inv_grows hi
    · intro k' t h'
      by_cases e : k' = k
      · subst e; exact ⟨w.now, by simp, hi.past k' t h'⟩
      · exact ⟨t, by simp [e, h'], Nat.le_refl t⟩
    · intro k' t h'
      by_cases e : k' = k
      · simp [e] at h'; omega
      · simp only [e, if_false] at h'; exact hi.past k' t h'
  | tick d =>
    refine ⟨?_, hi.live, ?_, ?_, hi.cover⟩
    · intro k t h; have := hi.past k t h; dsimp only; omega
    · intro q hq he k hk
      have he' : Eligible R G w q := by unfold Eligible at he ⊢; dsimp only at he; omega
      exact hi.pend q hq he' k hk
    · intro r hr; have := hi.runs r hr; dsimp only; omega

theorem inv_reachable {R G : Nat} {w : World} (h : Reachable R G true w) : Inv R G w := by
  induction h with
  | init => exact inv_init R G
  | step _ hs ih => exact inv_step ih hs

/-- **GC safety under A1.** In every reachable state, every key of every recorded generation
(orphans included) is present, and so is every key of every pending request that A1 still lets
be evaluated. No hypothesis on `R` and `G` is needed: A1 (`now + R < v + G`) is satisfiable only
when `G > R`, which is where `G > R` enters. -/
theorem safe (R G : Nat) {w : World} (h : Reachable R G true w) : Safe R G w := by
  have hi := inv_reachable h
  exact ⟨hi.live, fun q hq he k hk => (hi.pend q hq he k hk).elim fun t ht => ⟨t, ht.1⟩⟩

/-- **No protected key is ever deleted.** A delete step taken from a reachable state removes no
key of a recorded generation and no key of an eligible pending request. -/
theorem never_deletes_protected (R G : Nat) {w : World} (h : Reachable R G true w)
    {r : Run} (hr : r ∈ w.runs) {k t : Nat} (hk : k ∉ r.marked) (ht : w.store k = some t)
    (hcut : t + G < r.T) :
    (∀ g ∈ w.sb.gens, k ∉ g.keys) ∧ (∀ q ∈ w.pend, Eligible R G w q → k ∉ q.req.keys) :=
  delete_spares (inv_reachable h) hr hk ht hcut

/-! ### B1: without A1 the theorem fails

nest's constants in hours: `R = 12`, `G = 24`. The sandbox is placed at epoch 1 on host 7. At
hour 0 nestd prepares a commit of chunk 5 (uploading it) and sends it; the request is lost (a
crash, or a partition while STONITH is unconfirmed, so the epoch and host do not move). 25 hours
later a pass marks with no generation to protect chunk 5 and deletes it (`0 + 24 < 25`). nestd's
next commit re-sends the unanswered request, which SandboxDO evaluates and makes **head**: a
recorded generation names a deleted chunk. A1 forbids this evaluation (`25 + 12 < 0 + 24` is
false). -/

def b1Req : Request :=
  { request := 1, epoch := 1, parent := none, checkpoint := false, hasMem := false,
    salvage := false, keys := [5] }

def b1Pending : Pending := ⟨b1Req, 7, 0⟩

/-- Placed at epoch 1 on host 7. -/
def w1 : World :=
  { World.init with sb := { World.init.sb with epoch := 1, host := some 7, history := [(1, 7)] } }
/-- Prepared at hour 0: chunk 5 uploaded, the request pending. -/
def w2 : World := { w1 with store := reuse 12 w1.store b1Req.keys w1.now, pend := [b1Pending] }
/-- 25 hours pass. -/
def w3 : World := { w2 with now := w2.now + 25 }
/-- A pass marked at hour 25, with no roots. -/
def w4 : World := { w3 with runs := [⟨25, allKeys w3.sb.gens⟩] }
/-- The pass deletes chunk 5. -/
def w5 : World := { w4 with store := fun k' => if k' = 5 then none else w4.store k' }
/-- The re-sent request is evaluated, without A1. -/
def w6 : World := { w5 with sb := (commit w5.sb b1Pending.host b1Pending.req).1 }

theorem b1_reachable : Reachable 12 24 false w6 := by
  have r1 : Reachable 12 24 false w1 := .step .init (.place _ 1 (some 7) [(1, 7)])
  have r2 : Reachable 12 24 false w2 := .step r1 (.prepare w1 b1Req 7)
  have r3 : Reachable 12 24 false w3 := .step r2 (.tick w2 25)
  have r4 : Reachable 12 24 false w4 := .step r3 (.claim w3 25 (by decide))
  have r5 : Reachable 12 24 false w5 :=
    .step r4 (.delete w4 ⟨25, []⟩ (by decide) 5 0 (by decide) (by decide) (by decide))
  exact .step r5 (.evaluate w5 b1Pending (by decide) (fun h => by cases h))

/-- **B1.** Without A1 a reachable state violates S1: the head generation names a deleted chunk. -/
theorem b1_unsafe : Reachable 12 24 false w6 ∧ ¬ Safe 12 24 w6 ∧
    w6.sb.head = some 0 ∧ w6.sb.gens = [⟨0, none, 1, false, [5]⟩] ∧ w6.store 5 = none := by
  refine ⟨b1_reachable, ?_, by decide, by decide, by decide⟩
  intro ⟨hlive, _⟩
  have hg : w6.sb.gens = [⟨0, none, 1, false, [5]⟩] := by decide
  obtain ⟨t, ht⟩ := hlive ⟨0, none, 1, false, [5]⟩ (by rw [hg]; exact List.mem_singleton_self _) 5
    (List.mem_singleton_self _)
  have h5 : w6.store 5 = none := by decide
  rw [h5] at ht; cases ht

/-- The same trace breaks S2 one step earlier: before evaluation, the pending request's chunk is
already gone. (It is no longer eligible under A1, so `Safe` itself still holds at `w5`.) -/
theorem b1_pending_lost : b1Pending ∈ w5.pend ∧ 5 ∈ b1Pending.req.keys ∧ w5.store 5 = none ∧
    ¬ Eligible 12 24 w5 b1Pending := by
  refine ⟨by decide, by decide, by decide, ?_⟩
  unfold Eligible; decide

/-! ### The guarded model is not vacuous

Under A1 the same request, evaluated at hour 0, becomes head; an unrelated garbage chunk (9)
uploaded at hour 0 is deleted by a pass marked at hour 25, and chunk 5 survives. -/

def h3 : World :=
  { w2 with sb := (commit w2.sb b1Pending.host b1Pending.req).1 }
def h4 : World := { h3 with store := fun k' => if k' = 9 then some h3.now else h3.store k' }
def h5 : World := { h4 with now := h4.now + 25 }
def h6 : World := { h5 with runs := [⟨25, allKeys h5.sb.gens⟩] }
def h7 : World := { h6 with store := fun k' => if k' = 9 then none else h6.store k' }

theorem a1_not_vacuous : Reachable 12 24 true h7 ∧ h7.sb.head = some 0 ∧
    h7.store 9 = none ∧ h7.store 5 = some 0 := by
  have r1 : Reachable 12 24 true w1 := .step .init (.place _ 1 (some 7) [(1, 7)])
  have r2 : Reachable 12 24 true w2 := .step r1 (.prepare w1 b1Req 7)
  have r3 : Reachable 12 24 true h3 :=
    .step r2 (.evaluate w2 b1Pending (by decide) (fun _ _ => by decide))
  have r4 : Reachable 12 24 true h4 := .step r3 (.put h3 9)
  have r5 : Reachable 12 24 true h5 := .step r4 (.tick h4 25)
  have r6 : Reachable 12 24 true h6 := .step r5 (.claim h5 25 (by decide))
  have r7 : Reachable 12 24 true h7 :=
    .step r6 (.delete h6 ⟨25, [5]⟩ (by decide) 9 0 (by decide) (by decide) (by decide))
  exact ⟨r7, by decide, by decide, by decide⟩

end Nest.Gc

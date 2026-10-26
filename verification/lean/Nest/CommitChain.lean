/-!
# SandboxDO.commit: the generation chain

A model of `SandboxDO.commit` (`control-plane/src/do/sandbox.ts:552-613`) at main `edf6829`, and
proofs that every reachable state keeps the chain well formed.

* `commit` follows the code's guard order exactly: replay, invalid kind, salvage (orphan or
  reject), stale epoch or host, parent mismatch, commit.
* Placement (`sandbox.ts:236-317`, `:348`, `:411`, `:468`, `:513`) is the only other writer of
  `info.epoch`, `info.host` and `info.history`; it never touches `head`, `generations` or
  `commits`. It is modelled as `place`, which sets all three to anything (epochs can go back,
  `:312`; the host can become `null`), so the theorems hold whatever placement does.
* Generation ids come from a counter `next` (the code's `newId("gen_")` is random; uniqueness is
  assumed, not proved).
* `keys` is the closure of the generation's manifests (`cl(disk) ∪ cl(mem)`); this module ignores
  it, `Nest.Gc` uses it.
-/

namespace Nest.CommitChain


/-- A `commit_request` (`CommitRequestEvent`). `checkpoint` is `kind = checkpoint`, `hasMem` is
`mem_manifest` present, `salvage` is `reason = salvage`. -/
structure Request where
  request : Nat
  epoch : Nat
  parent : Option Nat
  checkpoint : Bool
  hasMem : Bool
  salvage : Bool
  keys : List Nat
  deriving DecidableEq, Repr

/-- A row of `generations`: the record plus the `orphaned` column. -/
structure Gen where
  id : Nat
  parent : Option Nat
  epoch : Nat
  orphaned : Bool
  keys : List Nat
  deriving DecidableEq, Repr

inductive Reject where
  | invalidMessage
  | staleEpoch
  | parentMismatch
  deriving DecidableEq, Repr

inductive Outcome where
  | committed (g : Gen)
  | orphaned (g : Gen)
  | rejected (why : Reject) (head : Option Nat)
  deriving DecidableEq, Repr

/-- SandboxDO's state that `commit` reads or writes. -/
structure State where
  epoch : Nat
  host : Option Nat
  head : Option Nat
  gens : List Gen
  commits : List (Nat × Outcome)
  history : List (Nat × Nat)
  next : Nat
  deriving DecidableEq, Repr

/-- `create` (`sandbox.ts:185-195`): epoch 0, no host, no head, empty tables. -/
def State.init : State :=
  { epoch := 0, host := none, head := none, gens := [], commits := [], history := [], next := 0 }

/-- `INSERT INTO commits` (`:598`). -/
def store (s : State) (r : Nat) (o : Outcome) : State × Outcome :=
  ({ s with commits := (r, o) :: s.commits }, o)

/-- `record()` (`:556-566`). -/
def record (s : State) (ev : Request) (orphaned : Bool) : Gen :=
  { id := s.next, parent := ev.parent, epoch := ev.epoch, orphaned, keys := ev.keys }

/-- `info.history.find((h) => h.epoch === ev.epoch)?.host` (`:576`). -/
def heldBy (s : State) (e : Nat) : Option Nat :=
  (s.history.find? (·.1 == e)).map (·.2)

/-- `SandboxDO.commit(host, ev)`, guard for guard. -/
def commit (s : State) (host : Nat) (ev : Request) : State × Outcome :=
  match s.commits.lookup ev.request with
  | some o => (s, o)
  | none =>
    if ev.checkpoint ≠ ev.hasMem then
      store s ev.request (.rejected .invalidMessage s.head)
    else if ev.salvage = true ∧ ev.epoch < s.epoch then
      if heldBy s ev.epoch = some host then
        store { s with gens := record s ev true :: s.gens, next := s.next + 1 } ev.request
          (.orphaned (record s ev true))
      else store s ev.request (.rejected .staleEpoch s.head)
    else if ev.epoch ≠ s.epoch ∨ s.host ≠ some host then
      store s ev.request (.rejected .staleEpoch s.head)
    else if ev.parent ≠ s.head then
      store s ev.request (.rejected .parentMismatch s.head)
    else
      store { s with gens := record s ev false :: s.gens, head := some s.next, next := s.next + 1 }
        ev.request (.committed (record s ev false))

/-- Every way the system changes SandboxDO's chain state. -/
inductive Step : State → State → Prop
  | commit (s : State) (host : Nat) (ev : Request) : Step s (commit s host ev).1
  | place (s : State) (epoch : Nat) (host : Option Nat) (history : List (Nat × Nat)) :
      Step s { s with epoch, host, history }

inductive Reachable : State → Prop
  | init : Reachable State.init
  | step {s s' : State} : Reachable s → Step s s' → Reachable s'

/-- Zero or more steps. -/
inductive Steps : State → State → Prop
  | refl (s : State) : Steps s s
  | tail {s s' s'' : State} : Steps s s' → Step s' s'' → Steps s s''

/-! ### What one call does -/

/-- The four effects of `commit`, with the guards that select each. -/
inductive Effect (s : State) (host : Nat) (ev : Request) : State × Outcome → Prop
  | replay (o : Outcome) (h : s.commits.lookup ev.request = some o) : Effect s host ev (s, o)
  | reject (why : Reject) (h : s.commits.lookup ev.request = none) :
      Effect s host ev
        ({ s with commits := (ev.request, .rejected why s.head) :: s.commits }, .rejected why s.head)
  | orphan (h : s.commits.lookup ev.request = none) (hs : ev.salvage = true)
      (he : ev.epoch < s.epoch) (hh : heldBy s ev.epoch = some host) :
      Effect s host ev
        ({ s with gens := record s ev true :: s.gens, next := s.next + 1,
                  commits := (ev.request, .orphaned (record s ev true)) :: s.commits },
         .orphaned (record s ev true))
  | commit (h : s.commits.lookup ev.request = none) (hk : ev.checkpoint = ev.hasMem)
      (he : ev.epoch = s.epoch) (hh : s.host = some host) (hp : ev.parent = s.head) :
      Effect s host ev
        ({ s with gens := record s ev false :: s.gens, head := some s.next, next := s.next + 1,
                  commits := (ev.request, .committed (record s ev false)) :: s.commits },
         .committed (record s ev false))

theorem commit_effect (s : State) (host : Nat) (ev : Request) :
    Effect s host ev (commit s host ev) := by
  unfold commit
  split
  · next o h => exact .replay o h
  · next h =>
    by_cases hk : ev.checkpoint ≠ ev.hasMem
    · rw [if_pos hk]; exact .reject _ h
    · rw [if_neg hk]
      by_cases hs : ev.salvage = true ∧ ev.epoch < s.epoch
      · rw [if_pos hs]
        by_cases hh : heldBy s ev.epoch = some host
        · rw [if_pos hh]; exact .orphan h hs.1 hs.2 hh
        · rw [if_neg hh]; exact .reject _ h
      · rw [if_neg hs]
        by_cases he : ev.epoch ≠ s.epoch ∨ s.host ≠ some host
        · rw [if_pos he]; exact .reject _ h
        · rw [if_neg he]
          by_cases hp : ev.parent ≠ s.head
          · rw [if_pos hp]; exact .reject _ h
          · rw [if_neg hp]
            refine .commit h ?_ ?_ ?_ ?_
            · exact Classical.not_not.mp hk
            · exact Classical.not_not.mp (fun c => he (Or.inl c))
            · exact Classical.not_not.mp (fun c => he (Or.inr c))
            · exact Classical.not_not.mp hp

/-! ### Lookup in `commits` -/

theorem lookup_cons_self (r : Nat) (o : Outcome) (l : List (Nat × Outcome)) :
    ((r, o) :: l).lookup r = some o := by
  simp [List.lookup]

theorem lookup_cons_ne {r r' : Nat} (o : Outcome) (l : List (Nat × Outcome)) (h : r ≠ r') :
    ((r', o) :: l).lookup r = l.lookup r := by
  have hb : (r == r') = false := beq_eq_false_iff_ne.mpr h
  simp only [List.lookup, hb]

/-- After a call, `commits` answers the request with the outcome the call returned. -/
theorem stored_after (s : State) (host : Nat) (ev : Request) :
    (commit s host ev).1.commits.lookup ev.request = some (commit s host ev).2 := by
  have he := commit_effect s host ev
  generalize commit s host ev = p at he ⊢
  cases he <;> first | assumption | exact lookup_cons_self _ _ _

theorem commit_of_lookup {s : State} {host : Nat} {ev : Request} {o : Outcome}
    (h : s.commits.lookup ev.request = some o) : commit s host ev = (s, o) := by
  unfold commit; rw [h]

/-- An answered request stays answered the same way: `commits` is never pruned or overwritten. -/
theorem step_keeps_lookup {s s' : State} (hs : Step s s') {r : Nat} {o : Outcome}
    (h : s.commits.lookup r = some o) : s'.commits.lookup r = some o := by
  cases hs with
  | place => exact h
  | commit host ev =>
    have he := commit_effect s host ev
    generalize commit s host ev = p at he ⊢
    cases he with
    | replay => exact h
    | reject _ hn | orphan hn | commit hn =>
      have hne : r ≠ ev.request := by intro e; subst e; rw [h] at hn; cases hn
      simp only; rw [lookup_cons_ne _ _ hne]; exact h

theorem steps_keep_lookup {s s' : State} (hs : Steps s s') {r : Nat} {o : Outcome}
    (h : s.commits.lookup r = some o) : s'.commits.lookup r = some o := by
  induction hs with
  | refl => exact h
  | tail _ hstep ih => exact step_keeps_lookup hstep ih

/-! ### Idempotence (S4) -/

/-- A replay, from any host, returns the stored outcome and changes nothing. -/
theorem replay (s : State) (host host' : Nat) (ev : Request) :
    commit (commit s host ev).1 host' ev = commit s host ev :=
  commit_of_lookup (stored_after s host ev)

/-- Idempotent for ever: after any later steps (other commits, placements), re-sending the same
request id returns the first outcome and changes nothing. So one request id makes at most one
generation. -/
theorem idempotent (s : State) (host : Nat) (ev : Request) {s' : State}
    (hs : Steps (commit s host ev).1 s') (host' : Nat) (ev' : Request)
    (hr : ev'.request = ev.request) :
    commit s' host' ev' = (s', (commit s host ev).2) := by
  apply commit_of_lookup
  rw [hr]
  exact steps_keep_lookup hs (stored_after s host ev)

/-! ### Only a compare-and-set moves the head -/

/-- If a call moves the head, it was a fresh request from the current `(info.host, info.epoch)`
whose parent was the previous head, and the new head is the committed, non-orphan generation. -/
theorem head_moves_only_by_cas (s : State) (host : Nat) (ev : Request)
    (hmove : (commit s host ev).1.head ≠ s.head) :
    s.commits.lookup ev.request = none ∧ s.host = some host ∧ ev.epoch = s.epoch ∧
      ev.parent = s.head ∧ ev.checkpoint = ev.hasMem ∧
      ∃ g, (commit s host ev).2 = .committed g ∧ g.parent = s.head ∧ g.orphaned = false ∧
        (commit s host ev).1.head = some g.id := by
  revert hmove
  have he := commit_effect s host ev
  generalize commit s host ev = p at he ⊢
  cases he with
  | replay => intro h; exact absurd rfl h
  | reject => intro h; exact absurd rfl h
  | orphan => intro h; exact absurd rfl h
  | commit hn hk he hh hp =>
    intro _
    exact ⟨hn, hh, he, hp, hk, record s ev false, rfl, hp, rfl, rfl⟩

/-- Placement never moves the head. -/
theorem place_keeps_head (s : State) (e : Nat) (h : Option Nat) (hist : List (Nat × Nat)) :
    ({ s with epoch := e, host := h, history := hist } : State).head = s.head := rfl

/-! ### The chain invariant (S3) -/

structure Inv (s : State) : Prop where
  /-- Ids are below the counter (models `newId` freshness). -/
  fresh : ∀ g ∈ s.gens, g.id < s.next
  /-- Ids are unique. -/
  unique : ∀ g ∈ s.gens, ∀ g' ∈ s.gens, g.id = g'.id → g = g'
  /-- The head is none or a recorded non-orphan generation. -/
  head : ∀ h, s.head = some h → ∃ g ∈ s.gens, g.id = h ∧ g.orphaned = false
  /-- Every non-orphan's parent is none or a recorded non-orphan created before it. -/
  tree : ∀ g ∈ s.gens, g.orphaned = false → ∀ p, g.parent = some p →
    ∃ g' ∈ s.gens, g'.id = p ∧ g'.orphaned = false ∧ p < g.id

theorem inv_init : Inv State.init := by
  constructor <;> simp [State.init]

theorem inv_step {s s' : State} (hi : Inv s) (hs : Step s s') : Inv s' := by
  cases hs with
  | place => exact ⟨hi.fresh, hi.unique, hi.head, hi.tree⟩
  | commit host ev =>
    have he := commit_effect s host ev
    generalize commit s host ev = p at he ⊢
    cases he with
    | replay => exact hi
    | reject => exact ⟨hi.fresh, hi.unique, hi.head, hi.tree⟩
    | orphan =>
      refine ⟨?_, ?_, ?_, ?_⟩
      · intro g hg
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · simp [record]
        · have := hi.fresh g hg; dsimp only; omega
      · intro g hg g' hg' hid
        simp only [List.mem_cons] at hg hg'
        rcases hg with rfl | hg <;> rcases hg' with rfl | hg'
        · rfl
        · have := hi.fresh g' hg'; simp [record] at hid; omega
        · have := hi.fresh g hg; simp [record] at hid; omega
        · exact hi.unique g hg g' hg' hid
      · intro h hh
        obtain ⟨g, hg, hid, ho⟩ := hi.head h hh
        exact ⟨g, List.mem_cons_of_mem _ hg, hid, ho⟩
      · intro g hg ho p hp
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · simp [record] at ho
        · obtain ⟨g', hg', h1, h2, h3⟩ := hi.tree g hg ho p hp
          exact ⟨g', List.mem_cons_of_mem _ hg', h1, h2, h3⟩
    | commit hn hk he hh hp =>
      refine ⟨?_, ?_, ?_, ?_⟩
      · intro g hg
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · simp [record]
        · have := hi.fresh g hg; dsimp only; omega
      · intro g hg g' hg' hid
        simp only [List.mem_cons] at hg hg'
        rcases hg with rfl | hg <;> rcases hg' with rfl | hg'
        · rfl
        · have := hi.fresh g' hg'; simp [record] at hid; omega
        · have := hi.fresh g hg; simp [record] at hid; omega
        · exact hi.unique g hg g' hg' hid
      · intro h hh
        simp only [Option.some.injEq] at hh
        exact ⟨record s ev false, List.mem_cons_self, by simp [record, hh], rfl⟩
      · intro g hg ho p hpar
        simp only [List.mem_cons] at hg
        rcases hg with rfl | hg
        · -- the new generation: its parent is the old head
          simp only [record] at hpar
          rw [hp] at hpar
          obtain ⟨g', hg', h1, h2⟩ := hi.head p hpar
          have := hi.fresh g' hg'
          exact ⟨g', List.mem_cons_of_mem _ hg', h1, h2, by simp [record]; omega⟩
        · obtain ⟨g', hg', h1, h2, h3⟩ := hi.tree g hg ho p hpar
          exact ⟨g', List.mem_cons_of_mem _ hg', h1, h2, h3⟩

theorem inv_reachable {s : State} (h : Reachable s) : Inv s := by
  induction h with
  | init => exact inv_init
  | step _ hs ih => exact inv_step ih hs

/-- **S3, head:** in every reachable state the head is none or a recorded non-orphan. -/
theorem head_recorded {s : State} (h : Reachable s) :
    ∀ id, s.head = some id → ∃ g ∈ s.gens, g.id = id ∧ g.orphaned = false :=
  (inv_reachable h).head

/-- **S3, tree:** every non-orphan's parent is none or a recorded non-orphan with a smaller id
(so the non-orphans form a tree, without cycles). -/
theorem tree {s : State} (h : Reachable s) :
    ∀ g ∈ s.gens, g.orphaned = false → ∀ p, g.parent = some p →
      ∃ g' ∈ s.gens, g'.id = p ∧ g'.orphaned = false ∧ p < g.id :=
  (inv_reachable h).tree

/-- **An orphan is never head.** -/
theorem orphan_never_head {s : State} (h : Reachable s) :
    ∀ g ∈ s.gens, g.orphaned = true → s.head ≠ some g.id := by
  intro g hg ho hh
  have hi := inv_reachable h
  obtain ⟨g', hg', hid, ho'⟩ := hi.head g.id hh
  have := hi.unique g' hg' g hg hid
  subst this
  rw [ho] at ho'; cases ho'

/-! ### Proved negatives -/

/-- A sandbox placed at epoch 1 on host 7, then at epoch 2 on host 8. -/
def twoPlacements : State :=
  { State.init with epoch := 2, host := some 8, history := [(1, 7), (2, 8)] }

theorem twoPlacements_reachable : Reachable twoPlacements :=
  .step (.step .init (.place _ 1 (some 7) [(1, 7)])) (.place _ 2 (some 8) [(1, 7), (2, 8)])

/-- A salvage from host 7 for epoch 1 naming a parent (42) that was never recorded. -/
def foreignSalvage : Request :=
  { request := 100, epoch := 1, parent := some 42, checkpoint := false, hasMem := false,
    salvage := true, keys := [5] }

/-- **Orphan parents are unchecked (B3, `sandbox.ts:579-581`).** A reachable state holds an
orphan whose parent is not a recorded generation: the tree property does not extend to orphans. -/
theorem orphan_parent_unchecked :
    ∃ s, Reachable s ∧ ∃ g ∈ s.gens, g.orphaned = true ∧ g.parent = some 42 ∧
      ¬ ∃ g' ∈ s.gens, g'.id = 42 := by
  refine ⟨(commit twoPlacements 7 foreignSalvage).1,
    .step twoPlacements_reachable (.commit _ _ _), ?_⟩
  have hg : (commit twoPlacements 7 foreignSalvage).1.gens = [⟨0, some 42, 1, true, [5]⟩] := by
    decide
  rw [hg]
  refine ⟨_, List.mem_singleton_self _, rfl, rfl, ?_⟩
  simp

/-- **Orphans are accepted after destroy (B3).** `destroy` sets `host := null` (`:511-514`); a
salvage from the host that held an older epoch is still recorded as an orphan. -/
theorem orphan_after_destroy :
    let destroyed : State := { twoPlacements with host := none }
    Reachable destroyed ∧
      ∃ g, (commit destroyed 7 { foreignSalvage with parent := none }).2 = .orphaned g := by
  intro destroyed
  exact ⟨.step twoPlacements_reachable (.place _ 2 none [(1, 7), (2, 8)]), _, rfl⟩

end Nest.CommitChain

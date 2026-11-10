--------------------------- MODULE PlacementRetry ---------------------------
(***************************************************************************)
(* The bounded retries of a refused placement (#191; the state-machine     *)
(* sweep's bug 9; the lease inventory's L1 "Refused" and L3).              *)
(*                                                                         *)
(* SandboxLease.tla models the lease; its Reassign retries for ever under *)
(* weak fairness and its Refused answer leaves no retry. This module       *)
(* abstracts the lease to one lost lease (the sandbox was on `lost`;       *)
(* FleetDO deleted the lease and holds a reassignment row for it) and      *)
(* models who tries again, when, and when each side gives up:              *)
(*   - FleetDO's row: `leaseLost` to SandboxDO, retried until it succeeds; *)
(*     it gives up only after N refusals, each of which means the call     *)
(*     landed (SandboxDO let go of the host) and the new placement was     *)
(*     refused. A call that never landed, or whose answer was lost, is     *)
(*     retried without limit;                                              *)
(*   - SandboxDO's own `place` deadline: a refused placement is counted    *)
(*     and retried M times, then given up visibly (`placement_refused`);   *)
(*   - the operator's retry starts the count again; a placement deletes a  *)
(*     row that gave up.                                                   *)
(* A refusal is FleetDO finding a lease that disagrees with SandboxDO's    *)
(* record (`conflict`); it may heal, or never. Capacity may be missing     *)
(* for a while (bounded here).                                             *)
(*                                                                         *)
(* The call is split at its awaits: the request in flight, SandboxDO's     *)
(* step (leaseLost and its placement, atomic here: FleetDO.place is one    *)
(* synchronous step and nothing in this module runs inside SandboxDO's     *)
(* await on it), the answer in flight, FleetDO's continuation. FleetDO     *)
(* may reset with the call out; the request or the answer may be lost.     *)
(*                                                                         *)
(* Action -> code (control-plane/src):                                     *)
(*   Send          do/fleet.ts processReassign: leaseLost issued           *)
(*   Land          do/sandbox.ts leaseLost (lib/sandbox-lease.ts           *)
(*                 leaseLost), then placeCurrentEpoch(own = false)         *)
(*   Resume        processReassign's continuation: row deleted, or its     *)
(*                 catch with lib/retry.ts reassignRetry                   *)
(*   LoseRequest, LoseAnswer  the catch with `refused` false               *)
(*   FleetReset    a reset with the call out: the row stays due            *)
(*   Alarm         do/sandbox.ts alarm `place`: placeWanted, then          *)
(*                 placeCurrentEpoch (own = true), lib/retry.ts retryAfter *)
(*   Operator      do/sandbox.ts retryPlacement                            *)
(*   Heal          the disagreeing lease goes (an operator, a destroy)     *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  N,             \* REASSIGN_RETRY.max_attempts: refusals after which the row gives up (10)
  M,             \* PLACE_REFUSED_RETRY.max_attempts: SandboxDO's own refused tries (6)
  MaxLose,       \* requests or answers lost, at most
  MaxReset,      \* FleetDO resets with the call out, at most
  MaxNoCap,      \* "no capacity" answers, at most
  MaxOp,         \* operator retries, at most
  MayHeal,       \* TRUE: the conflict may go away
  \* ---- switches: the code as it is first ----
  FixReassign,   \* TRUE: the row counts refusals, backs off and gives up. FALSE (before #191): retried every tick, for ever
  FixPlace,      \* TRUE: SandboxDO retries a refusal on its own deadline, then gives up visibly. FALSE (before #191): the deadline cleared, nothing shown
  CountLost      \* FALSE. TRUE (#191's first version): a call that failed for any reason counts toward giving up

ASSUME N \in Nat /\ N >= 1 /\ M \in Nat /\ M >= 1

VARIABLES
  \* SandboxDO (durable)
  sHost,       \* "lost" (still names the lost host), "none", "new" (placed again)
  sCount,      \* its own refused placements since the last success or operator retry
  sGaveUp,     \* placement_refused.gave_up: shown to the owner
  sDeadline,   \* the `place` deadline is armed
  \* FleetDO (durable)
  row,         \* "due", "gaveup", "none"
  rRefusals,
  conflict,    \* a lease that disagrees: FleetDO.place refuses
  \* the leaseLost call
  call,        \* "idle", "req", "ok", "refused"
  budget

vars == <<sHost, sCount, sGaveUp, sDeadline, row, rRefusals, conflict, call, budget>>

Init ==
  /\ sHost = "lost" /\ sCount = 0 /\ sGaveUp = FALSE /\ sDeadline = FALSE
  /\ row = "due" /\ rRefusals = 0 /\ conflict \in BOOLEAN /\ call = "idle"
  /\ budget = [lose |-> MaxLose, reset |-> MaxReset, nocap |-> MaxNoCap, op |-> MaxOp]

-----------------------------------------------------------------------------
(* A placement by SandboxDO, unplaced: FleetDO's answer and what SandboxDO records. *)

\* Granted: placed; the note and the count go; a row that gave up is deleted by FleetDO.place.
Granted ==
  /\ ~conflict
  /\ sHost' = "new" /\ sCount' = 0 /\ sGaveUp' = FALSE /\ sDeadline' = FALSE
  /\ row' = IF row = "gaveup" THEN "none" ELSE row

\* No capacity: retried from the `place` deadline, as ever.
NoCapacity ==
  /\ ~conflict /\ budget.nocap > 0
  /\ sHost' = "none" /\ sDeadline' = TRUE
  /\ UNCHANGED <<sCount, sGaveUp, row>>

\* Refused, asked by FleetDO's reassignment: noted, not counted; SandboxDO's own retries armed.
RefusedForFleet ==
  /\ conflict
  /\ sHost' = "none"
  /\ sDeadline' = IF FixPlace THEN (sDeadline \/ ~sGaveUp) ELSE FALSE
  /\ UNCHANGED <<sCount, sGaveUp, row>>

\* Refused, on SandboxDO's own try (its alarm, the operator): counted; given up after M.
RefusedOwn(count) ==
  /\ conflict
  /\ sHost' = "none"
  /\ IF FixPlace
       THEN /\ sCount' = count + 1
            /\ sGaveUp' = (count + 1 >= M)
            /\ sDeadline' = (count + 1 < M)
       ELSE /\ sDeadline' = FALSE /\ sCount' = count /\ sGaveUp' = FALSE
  /\ UNCHANGED row

Spend(k) == budget' = [budget EXCEPT ![k] = @ - 1]

-----------------------------------------------------------------------------
(* FleetDO's reassignment *)

Send ==
  /\ row = "due" /\ call = "idle"
  /\ call' = "req"
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, row, rRefusals, conflict, budget>>

\* SandboxDO takes the call: a loss it already handled and re-placed is ignored (ok); else it lets go
\* of the host (or already had) and places.
Land ==
  /\ call = "req"
  /\ \/ /\ sHost = "new"
        /\ call' = "ok"
        /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, row, budget>>
     \/ /\ sHost # "new"
        /\ \/ Granted /\ call' = "ok" /\ UNCHANGED budget
           \/ NoCapacity /\ call' = "ok" /\ Spend("nocap")
           \/ RefusedForFleet /\ call' = "refused" /\ UNCHANGED budget
  /\ UNCHANGED <<rRefusals, conflict>>

\* What FleetDO does with a failure: `refused` says SandboxDO answered that its placement was refused.
Failed(refused) ==
  IF ~FixReassign THEN UNCHANGED <<row, rRefusals>>
  ELSE LET counts == refused \/ CountLost
           n == rRefusals + (IF counts THEN 1 ELSE 0)
       IN /\ rRefusals' = n
          /\ row' = IF counts /\ n >= N THEN "gaveup" ELSE row

Resume ==
  /\ call \in {"ok", "refused"} /\ row = "due"
  /\ IF call = "ok" THEN row' = "none" /\ UNCHANGED rRefusals ELSE Failed(TRUE)
  /\ call' = "idle"
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, conflict, budget>>

\* The row went meanwhile (a placement deleted one that gave up): the answer is dropped.
ResumeGone ==
  /\ call \in {"ok", "refused"} /\ row # "due"
  /\ call' = "idle"
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, row, rRefusals, conflict, budget>>

\* The request never lands, or the answer is lost: FleetDO sees a failure that isn't a refusal.
LoseCall ==
  /\ call # "idle" /\ budget.lose > 0 /\ row = "due"
  /\ Failed(FALSE)
  /\ call' = "idle" /\ budget' = [budget EXCEPT !.lose = @ - 1]
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, conflict>>

\* FleetDO resets with the call out: the continuation is gone, the row as it was.
FleetReset ==
  /\ call # "idle" /\ budget.reset > 0
  /\ call' = "idle" /\ budget' = [budget EXCEPT !.reset = @ - 1]
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, row, rRefusals, conflict>>

-----------------------------------------------------------------------------
(* SandboxDO's own tries *)

Alarm ==
  /\ sDeadline /\ sHost = "none"
  /\ \/ Granted /\ UNCHANGED budget
     \/ NoCapacity /\ Spend("nocap")
     \/ RefusedOwn(sCount) /\ UNCHANGED budget
  /\ UNCHANGED <<rRefusals, conflict, call>>

\* The operator's `POST /place` on an unplaced sandbox: the count starts again.
Operator ==
  /\ sHost = "none" /\ budget.op > 0
  /\ Granted \/ RefusedOwn(0)
  /\ Spend("op")
  /\ UNCHANGED <<rRefusals, conflict, call>>

Heal ==
  /\ MayHeal /\ conflict
  /\ conflict' = FALSE
  /\ UNCHANGED <<sHost, sCount, sGaveUp, sDeadline, row, rRefusals, call, budget>>

-----------------------------------------------------------------------------
Next ==
  \/ Send \/ Land \/ Resume \/ ResumeGone \/ LoseCall \/ FleetReset \/ Alarm \/ Operator \/ Heal

\* Fairness: FleetDO's tick and SandboxDO's alarm run, calls land and return. Faults, the operator
\* and Heal are not fair.
Fairness ==
  /\ WF_vars(Send) /\ WF_vars(Land) /\ WF_vars(Resume) /\ WF_vars(ResumeGone) /\ WF_vars(Alarm)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ sHost \in {"lost", "none", "new"} /\ sCount \in 0..M /\ sGaveUp \in BOOLEAN /\ sDeadline \in BOOLEAN
  /\ row \in {"due", "gaveup", "none"} /\ rRefusals \in 0..N /\ call \in {"idle", "req", "ok", "refused"}

\* FleetDO never gives up on a sandbox that still names the lost host: nothing else would place it again.
NotStranded == row = "gaveup" => sHost # "lost"

\* The counters are bounded: neither side retries a refusal without limit.
Bounded == rRefusals <= N /\ sCount <= M

\* L1, weakened: the sandbox ends placed again, or given up where the owner sees it.
SandboxSettles == <>[](sHost = "new" \/ (sHost = "none" /\ sGaveUp))

\* L3, weakened: the row ends deleted, or given up.
RowSettles == <>[](row \in {"none", "gaveup"})

\* Reachability (expected violated): both give up; a give-up is followed by a placement; a lost call is retried.
NoGiveUp     == ~(row = "gaveup" /\ sGaveUp)
NoRecovery   == ~(sHost = "new" /\ rRefusals > 0)
NoLostRetry  == ~(budget.lose < MaxLose /\ sHost = "new")

=============================================================================

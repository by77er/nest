--------------------------- MODULE FailedRelease ---------------------------
(***************************************************************************)
(* A failed sandbox releases its lease (#192; the state-machine sweep's    *)
(* bug 6), with what the release leaves behind: the incarnation on the     *)
(* host, recorded stale and not yet salvaged, which keeps the host from    *)
(* being retired until it is salvaged (or its window passed) and           *)
(* destroyed.                                                              *)
(*                                                                         *)
(* SandboxLease.tla has no FailedRelease. This module models one sandbox   *)
(* that can fail on its host, with placement abstracted to one step        *)
(* (claim, FleetDO.place, the answer: FleetDO.place is synchronous, and    *)
(* the lost answers and resets around it are SandboxLease's subject), and  *)
(* the release split at its two awaits (the fence's issue, FleetDO's       *)
(* releaseFailedLease), with an operator's Retry, a Destroy, a host's      *)
(* loss and a SandboxDO reset between them.                                *)
(*                                                                         *)
(* Action -> code (control-plane/src):                                     *)
(*   Fail          the holder reports `failed` (lease.reported), or        *)
(*                 createFailed past its attempts                          *)
(*   FRStart       do/sandbox.ts releaseFailed: failedReleaseDue says      *)
(*                 `release`; the fence issued (first await)               *)
(*   FRFleet       do/fleet.ts releaseFailedLease: the lease at (h, e)     *)
(*                 deleted and its incarnation recorded stale, one step    *)
(*   FRFinish      lib/sandbox-lease.ts failedReleased: unplaced, the      *)
(*                 epoch spent, if still failed on (h, e)                  *)
(*   RetryRelease, RetryPlace  do/sandbox.ts retryPlacement with a holder  *)
(*                 (fence, releaseFailedLease(h, e), lease.retried, then   *)
(*                 claim)                                                  *)
(*   RetryReleased retryPlacement without one (lease.retriedReleased,      *)
(*                 then claim)                                             *)
(*   Alarm         alarm `place`: placeWanted (never for `failed`)         *)
(*   Destroy       do/sandbox.ts destroy                                   *)
(*   HostLoss      the host dies; FleetDO's reassignment (leaseLost)       *)
(*   Salvage       nestd's retire: the salvage commit, decided by          *)
(*                 lib/sandbox-lease.ts decideCommit                       *)
(*   WindowPass, Reap  do/fleet.ts reapStale: sandbox_destroy once clean   *)
(*                 or past the salvage window                              *)
(*   Retire        do/fleet.ts scaleDown: an idle host retired             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Hosts, None,
  MaxEpoch,       \* epochs claimed, at most (a model bound)
  MaxFail,        \* failures, at most
  MaxRetry, MaxDestroy, MaxLoss, MaxReset, MaxNoCap,
  \* ---- switches: the code as it is first ----
  SpendEpoch,     \* TRUE: the release spends an epoch (failedReleased). FALSE: #192's first version
  Rollback,       \* TRUE: a placement that finds no host rolls its epoch back (B1, the owner's open decision)
  RetrySpends,    \* TRUE: an operator's retry of a sandbox failed on a host spends an epoch (lease.retried). FALSE: #192 as merged
  DeleteExact,    \* TRUE: releaseFailedLease deletes only the lease at (h, e). FALSE (mutation): the sandbox's lease, whatever it is
  RecordStale,    \* TRUE: the incarnation is recorded stale in the step that deletes the lease. FALSE (mutation)
  RetryRecords,   \* TRUE: an operator's retry records the incarnation it leaves as stale, as the release does (FleetDO.releaseFailedLease). FALSE: before (releaseLease: FleetDO learnt of it only from the host's next hello)
  RetireWaits     \* TRUE: scaleDown keeps a host with an incarnation not yet destroyed. FALSE (mutation, and the code before #192's review)

VARIABLES
  \* SandboxDO (durable)
  sState,   \* "creating" (stands for every live state), "failed", "destroyed"
  sHost, sEpoch,
  \* SandboxDO in memory: releaseFailed's continuation, and an operator's retry's
  rk, tk,
  \* FleetDO (durable)
  lease,    \* None, or [h, e]
  stale,    \* [h, e] -> "dirty" (not salvaged), "clean", "expired" (its window passed), "destroyed"
  \* hosts
  alive,
  \* ghosts
  held,          \* every (h, e) a lease was granted at
  left,          \* incarnations a deleted lease left on a live host, which may hold work not yet committed
  wrongDelete,   \* a lease other than the released one was deleted by the release
  lostWork,      \* a host was retired with an unsalvaged incarnation whose window hadn't passed
  refused,       \* a salvage was refused as stale (its work deleted)
  budget

vars == <<sState, sHost, sEpoch, rk, tk, lease, stale, alive, held, left, wrongDelete, lostWork, refused, budget>>

NoK == [stage |-> "none", h |-> None, e |-> 0]
Incs == [h : Hosts, e : 1..MaxEpoch]
Spend(k) == budget' = [budget EXCEPT ![k] = @ - 1]

Init ==
  /\ sState = "creating" /\ sEpoch = 1 /\ sHost \in Hosts
  /\ rk = NoK /\ tk = NoK
  /\ lease = [h |-> sHost, e |-> 1] /\ stale = [i \in {} |-> "dirty"]
  /\ alive = [h \in Hosts |-> TRUE]
  /\ held = {[h |-> sHost, e |-> 1]} /\ left = {} /\ wrongDelete = FALSE /\ lostWork = FALSE /\ refused = {}
  /\ budget = [fail |-> MaxFail, retry |-> MaxRetry, destroy |-> MaxDestroy, loss |-> MaxLoss, reset |-> MaxReset, nocap |-> MaxNoCap]

Live == {h \in Hosts : alive[h]}
StaleAt(h) == {i \in DOMAIN stale : i.h = h}

-----------------------------------------------------------------------------
(* Placement, as one step: claim the next epoch, FleetDO's answer, the record. *)

\* Unplaced and not destroyed: claim e + 1. FleetDO grants on a live host (not `excl`) if the sandbox
\* holds no lease, else refuses; no host or no room rolls the epoch back (Rollback).
Place(excl) ==
  /\ sHost = None /\ sState # "destroyed" /\ sEpoch < MaxEpoch
  /\ \/ /\ lease = None
        /\ \E h \in Live \ {excl} :
             /\ sHost' = h /\ sEpoch' = sEpoch + 1 /\ sState' = "creating"
             /\ lease' = [h |-> h, e |-> sEpoch + 1]
             /\ held' = held \cup {[h |-> h, e |-> sEpoch + 1]}
             \* Placed on a host that still holds an older incarnation: nestd salvages and replaces it at the create.
             /\ left' = {i \in left : i.h # h}
        /\ UNCHANGED budget
     \/ /\ lease # None \/ budget.nocap > 0
        /\ sEpoch' = IF Rollback THEN sEpoch ELSE sEpoch + 1
        /\ IF lease = None THEN Spend("nocap") ELSE UNCHANGED budget
        /\ UNCHANGED <<sHost, sState, lease, held, left>>

-----------------------------------------------------------------------------
(* SandboxDO *)

Fail ==
  \* (below MaxEpoch, so that its release can spend an epoch within the model's bound)
  /\ sState = "creating" /\ sHost # None /\ budget.fail > 0 /\ sEpoch < MaxEpoch
  /\ sState' = "failed" /\ Spend("fail")
  /\ UNCHANGED <<sHost, sEpoch, rk, tk, lease, stale, alive, held, left, wrongDelete, lostWork, refused>>

\* The `failed_release` deadline, its grace over: the fence is issued (an await).
FRStart ==
  /\ sState = "failed" /\ sHost # None /\ rk = NoK
  /\ rk' = [stage |-> "fence", h |-> sHost, e |-> sEpoch]
  /\ UNCHANGED <<sState, sHost, sEpoch, tk, lease, stale, alive, held, left, wrongDelete, lostWork, refused, budget>>

\* FleetDO.releaseFailedLease(h, e): the lease and the stale record in one step.
FRFleet ==
  /\ rk.stage = "fence"
  /\ LET mine == lease # None /\ lease.h = rk.h /\ lease.e = rk.e
         del  == IF DeleteExact THEN mine ELSE lease # None
     IN /\ lease' = IF del THEN None ELSE lease
        /\ wrongDelete' = (wrongDelete \/ (del /\ ~mine))
        /\ stale' = IF mine /\ RecordStale /\ [h |-> rk.h, e |-> rk.e] \notin DOMAIN stale
                      THEN [i \in DOMAIN stale \cup {[h |-> rk.h, e |-> rk.e]} |-> IF i \in DOMAIN stale THEN stale[i] ELSE "dirty"]
                      ELSE stale
  /\ left' = IF lease # None /\ lease.h = rk.h /\ lease.e = rk.e THEN left \cup {[h |-> rk.h, e |-> rk.e]} ELSE left
  /\ rk' = [rk EXCEPT !.stage = "release"]
  /\ UNCHANGED <<sState, sHost, sEpoch, tk, alive, held, lostWork, refused, budget>>

\* failedReleased: only if it is still failed on (h, e).
FRFinish ==
  /\ rk.stage = "release"
  /\ IF sState = "failed" /\ sHost = rk.h /\ sEpoch = rk.e
       THEN /\ sHost' = None /\ sEpoch' = IF SpendEpoch THEN sEpoch + 1 ELSE sEpoch
       ELSE UNCHANGED <<sHost, sEpoch>>
  /\ rk' = NoK
  /\ UNCHANGED <<sState, tk, lease, stale, alive, held, left, wrongDelete, lostWork, refused, budget>>

\* An operator's retry of a sandbox failed on a host: fence, then FleetDO.releaseFailedLease(h, e) (an
\* await): the lease at (h, e) and the stale record in one step, as the release's own.
RetryRelease ==
  /\ sState = "failed" /\ sHost # None /\ tk = NoK /\ budget.retry > 0
  /\ LET mine == lease # None /\ lease.h = sHost /\ lease.e = sEpoch
         inc  == [h |-> sHost, e |-> sEpoch]
     IN /\ lease' = IF mine THEN None ELSE lease
        /\ left' = IF mine THEN left \cup {inc} ELSE left
        /\ stale' = IF mine /\ RetryRecords /\ inc \notin DOMAIN stale
                      THEN [i \in DOMAIN stale \cup {inc} |-> IF i \in DOMAIN stale THEN stale[i] ELSE "dirty"]
                      ELSE stale
  /\ tk' = [stage |-> "retried", h |-> sHost, e |-> sEpoch]
  /\ Spend("retry")
  /\ UNCHANGED <<sState, sHost, sEpoch, rk, alive, held, wrongDelete, lostWork, refused>>

\* ... then lease.retried, if nothing moved: unplaced and creating; the claim follows (Alarm, or at once).
RetryPlace ==
  /\ tk.stage = "retried"
  /\ IF sState = "failed" /\ sHost = tk.h /\ sEpoch = tk.e
       THEN sHost' = None /\ sState' = "creating" /\ sEpoch' = IF RetrySpends THEN sEpoch + 1 ELSE sEpoch
       ELSE UNCHANGED <<sHost, sState, sEpoch>>
  /\ tk' = NoK
  /\ UNCHANGED <<rk, lease, stale, alive, held, left, wrongDelete, lostWork, refused, budget>>

\* An operator's retry of a failed sandbox whose lease was released: creating, then the claim.
RetryReleased ==
  /\ sState = "failed" /\ sHost = None /\ budget.retry > 0
  /\ sState' = "creating" /\ Spend("retry")
  /\ UNCHANGED <<sHost, sEpoch, rk, tk, lease, stale, alive, held, left, wrongDelete, lostWork, refused>>

\* The `place` alarm (and a retry's own claim): never for a failed sandbox.
Alarm ==
  /\ sState = "creating"
  /\ Place(None)
  /\ UNCHANGED <<rk, tk, stale, alive, wrongDelete, lostWork, refused>>

Destroy ==
  /\ sState # "destroyed" /\ budget.destroy > 0
  /\ sState' = "destroyed" /\ sHost' = None /\ lease' = None
  /\ Spend("destroy")
  /\ UNCHANGED <<sEpoch, rk, tk, stale, alive, held, left, wrongDelete, lostWork, refused>>

SbxReset ==
  /\ (rk # NoK \/ tk # NoK) /\ budget.reset > 0
  /\ rk' = NoK /\ tk' = NoK /\ Spend("reset")
  /\ UNCHANGED <<sState, sHost, sEpoch, lease, stale, alive, held, left, wrongDelete, lostWork, refused>>

-----------------------------------------------------------------------------
(* Hosts and FleetDO *)

\* A host dies. Its incarnations go with it; a lease there is lost: SandboxDO lets go (leaseLost,
\* whatever its state) and places again unless it is failed (placeWanted) -- here by the Alarm.
HostLoss(h) ==
  /\ alive[h] /\ budget.loss > 0
  /\ alive' = [alive EXCEPT ![h] = FALSE]
  /\ stale' = [i \in DOMAIN stale |-> IF i.h = h THEN "destroyed" ELSE stale[i]]
  /\ IF lease # None /\ lease.h = h
       THEN /\ lease' = None
            /\ IF sHost = h /\ sEpoch = lease.e /\ sState # "destroyed" THEN sHost' = None ELSE UNCHANGED sHost
       ELSE UNCHANGED <<lease, sHost>>
  /\ left' = {i \in left : i.h # h}
  /\ Spend("loss")
  /\ UNCHANGED <<sState, sEpoch, rk, tk, held, wrongDelete, lostWork, refused>>

\* nestd's salvage commit for a stale incarnation (decideCommit): an orphan from an older epoch's
\* holder, or the current holder's own; anything else is refused as stale and the work deleted.
Salvage(i) ==
  /\ i \in DOMAIN stale /\ stale[i] = "dirty" /\ alive[i.h]
  /\ LET orphan == i.e < sEpoch /\ i \in held
         holder == i.e = sEpoch /\ sHost = i.h
     IN refused' = IF orphan \/ holder \/ sState = "destroyed" THEN refused ELSE refused \cup {i}
  /\ stale' = [stale EXCEPT ![i] = "clean"]
  /\ UNCHANGED <<sState, sHost, sEpoch, rk, tk, lease, alive, held, left, wrongDelete, lostWork, budget>>

\* The salvage window passes for one that never salvaged.
WindowPass(i) ==
  /\ i \in DOMAIN stale /\ stale[i] = "dirty"
  /\ stale' = [stale EXCEPT ![i] = "expired"]
  /\ UNCHANGED <<sState, sHost, sEpoch, rk, tk, lease, alive, held, left, wrongDelete, lostWork, refused, budget>>

\* reapStale: sandbox_destroy for one that is clean or past its window.
Reap(i) ==
  /\ i \in DOMAIN stale /\ stale[i] \in {"clean", "expired"} /\ alive[i.h]
  /\ stale' = [stale EXCEPT ![i] = "destroyed"]
  /\ UNCHANGED <<sState, sHost, sEpoch, rk, tk, lease, alive, held, left, wrongDelete, lostWork, refused, budget>>

\* scaleDown retires an idle host: no lease on it, and (RetireWaits) no incarnation not yet destroyed.
Retire(h) ==
  /\ alive[h]
  /\ ~(lease # None /\ lease.h = h)
  /\ RetireWaits => \A i \in StaleAt(h) : stale[i] = "destroyed"
  /\ alive' = [alive EXCEPT ![h] = FALSE]
  \* Work lost: an incarnation left there that FleetDO never recorded, or one recorded and not yet salvaged.
  /\ lostWork' = (lostWork \/ \E i \in left : i.h = h /\ (i \notin DOMAIN stale \/ stale[i] = "dirty"))
  /\ left' = {i \in left : i.h # h}
  /\ stale' = [i \in DOMAIN stale |-> IF i.h = h THEN "destroyed" ELSE stale[i]]
  /\ UNCHANGED <<sState, sHost, sEpoch, rk, tk, lease, held, wrongDelete, refused, budget>>

-----------------------------------------------------------------------------
Next ==
  \/ Fail \/ FRStart \/ FRFleet \/ FRFinish \/ RetryRelease \/ RetryPlace \/ RetryReleased \/ Alarm \/ Destroy \/ SbxReset
  \/ \E h \in Hosts : HostLoss(h) \/ Retire(h)
  \/ \E i \in Incs : Salvage(i) \/ WindowPass(i) \/ Reap(i)

\* Fairness: the release's steps and deadline, the retry's continuation, the window and the reaper.
\* Not: failures, the operator, host loss, retirement, a salvage (a host may never manage one), the alarm.
Fairness ==
  /\ WF_vars(FRStart) /\ WF_vars(FRFleet) /\ WF_vars(FRFinish) /\ WF_vars(RetryPlace)
  /\ \A i \in Incs : WF_vars(WindowPass(i)) /\ WF_vars(Reap(i))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ sState \in {"creating", "failed", "destroyed"} /\ sHost \in Hosts \cup {None} /\ sEpoch \in 1..MaxEpoch
  /\ lease \in {None} \cup Incs /\ DOMAIN stale \subseteq Incs

\* Unplaced, the sandbox's epoch is above every incarnation not yet salvaged: its salvage is an older
\* epoch's (an orphan), never the current one's with no holder (refused as stale).
EpochAboveStale ==
  (sHost = None /\ sState # "destroyed") => \A i \in DOMAIN stale : stale[i] = "dirty" => i.e < sEpoch

\* No recorded incarnation's salvage is refused.
SalvageAccepted == refused = {}

\* The release deletes no lease but the one at (h, e).
OnlyItsLease == ~wrongDelete

\* No host is retired with an incarnation a released lease left there, unrecorded or not yet salvaged,
\* before its window has passed.
NoWorkLostToRetire == ~lostWork

\* A failed sandbox with a host has a lease there or a release under way or due (never pinned silently).
\* Liveness: every recorded incarnation is eventually destroyed (or its host is gone).
StaleReaped == <>[](\A i \in DOMAIN stale : stale[i] = "destroyed")

\* The host is eventually free of a failed sandbox: released, retried, destroyed, or the host gone.
FailedReleases == <>[](~(sState = "failed" /\ sHost # None))

\* Reachability (expected violated).
NoRelease      == ~(sState = "failed" /\ sHost = None)
NoRetiredAfter == ~(\E i \in DOMAIN stale : stale[i] = "destroyed" /\ ~alive[i.h] /\ sState = "failed")
NoReplaced     == ~(sState = "creating" /\ sHost # None /\ sEpoch >= 3 /\ DOMAIN stale # {})

=============================================================================

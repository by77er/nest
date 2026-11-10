--------------------------- MODULE SlotFollowups ---------------------------
(***************************************************************************)
(* The follow-ups of the sandbox lease that the state-machine sweep found  *)
(* lost (docs/verification/sandbox-lease/, 2026-11-06): a command result's *)
(* follow-up (bug 2) and a new placement's follow-ups (bug 3), with the    *)
(* one agent slot they configure and the bindings `resolve` mints from it. *)
(*                                                                         *)
(* It sits beside SandboxLease.tla, which models the lease itself; this    *)
(* module abstracts the lease to "the sandbox is placed at epoch e on host *)
(* h, and may move to another host at e + 1", and models what the lease   *)
(* model leaves out: the slot set (gateway-bindings P1-P6), the           *)
(* agent_attach commands and their results, FleetDO's follow-up of a      *)
(* result split at its await, SandboxDO's `afterPlaced` split at its       *)
(* awaits, the resets of both objects, a failed DO-to-DO call, a throw,    *)
(* nestd's resend of an unacked result, and Resolve.                      *)
(*                                                                         *)
(* One sandbox, one agent, the hosts in Hosts. Every DO step between       *)
(* awaits is atomic (the input gate); continuations held in memory are    *)
(* explicit (fk, sk) and lost on a reset.                                  *)
(*                                                                         *)
(* Action -> code (control-plane/src at the head this was checked, see    *)
(* docs/verification/sandbox-lease/conformance/):                          *)
(*   Move            sandbox.ts placeCurrentEpoch -> placeAnswered decide  *)
(*                   (+ placedStep, owePlaced when FixPlacement); also     *)
(*                   reconcilePlacing's `adopted`                          *)
(*   SecretsStep     sandbox.ts afterPlaced: pushSecrets (an await)        *)
(*   IssueStep       sandbox.ts afterPlaced: issueAttachesOrRetry (old:    *)
(*                   slots.newPlacement here; fixed: slots.due)            *)
(*   PlacedDone      sandbox.ts afterPlaced's end (clears `placed`)        *)
(*   PlacedDeadline  sandbox.ts alarm `placed`                             *)
(*   ThrowStep       pushSecrets throws (BrokerDO, FleetDO RPC)           *)
(*   IssueAttach     sandbox.ts issueAttachCommands: slots.due + sent      *)
(*                   (a running report, attach_retry, afterPlaced)        *)
(*   HostApply       nestd agent_attach at the holder's epoch, its result  *)
(*   Recv            fleet.ts onCommandResult: resultStep record / rerun   *)
(*   Deliver         sandbox.ts attachResult (slots.attachResult), the     *)
(*                   step FleetDO's await reaches                          *)
(*   Finish          fleet.ts runFollowups' end (followup_ms := NULL),    *)
(*                   then the batch's ack                                  *)
(*   LoseCall        the DO-to-DO call fails (fixed: caught, owed kept)   *)
(*   Rerun           fleet.ts alarm `followups` (followupsDue)             *)
(*   FleetReset / SbxReset  a reset: in-memory continuations lost          *)
(*   Run             sandbox.ts reportState (lease.reported): `running`    *)
(*   Resolve         sandbox.ts resolve: slots.unbindable, then a binding  *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Hosts, None,
  MaxEpoch,      \* placements: epochs 1..MaxEpoch (a model bound)
  MaxCmd,        \* agent_attach commands issued, at most (a model bound)
  MaxReset,      \* resets of each object, and failed calls and throws, at most
  FixResults,    \* TRUE: a result's follow-ups are owed in its step and re-run (bug 2 fixed)
  FixPlacement,  \* TRUE: a placement resets its slots in its step and owes afterPlaced (bug 3 fixed)
  MutNoPlacedDeadline, \* mutation: the slots reset in the step, but no `placed` deadline
  MutNoRerun           \* mutation: follow-ups owed, but no `followups` deadline (only redeliveries)

ASSUME MaxEpoch \in Nat /\ MaxEpoch >= 1 /\ MaxCmd \in Nat /\ MaxReset \in Nat

VARIABLES
  \* SandboxDO (durable)
  sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets,
  \* SandboxDO in memory: afterPlaced's continuation ("none", "secrets", "issue")
  sk,
  \* FleetDO (durable): each command's recorded result and whether its follow-up is owed
  fRec, fOwed,
  \* FleetDO in memory: follow-ups running (the await on SandboxDO), and those past it
  fk, fk2,
  \* nestd: the slots its guests have configured ([h, e]: on host h at epoch e),
  \* commands sent and not applied, results sent and not acked
  gSlots, toHost, res,
  \* ghosts
  nCmd, confirmed, bindings, applied, budget

vars == <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk,
          fRec, fOwed, fk, fk2, gSlots, toHost, res, nCmd, confirmed, bindings, applied, budget>>

Cmds == [n : 1..MaxCmd, h : Hosts, e : 1..MaxEpoch]
NoCmd == [n |-> 0, h |-> None, e |-> 0]

Init ==
  /\ sEpoch = 1 /\ sHost \in Hosts /\ sRunning = FALSE
  /\ sPending = TRUE /\ sInflight = NoCmd /\ sPlacedOwed = FALSE /\ sSecrets = 1 /\ sk = "none"
  /\ fRec = {} /\ fOwed = {} /\ fk = {} /\ fk2 = {}
  /\ gSlots = {} /\ toHost = {} /\ res = {}
  /\ nCmd = 0 /\ confirmed = {} /\ bindings = {} /\ applied = {}
  /\ budget = [fleet |-> MaxReset, sbx |-> MaxReset, lose |-> MaxReset, throw |-> MaxReset]

-----------------------------------------------------------------------------
(* SandboxDO *)

\* A new placement on another host at the next epoch (the lease's own steps abstracted).
Move ==
  /\ sEpoch < MaxEpoch
  /\ \E h \in Hosts \ {sHost} :
       /\ sEpoch' = sEpoch + 1 /\ sHost' = h
       \* A placement answered is creating; an adopted lease (reconcilePlacing) may already be running.
       /\ sRunning' \in BOOLEAN
       /\ IF FixPlacement
            THEN /\ sPending' = TRUE /\ sInflight' = NoCmd               \* placedStep
                 /\ sPlacedOwed' = ~MutNoPlacedDeadline                   \* owePlaced
            ELSE UNCHANGED <<sPending, sInflight, sPlacedOwed>>
       /\ sk' = "secrets"
  /\ UNCHANGED <<sSecrets, fRec, fOwed, fk, fk2, gSlots, toHost, res, nCmd, confirmed, bindings, applied, budget>>

SecretsStep ==
  /\ sk = "secrets"
  /\ sSecrets' = sEpoch /\ sk' = "issue"
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, bindings, applied, budget>>

ThrowStep ==
  /\ sk = "secrets" /\ budget.throw > 0
  /\ sk' = "none" /\ budget' = [budget EXCEPT !.throw = @ - 1]
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, bindings, applied>>

\* Old: the slot reset happens here (slots.newPlacement), after an await. Fixed: it happened in Move.
IssueStep ==
  /\ sk = "issue"
  /\ IF FixPlacement THEN UNCHANGED <<sPending, sInflight>>
     ELSE sPending' = TRUE /\ sInflight' = NoCmd
  /\ sk' = "none"
  /\ sPlacedOwed' = FALSE                                                   \* afterPlaced's end
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sSecrets, fRec, fOwed, fk, fk2, gSlots, toHost, res, nCmd, confirmed, bindings, applied, budget>>

PlacedDeadline ==
  /\ sPlacedOwed /\ sk = "none"
  /\ sk' = "secrets"
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, bindings, applied, budget>>

SbxReset ==
  /\ budget.sbx > 0 /\ sk # "none"
  /\ sk' = "none" /\ budget' = [budget EXCEPT !.sbx = @ - 1]
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, bindings, applied>>

\* slots.due + issue: a pending slot with nothing in flight gets an agent_attach for this placement.
IssueAttach ==
  /\ sPending /\ sInflight = NoCmd /\ nCmd < MaxCmd
  /\ LET c == [n |-> nCmd + 1, h |-> sHost, e |-> sEpoch] IN
       /\ sInflight' = c /\ toHost' = toHost \cup {c} /\ nCmd' = nCmd + 1
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk, fk2, gSlots, res, confirmed, bindings, applied, budget>>

\* The holder reports `running` (reportState: lease.reported).
Run ==
  /\ ~sRunning
  /\ sRunning' = TRUE
  /\ UNCHANGED <<sEpoch, sHost, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, bindings, applied, budget>>

\* resolve: a binding at the current epoch when slots.unbindable allows it (placed, running, not pending).
Resolve ==
  /\ sRunning /\ ~sPending
  /\ bindings' = bindings \cup {[e |-> sEpoch, h |-> sHost]}
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk, fk2, gSlots, toHost, res,
                 nCmd, confirmed, applied, budget>>

-----------------------------------------------------------------------------
(* nestd *)

\* The host applies an agent_attach (at the epoch it was sent for) and sends its result.
HostApply ==
  \E c \in toHost :
    /\ gSlots' = gSlots \cup {[e |-> c.e, h |-> c.h]}
    /\ toHost' = toHost \ {c} /\ res' = res \cup {c}
    /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk, fk2, nCmd,
                   confirmed, bindings, applied, budget>>

-----------------------------------------------------------------------------
(* FleetDO *)

\* A result arrives (first or resent): resultStep. Its follow-up's call is then in flight (fk).
Recv ==
  \E c \in res :
    /\ c \notin fk /\ c \notin fk2
    /\ IF c \notin fRec
         THEN /\ fRec' = fRec \cup {c}
              /\ fOwed' = IF FixResults THEN fOwed \cup {c} ELSE fOwed
              /\ fk' = fk \cup {c} /\ res' = res
         ELSE IF FixResults /\ c \in fOwed
           THEN /\ fk' = fk \cup {c} /\ UNCHANGED <<fRec, fOwed, res>>        \* rerun
           ELSE /\ res' = res \ {c} /\ UNCHANGED <<fRec, fOwed, fk>>           \* ignored, acked
    /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fk2, gSlots, toHost, nCmd,
                   confirmed, bindings, applied, budget>>

\* SandboxDO.attachResult, reached by FleetDO's await: idempotent (stale unless it's the slot's command).
Deliver ==
  \E c \in fk :
    /\ IF sInflight = c /\ c.e = sEpoch
         THEN /\ sPending' = FALSE /\ sInflight' = NoCmd /\ confirmed' = confirmed \cup {c.e}
         ELSE UNCHANGED <<sPending, sInflight, confirmed>>
    /\ applied' = applied \cup {c}
    /\ fk' = fk \ {c} /\ fk2' = fk2 \cup {c}
    /\ UNCHANGED <<sEpoch, sHost, sRunning, sPlacedOwed, sSecrets, sk, fRec, fOwed, gSlots, toHost, res, nCmd, bindings, budget>>

\* The follow-up's end: no longer owed; the batch is acked.
Finish ==
  \E c \in fk2 :
    /\ fOwed' = fOwed \ {c} /\ fk2' = fk2 \ {c} /\ res' = res \ {c}
    /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fk, gSlots, toHost, nCmd,
                   confirmed, bindings, applied, budget>>

\* The call to SandboxDO fails. Old: thrown, the batch unacked (resent, then ignored). Fixed: caught,
\* owed kept, the batch acked.
LoseCall ==
  /\ budget.lose > 0
  /\ \E c \in fk :
       /\ fk' = fk \ {c}
       /\ res' = IF FixResults THEN res \ {c} ELSE res
       /\ budget' = [budget EXCEPT !.lose = @ - 1]
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk2, gSlots, toHost, nCmd,
                 confirmed, bindings, applied>>

\* The `followups` deadline: an owed follow-up not running is run again.
Rerun ==
  /\ FixResults /\ ~MutNoRerun
  /\ \E c \in fOwed :
       /\ c \notin fk /\ c \notin fk2
       /\ fk' = fk \cup {c}
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, fk2, gSlots, toHost, res, nCmd,
                 confirmed, bindings, applied, budget>>

FleetReset ==
  /\ budget.fleet > 0 /\ (fk # {} \/ fk2 # {})
  /\ fk' = {} /\ fk2' = {} /\ budget' = [budget EXCEPT !.fleet = @ - 1]
  /\ UNCHANGED <<sEpoch, sHost, sRunning, sPending, sInflight, sPlacedOwed, sSecrets, sk, fRec, fOwed, gSlots, toHost, res, nCmd,
                 confirmed, bindings, applied>>

-----------------------------------------------------------------------------
Next ==
  \/ Move \/ SecretsStep \/ ThrowStep \/ IssueStep \/ PlacedDeadline \/ SbxReset \/ IssueAttach \/ Run \/ Resolve
  \/ HostApply \/ Recv \/ Deliver \/ Finish \/ LoseCall \/ Rerun \/ FleetReset

\* Fairness: every step that isn't a fault, a move or a client's call.
Fairness ==
  /\ WF_vars(SecretsStep) /\ WF_vars(IssueStep) /\ WF_vars(PlacedDeadline) /\ WF_vars(IssueAttach) /\ WF_vars(Run)
  /\ WF_vars(HostApply) /\ WF_vars(Recv) /\ WF_vars(Deliver) /\ WF_vars(Finish) /\ WF_vars(Rerun)

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ sEpoch \in 1..MaxEpoch /\ sHost \in Hosts /\ sRunning \in BOOLEAN /\ sPending \in BOOLEAN /\ sk \in {"none", "secrets", "issue"}
  /\ sInflight \in Cmds \cup {NoCmd} /\ fRec \subseteq Cmds /\ fOwed \subseteq fRec

\* A binding is minted at epoch e only for an agent whose agent_attach at e was confirmed,
\* and so only for a slot the guest at that placement has configured.
BindingOnlyConfirmed == \A b \in bindings : b.e \in confirmed
BindingConfigured    == bindings \subseteq gSlots

\* Every recorded result's follow-up eventually runs (`applied`), and none stays owed.
FollowupsDone == <>[](fRec \subseteq applied /\ fOwed = {})

\* The agent eventually has hands: its slot confirmed at the placement that lasts.
HandsEventually == <>[](~sPending /\ sInflight = NoCmd)

\* A placement's follow-ups (here, its secrets) eventually run for the placement that lasts.
PlacedDone == <>[](sSecrets = sEpoch)

\* Reachability (expected violated): a follow-up is re-run after a cut, and a placement's
\* follow-ups are cut by a throw or a reset.
NoRerun     == ~(\E c \in fOwed : c \notin fk /\ c \notin fk2 /\ c \notin res)
NoCut       == ~(sk = "none" /\ sSecrets # sEpoch)
NoMovedBind == ~(\E b \in bindings : b.e > 1)

=============================================================================

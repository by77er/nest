---------------------------- MODULE SandboxLease ----------------------------
(***************************************************************************)
(* The sandbox placement / lease / epoch / fencing / STONITH / salvage /   *)
(* commit protocol of nest, for ONE sandbox, one cell (FleetDO) and a     *)
(* small set of sandbox hosts (nestd). Written against main (edf6829);     *)
(* each switch's value on main is given first, and the code as refactored *)
(* (refactor/all) is: FixDestroy, FixStonithFence, FixQueue TRUE; the rest *)
(* as on main.                                                             *)
(*                                                                         *)
(* Every DO method is split at each `await` on another object; the steps  *)
(* between awaits are atomic (DO input gate). Async continuations are      *)
(* explicit records (sk, llIn); RPC requests/answers are message sets.     *)
(*                                                                         *)
(* Action -> code. SandboxDO's decisions are the pure functions of        *)
(* control-plane/src/lib/sandbox-lease.ts (L); the shells are methods of   *)
(* SandboxDO (S, do/sandbox.ts) and FleetDO (F, do/fleet.ts); nestd is     *)
(* crates/nestd/src/host.rs (H) and fleet.rs (NF). Line numbers (S:n,    *)
(* F:n, H:n) in the comments below are main's (edf6829).                  *)
(*   PlaceStart          L claim; S placeCurrentEpoch, alarm `place`       *)
(*                       (L placeWanted), wake, evicted, leaseLost         *)
(*   ServePlaceGrant/Other F place (idempotent per epoch, refuse other-    *)
(*                       epoch lease and a destroyed sandbox, candidates   *)
(*                       active+connected; L pickSandboxHost)              *)
(*   ResumePlace         L placeAnswered (rollback: B1); S discardPlacement*)
(*   ReconcileStart/Resume L reconcileAt, reconciled; S reconcilePlacing,  *)
(*                       discardPlacement; F leaseOf                       *)
(*   ServeLL             L leaseLost; S leaseLost (+ placeCurrentEpoch)    *)
(*   DestroyStart/ServeRelease/ResumeDestroy L destroyed; S destroy;       *)
(*                       F sandboxDestroyed, releaseLease                  *)
(*   DoCommit            L decideCommit; S commit                          *)
(*   FleetEvent          F handleEvent (state, commit_request, holderFenced*)
(*                       onCommandResult -> stonithDoneIfClear)            *)
(*   Expire              F tick (expiryVerdict) + expireHost               *)
(*   Ec2Terminate/PollStonith F expireHost, pollStonith, confirmHostDead;  *)
(*                       isDead lib/ec2.ts                                 *)
(*   EnsureFence/StonithClear F ensureStonithFence, stonithDoneIfClear,    *)
(*                       hostStep in lib/host-lifecycle.ts                 *)
(*   ProcessReassign/ResumeLL F queueReassign, processReassign            *)
(*   HbSend/HbRecv/AckRecv NF:310-320, F onHeartbeat, NF:372-395 renew     *)
(*   Connect             F onHello + reconcileSandboxes + dropUnreported;  *)
(*                       NF:285 hello_ack renews                           *)
(*   SelfFence           H:1056-1094 lease_watchdog / self_fence           *)
(*   HostCmd             H:779-820 fence at once; H:1404-1490 create;      *)
(*                       H:2150-2175 apply_commit; H:1176-1215 retire      *)
(*   CommitSend/SalvageSend/Timeout H:2040-2122 commit, send_commit,       *)
(*                       unanswered resend                                 *)
(*   NestdCrash/HostDie/Ec2Die, SbxReset/FleetReset/LoseAnswer: faults     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Hosts, None,
  MaxEpoch,      \* CONSTRAINT StateBound cuts states past it (model bound, not a code limit)
  MaxSends,      \* bound on commit requests sent (normal + salvage)
  F,             \* host self-fence after F ticks from the acked send (20 s)
  E,             \* FleetDO expiry after E ticks of silence (30 s)
  MaxCrash, MaxReset, MaxDisc, MaxLose, MaxDestroy,
  HistoryMax,    \* S:96 HISTORY_MAX (50)
  \* ---- switches: the value as on main is given first ----
  RollbackEpoch,      \* TRUE: S:312 rolls the epoch back on no capacity / refusal
  CommitEpochCheck,   \* TRUE: S:585 epoch/host check
  Stonith,            \* TRUE: expiry waits for STONITH; FALSE: reassign at once (mutation)
  ShuttingDownIsDead, \* TRUE: ec2.ts:45 counts shutting-down as dead
  WatchdogOnce,       \* TRUE: H:1066-1072 fences once, then waits for a renewal
  DelayedRpc,         \* FALSE: a DO RPC is delivered before the 60 s marker goes stale
  NoCapAllowed,       \* TRUE: place may answer "no capacity" even with candidates
  FixDestroy,         \* FALSE: destroy neither blocks the continuation nor FleetDO.place
  ResendFailIsFinal,  \* TRUE: H:2052-2058 + H:1193 an unanswered resend's STALE ends retire
  FixSalvage,         \* FALSE: S:575-585 salvage only below the epoch, checked against history
  FixLeaseLost,       \* FALSE: S:469-472 a lease lost while `placing` is set counts as handled
  FixStonithFence,    \* FALSE: F:1806-1808 any reassign row for the sandbox suppresses the fence
  FixQueue            \* FALSE: F:1849-1850 reassign_queue keyed by sandbox, INSERT OR IGNORE

ASSUME F \in Nat /\ E \in Nat /\ F > 0 /\ E > 0

VARIABLES
  \* SandboxDO (durable)
  sEpoch, sHost, sPlacing, sLost, sHead, sHist, sDestroyed, sStored,
  \* SandboxDO in-memory continuations
  sk,
  \* FleetDO (durable)
  lease, status, silence, queue, fencePending, fleetDestroyed,
  \* FleetDO in-memory continuations (leaseLost calls in flight)
  llIn,
  \* hosts
  alive, connected, fenceLeft, wdFired, hb, row, retiring, newProc, ec2,
  \* channels
  hostEv, cmds, req, ans, llReq, llAns,
  \* ghosts and fault budgets
  granted, expiredG, settled, gens, nGen, nSend,
  writerBad, stonithBad, salvageRefused, destroyedEver, budget

sbxVars   == <<sEpoch, sHost, sPlacing, sLost, sHead, sHist, sDestroyed, sStored, sk>>
fleetVars == <<lease, status, silence, queue, fencePending, fleetDestroyed, llIn>>
hostVars  == <<alive, connected, fenceLeft, wdFired, hb, row, retiring, newProc, ec2>>
chanVars  == <<hostEv, cmds, req, ans, llReq, llAns>>
ghostVars == <<granted, expiredG, settled, gens, nGen, nSend, writerBad, stonithBad,
               salvageRefused, destroyedEver, budget>>
vars == <<sbxVars, fleetVars, hostVars, chanVars, ghostVars>>

-----------------------------------------------------------------------------
NoQ     == [h |-> None, e |-> 0, dead |-> FALSE]
NoLease == [h |-> None, e |-> 0, x |-> FALSE]
NoRow   == [e |-> 0, st |-> "none", dirty |-> FALSE, head |-> 0, busy |-> "no", par |-> 0]
NoHb    == [d |-> "none", age |-> 0, c |-> 0]
Ev(t, e, parent, salv)    == [t |-> t, e |-> e, parent |-> parent, salv |-> salv]
Cmd(t, e, x, flag, out)   == [t |-> t, e |-> e, x |-> x, flag |-> flag, out |-> out]
K(kind, e, before, from, ll) == [kind |-> kind, e |-> e, before |-> before, from |-> from, ll |-> ll]
Ans(k, v, h, l) == [k |-> k, v |-> v, h |-> h, l |-> l]

Min2(a, b) == IF a < b THEN a ELSE b
MinOf(S)   == CHOOSE x \in S : \A y \in S : x <= y
CapHist(s) == IF Len(s) > HistoryMax THEN SubSeq(s, Len(s) - HistoryMax + 1, Len(s)) ELSE s

Running(h) == alive[h] /\ row[h].st = "run"

\* fence_sandbox (H:1110): Fenced is terminal; a dirty incarnation is retired (salvaged).
FenceRow(r)     == IF r.st = "run" THEN [r EXCEPT !.st = "fenced"] ELSE r
RetireOf(r)     == [e |-> r.e, head |-> r.head, sent |-> FALSE, unans |-> r.busy = "unans", par |-> r.par]
FenceRet(r, rt) == IF r.st = "run" /\ r.dirty THEN rt \cup {RetireOf(r)} ELSE rt
FenceEvs(r)     == IF r.st = "run" THEN <<Ev("fenced", r.e, 0, FALSE)>> ELSE <<>>

Cands == {c \in Hosts : status[c] = "active" /\ connected[c]}
Answer(k, v, h, l) == IF k \in sk THEN ans \cup {Ans(k, v, h, l)} ELSE ans
\* releaseLease for epoch e (0: every epoch, as destroy asks).
Release(k, e) == [t |-> "release", k |-> k, e |-> e]
\* discardPlacement (FixDestroy): a lease a continuation finds granted at e to a destroyed sandbox
\* is released, and the VM sent with it destroyed when its host is known (h # None).
DiscardReq(e)     == req \cup {Release(K("discard", e, 0, 0, NoQ), e)}
DiscardCmds(h, e) == IF h # None THEN [cmds EXCEPT ![h] = Append(@, Cmd("destroy", e, 0, "", ""))] ELSE cmds
LLAnswer(q, ok)    == IF q \in llIn THEN llAns \cup {[q |-> q, ok |-> ok]} ELSE llAns
\* reassign_queue: PRIMARY KEY sandbox, INSERT OR IGNORE (F:1849-1850): a second loss of the
\* sandbox while a row is queued is dropped. The fix keys rows by (sandbox, host, epoch).
QRow(h, e, dead)   == [h |-> h, e |-> e, dead |-> dead]
QueueIns(r)        == IF FixQueue THEN queue \cup {r} ELSE IF queue = {} THEN {r} ELSE queue
QueueAdd(h, dead)  == IF lease.h = h THEN QueueIns(QRow(h, lease.e, dead)) ELSE queue
\* No DO-to-DO RPC in flight (a lost answer has become "fail"). Time does not pass and no host
\* boots a VM while one is: RPCs take milliseconds, a tick is ~10 s, a boot takes seconds.
RpcQuiet == DelayedRpc \/ (req = {} /\ llReq = {} /\ llAns = {} /\ \A a \in ans : a.v = "fail")
\* A fence already on its way to a reachable host acts on arrival (H:795-801), milliseconds after
\* it is sent; no other host finishes booting (seconds) first. Unverified timing assumption.
FenceQuiet(c) == \A h \in Hosts \ {c} :
                   ~(alive[h] /\ (connected[h] \/ status[h] = "dead")
                     /\ \E i \in 1..Len(cmds[h]) : cmds[h][i].t = "fence")
SFDue(h) == IF WatchdogOnce THEN ~wdFired[h] ELSE (~wdFired[h] \/ row[h].st = "run")

-----------------------------------------------------------------------------
Init ==
  /\ sEpoch = 0 /\ sHost = None /\ sPlacing = 0 /\ sLost = None /\ sHead = 0
  /\ sHist = <<>> /\ sDestroyed = FALSE /\ sStored = {} /\ sk = {}
  /\ lease = NoLease /\ status = [h \in Hosts |-> "active"] /\ silence = [h \in Hosts |-> 0]
  /\ queue = {} /\ fencePending = [h \in Hosts |-> FALSE] /\ fleetDestroyed = FALSE /\ llIn = {}
  /\ alive = [h \in Hosts |-> TRUE] /\ connected = [h \in Hosts |-> TRUE]
  /\ fenceLeft = [h \in Hosts |-> F] /\ wdFired = [h \in Hosts |-> FALSE]
  /\ hb = [h \in Hosts |-> NoHb] /\ row = [h \in Hosts |-> NoRow]
  /\ retiring = [h \in Hosts |-> {}] /\ newProc = [h \in Hosts |-> FALSE]
  /\ ec2 = [h \in Hosts |-> "running"]
  /\ hostEv = [h \in Hosts |-> <<>>] /\ cmds = [h \in Hosts |-> <<>>]
  /\ req = {} /\ ans = {} /\ llReq = {} /\ llAns = {}
  /\ granted = {} /\ expiredG = {} /\ settled = {} /\ gens = {} /\ nGen = 0 /\ nSend = 0
  /\ writerBad = FALSE /\ stonithBad = FALSE /\ salvageRefused = {} /\ destroyedEver = FALSE
  /\ budget = [crash |-> 0, reset |-> 0, disc |-> 0, lose |-> 0, destroy |-> 0]

-----------------------------------------------------------------------------
(* ---------------- SandboxDO ---------------- *)

\* The claim of placeCurrentEpoch (S:267-281): synchronous with whatever led to it.
ClaimVars(ll) ==
  LET k == K("place", sEpoch + 1, sEpoch, sHead, ll) IN
  /\ sEpoch' = sEpoch + 1
  /\ sPlacing' = sEpoch + 1
  /\ sk' = sk \cup {k}
  /\ req' = req \cup {[t |-> "place", k |-> k]}

\* Any trigger: create (epoch 0), the `place` alarm (S:668-674), wake (S:382), evicted.
PlaceStart ==
  /\ ~sDestroyed /\ sHost = None /\ sPlacing = 0
  /\ ClaimVars(NoQ)
  /\ UNCHANGED <<sHost, sLost, sHead, sHist, sDestroyed, sStored, fleetVars, hostVars,
                 hostEv, cmds, ans, llReq, llAns, ghostVars>>

\* placeCurrentEpoch continuation (S:300-319).
ResumePlace(a) ==
  /\ a \in ans /\ a.k.kind = "place" /\ a.k \in sk
  /\ LET k == a.k
         fail == a.v = "fail"
         refused == a.v = "refused"
         noCap == a.v = "null"
         got == a.v = "host"
         act == sPlacing = k.e /\ ~fail /\ (FixDestroy => ~sDestroyed)
     IN /\ sPlacing' = IF act THEN 0 ELSE sPlacing
        /\ sEpoch' = IF act /\ (noCap \/ refused) /\ RollbackEpoch /\ sEpoch = k.e THEN k.before ELSE sEpoch
        /\ sHost' = IF act /\ got THEN a.h ELSE sHost
        /\ sHist' = IF act /\ got THEN CapHist(Append(sHist, [e |-> k.e, h |-> a.h])) ELSE sHist
        /\ sLost' = IF act /\ got THEN None ELSE sLost
        \* i.state = "creating"/"restoring" overwrites "destroyed" (S:315)
        /\ sDestroyed' = IF act /\ got THEN FALSE ELSE sDestroyed
        /\ sk' = sk \ {k}
        /\ ans' = ans \ {a}
        /\ llAns' = IF k.ll # NoQ THEN LLAnswer(k.ll, ~(fail \/ refused)) ELSE llAns
        \* Fixed: destroyed meanwhile (`placeAnswered` is "stale"): what it may have got is discarded.
        /\ LET discard == FixDestroy /\ sDestroyed /\ (got \/ fail) IN
           /\ req' = IF discard THEN DiscardReq(k.e) ELSE req
           /\ cmds' = IF discard /\ got THEN DiscardCmds(a.h, k.e) ELSE cmds
  /\ UNCHANGED <<sHead, sStored, fleetVars, hostVars, hostEv, llReq, ghostVars>>

\* reconcilePlacing (S:220-229): only once the marker is stale (60 s); unless DelayedRpc,
\* by then the place request has been delivered and its call has ended (answered, lost, reset).
ReconcileStart ==
  /\ sPlacing # 0
  /\ DelayedRpc \/ (/\ ~\E r \in req : r.t = "place" /\ r.k.e = sPlacing
                    /\ ~\E k \in sk : k.kind = "place" /\ k.e = sPlacing)
  /\ ~\E k \in sk : k.kind = "reconcile"
  /\ LET k == K("reconcile", sPlacing, 0, 0, NoQ) IN
     /\ sk' = sk \cup {k}
     /\ req' = req \cup {[t |-> "leaseOf", k |-> k]}
  /\ UNCHANGED <<sEpoch, sHost, sPlacing, sLost, sHead, sHist, sDestroyed, sStored,
                 fleetVars, hostVars, hostEv, cmds, ans, llReq, llAns, ghostVars>>

ResumeReconcile(a) ==
  /\ a \in ans /\ a.k.kind = "reconcile" /\ a.k \in sk
  /\ LET k == a.k
         L == a.l
         act == a.v # "fail" /\ sPlacing = k.e
         adopt == act /\ L.h # None /\ L.e = k.e /\ ~L.x /\ (FixDestroy => ~sDestroyed)
     IN /\ sPlacing' = IF act THEN 0 ELSE sPlacing
        /\ sHost' = IF adopt THEN L.h ELSE sHost
        /\ sHist' = IF adopt THEN CapHist(Append(sHist, [e |-> k.e, h |-> L.h])) ELSE sHist
        /\ sLost' = IF adopt THEN None ELSE sLost
        /\ sDestroyed' = IF adopt THEN FALSE ELSE sDestroyed
        /\ sk' = sk \ {k}
        /\ ans' = ans \ {a}
        \* Fixed: destroyed meanwhile (`reconciled` is "gone"): a lease at the epoch is discarded.
        /\ LET discard == FixDestroy /\ sDestroyed /\ a.v # "fail" /\ L.h # None /\ L.e = k.e IN
           /\ req' = IF discard THEN DiscardReq(k.e) ELSE req
           /\ cmds' = IF discard THEN DiscardCmds(L.h, k.e) ELSE cmds
  /\ UNCHANGED <<sEpoch, sHead, sStored, fleetVars, hostVars, hostEv, llReq, llAns, ghostVars>>

\* leaseLost (S:460-478), called by FleetDO's reassign queue.
ServeLL(q) ==
  /\ q \in llReq
  /\ llReq' = llReq \ {q}
  \* Fix (FixLeaseLost): a lease lost at the epoch still being placed is this object's own: the
  \* marker is cleared (the in-flight answer is then ignored) and a new epoch claimed.
  /\ LET own   == FixLeaseLost /\ sHost = None /\ sPlacing = q.e
         first == sEpoch = q.e /\ (sHost = q.h \/ (sHost = None /\ sPlacing = 0) \/ own)
         done  == sDestroyed \/ (~first /\ ~(sHost = None /\ sLost = q.h))
         canPlace == sPlacing = 0 \/ own
     IN IF done
        THEN /\ llAns' = LLAnswer(q, TRUE)
             /\ UNCHANGED <<sbxVars, req>>
        ELSE /\ sHost' = None
             /\ sLost' = IF first THEN q.h ELSE sLost
             /\ IF canPlace
                THEN /\ ClaimVars(q) /\ UNCHANGED llAns
                ELSE /\ llAns' = LLAnswer(q, FALSE)   \* "placement already in progress" throws
                     /\ UNCHANGED <<sEpoch, sPlacing, sk, req>>
             /\ UNCHANGED <<sHead, sHist, sDestroyed, sStored>>
  /\ UNCHANGED <<fleetVars, hostVars, hostEv, cmds, ans, ghostVars>>

\* destroy: command to the host, await releaseLease (all epochs), then mark destroyed. Fixed
\* (FixDestroy, `SandboxDO.destroy` + `lease.destroyed`): destroyed, unplaced and no marker before
\* the first await; FleetDO is told first (`sandboxDestroyed`), so it grants nothing afterwards.
DestroyStart ==
  /\ ~sDestroyed /\ budget.destroy < MaxDestroy /\ ~\E k \in sk : k.kind = "destroy"
  /\ LET k == K("destroy", 0, 0, 0, NoQ) IN
     /\ sk' = sk \cup {k}
     /\ req' = req \cup {Release(k, 0)}
  /\ cmds' = IF sHost # None THEN [cmds EXCEPT ![sHost] = Append(@, Cmd("destroy", sEpoch, 0, "", ""))] ELSE cmds
  /\ sDestroyed' = IF FixDestroy THEN TRUE ELSE sDestroyed
  /\ sHost' = IF FixDestroy THEN None ELSE sHost
  /\ sPlacing' = IF FixDestroy THEN 0 ELSE sPlacing
  /\ budget' = [budget EXCEPT !.destroy = @ + 1]
  /\ UNCHANGED <<sEpoch, sLost, sHead, sHist, sStored, fleetVars, hostVars,
                 hostEv, ans, llReq, llAns, granted, expiredG, settled, gens, nGen, nSend,
                 writerBad, stonithBad, salvageRefused, destroyedEver>>

ResumeDestroy(a) ==
  /\ a \in ans /\ a.k.kind = "destroy" /\ a.k \in sk
  /\ sk' = sk \ {a.k} /\ ans' = ans \ {a}
  /\ IF a.v = "fail"
     THEN UNCHANGED <<sDestroyed, sHost, destroyedEver>>
     ELSE /\ sDestroyed' = TRUE /\ sHost' = None /\ destroyedEver' = TRUE
  /\ UNCHANGED <<sEpoch, sPlacing, sLost, sHead, sHist, sStored, fleetVars, hostVars,
                 hostEv, cmds, req, llReq, llAns, granted, expiredG, settled, gens, nGen,
                 nSend, writerBad, stonithBad, salvageRefused, budget>>

\* commit (S:552-605), called from FleetDO.onCommitRequest (F:1139). Idempotent per request:
\* an unanswered request resent by nestd gets the stored outcome (S:553-554).
DoCommit(h, ev) ==
  LET found == {s \in sStored : s.h = h /\ s.e = ev.e /\ s.par = ev.parent}
      useStored == ev.t = "resend" /\ found # {}
      st == CHOOSE s \in found : TRUE
      heldIdx == {i \in 1..Len(sHist) : sHist[i].e = ev.e}
      heldBy == IF heldIdx = {} THEN None ELSE sHist[MinOf(heldIdx)].h
      \* Fix: a salvage from anyone but the current holder is an orphan iff FleetDO granted
      \* that host that epoch (its durable lease grants), not SandboxDO's capped history.
      salvBranch == ev.salv /\ (ev.e < sEpoch \/ (FixSalvage /\ h # sHost))
      heldOk == IF FixSalvage THEN [e |-> ev.e, h |-> h] \in granted ELSE heldBy = h
      fresh == IF salvBranch THEN (IF heldOk THEN "orphaned" ELSE "stale")
               ELSE IF CommitEpochCheck /\ (ev.e # sEpoch \/ h # sHost) THEN "stale"
               ELSE IF ev.parent # sHead THEN "parent"
               ELSE "committed"
      out == IF useStored THEN st.out ELSE fresh
      newGen == ~useStored /\ fresh \in {"orphaned", "committed"}
      gid == IF useStored THEN st.g ELSE IF newGen THEN nGen + 1 ELSE 0
      flag == IF ev.t = "resend" THEN "resend" ELSE IF ev.salv THEN "salv" ELSE "norm"
  IN /\ nGen' = IF newGen THEN nGen + 1 ELSE nGen
     /\ gens' = IF newGen
                THEN gens \cup {[id |-> gid, parent |-> ev.parent, e |-> ev.e, h |-> h,
                                 orphan |-> fresh = "orphaned"]}
                ELSE gens
     /\ sHead' = IF newGen /\ fresh = "committed" THEN gid ELSE sHead
     /\ sStored' = IF ~useStored /\ ~ev.salv
                   THEN sStored \cup {[h |-> h, e |-> ev.e, par |-> ev.parent, out |-> fresh, g |-> gid]}
                   ELSE sStored
     /\ writerBad' = (writerBad \/ (newGen /\ fresh = "committed" /\ \E h2 \in Hosts \ {h} : Running(h2)))
     /\ cmds' = [cmds EXCEPT ![h] = Append(@, Cmd("cres", ev.e, gid, flag, out))]

SbxReset ==
  /\ budget.reset < MaxReset
  /\ sk' = {} /\ ans' = {}
  /\ llAns' = llAns \cup {[q |-> k.ll, ok |-> FALSE] : k \in {k \in sk : k.ll # NoQ /\ k.ll \in llIn}}
  /\ budget' = [budget EXCEPT !.reset = @ + 1]
  /\ UNCHANGED <<sEpoch, sHost, sPlacing, sLost, sHead, sHist, sDestroyed, sStored, fleetVars,
                 hostVars, hostEv, cmds, req, llReq, granted, expiredG, settled, gens, nGen, nSend,
                 writerBad, stonithBad, salvageRefused, destroyedEver>>

\* An RPC answer lost on the way back: the await rejects (not FORBIDDEN).
LoseAnswer(a) ==
  /\ a \in ans /\ a.v # "fail" /\ budget.lose < MaxLose
  /\ ans' = (ans \ {a}) \cup {[a EXCEPT !.v = "fail"]}
  /\ budget' = [budget EXCEPT !.lose = @ + 1]
  /\ UNCHANGED <<sbxVars, fleetVars, hostVars, hostEv, cmds, req, llReq, llAns,
                 granted, expiredG, settled, gens, nGen, nSend, writerBad, stonithBad,
                 salvageRefused, destroyedEver>>

-----------------------------------------------------------------------------
(* ---------------- FleetDO ---------------- *)

\* place (F:1191-1259), granting branch: the lease row and sandbox_create are written atomically.
ServePlaceGrant(r, c) ==
  /\ r \in req /\ r.t = "place"
  /\ lease = NoLease /\ c \in Cands
  /\ ~(FixDestroy /\ fleetDestroyed)
  /\ req' = req \ {r}
  /\ lease' = [h |-> c, e |-> r.k.e, x |-> FALSE]
  /\ cmds' = [cmds EXCEPT ![c] = Append(@, Cmd("create", r.k.e, r.k.from, "", ""))]
  /\ ans' = Answer(r.k, "host", c, NoLease)
  /\ granted' = granted \cup {[e |-> r.k.e, h |-> c]}
  /\ stonithBad' = (stonithBad \/ \E x \in expiredG : x.e < r.k.e /\ x \notin settled)
  /\ UNCHANGED <<sbxVars, status, silence, queue, fencePending, fleetDestroyed, llIn, hostVars,
                 hostEv, llReq, llAns, expiredG, settled, gens, nGen, nSend, writerBad,
                 salvageRefused, destroyedEver, budget>>

\* place: same-epoch retry, refusal, or no capacity (also with candidates: capacity is abstract).
ServePlaceOther(r) ==
  /\ r \in req /\ r.t = "place"
  /\ \/ lease = NoLease /\ (Cands = {} \/ NoCapAllowed) /\ ~(FixDestroy /\ fleetDestroyed)
     \/ lease # NoLease
     \/ FixDestroy /\ fleetDestroyed
  /\ req' = req \ {r}
  /\ ans' = IF lease # NoLease /\ lease.e = r.k.e /\ ~lease.x THEN Answer(r.k, "host", lease.h, NoLease)
            ELSE IF lease # NoLease \/ (FixDestroy /\ fleetDestroyed) THEN Answer(r.k, "refused", None, NoLease)
            ELSE Answer(r.k, "null", None, NoLease)
  /\ UNCHANGED <<sbxVars, fleetVars, hostVars, hostEv, cmds, llReq, llAns, ghostVars>>

ServeLeaseOf(r) ==
  /\ r \in req /\ r.t = "leaseOf"
  /\ req' = req \ {r}
  /\ ans' = Answer(r.k, "lease", None, lease)
  /\ UNCHANGED <<sbxVars, fleetVars, hostVars, hostEv, cmds, llReq, llAns, ghostVars>>

ServeRelease(r) ==
  /\ r \in req /\ r.t = "release"
  /\ req' = req \ {r}
  /\ lease' = IF r.e = 0 \/ lease.e = r.e THEN NoLease ELSE lease
  /\ fleetDestroyed' = (fleetDestroyed \/ r.e = 0)
  /\ ans' = Answer(r.k, "ok", None, NoLease)
  /\ UNCHANGED <<sbxVars, status, silence, queue, fencePending, llIn, hostVars, hostEv, cmds,
                 llReq, llAns, ghostVars>>

\* Host events, in order per host, while connected (F:992-1037, F:1099-1121, F:1139).
FleetEvent(h) ==
  /\ connected[h] /\ hostEv[h] # <<>>
  /\ LET ev == Head(hostEv[h]) IN
     /\ hostEv' = [hostEv EXCEPT ![h] = Tail(@)]
     /\ CASE ev.t = "run" ->
               UNCHANGED <<sbxVars, fleetVars, hostVars, cmds, req, ans, llReq, llAns, ghostVars>>
          [] ev.t = "fenced" ->
               \* holds() then holderFenced (F:1007-1015, F:860): reassign at once.
               \* The holder's own fence report settles its lease (as a STONITH fence would).
               LET holds == lease.h = h /\ ~lease.x /\ lease.e = ev.e IN
               /\ queue' = IF holds THEN QueueAdd(h, FALSE) ELSE queue
               /\ settled' = IF holds THEN settled \cup {[e |-> lease.e, h |-> h]} ELSE settled
               /\ UNCHANGED <<sbxVars, lease, status, silence, fencePending, fleetDestroyed, llIn,
                              hostVars, cmds, req, ans, llReq, llAns, granted, expiredG, gens, nGen,
                              nSend, writerBad, stonithBad, salvageRefused, destroyedEver, budget>>
          [] ev.t = "fres" ->
               \* stonith_fence ok (`onCommandResult` -> `stonithDoneIfClear`): active again first
               \* (never once FleetDO asked EC2 to terminate the instance, as in StonithClear), then
               \* reassign.
               /\ status' = IF status[h] = "stonith" /\ connected[h] /\ ec2[h] = "running"
                            THEN [status EXCEPT ![h] = "active"] ELSE status
               /\ settled' = IF lease.h = h THEN settled \cup {[e |-> lease.e, h |-> h]} ELSE settled
               /\ queue' = QueueAdd(h, FALSE)
               /\ fencePending' = [fencePending EXCEPT ![h] = FALSE]
               /\ UNCHANGED <<sbxVars, lease, silence, fleetDestroyed, llIn, hostVars, cmds, req, ans,
                              llReq, llAns, granted, expiredG, gens, nGen, nSend, writerBad,
                              stonithBad, salvageRefused, destroyedEver, budget>>
          [] ev.t \in {"commit", "resend"} ->
               /\ DoCommit(h, ev)
               /\ UNCHANGED <<sEpoch, sHost, sPlacing, sLost, sHist, sDestroyed, sk, fleetVars,
                              hostVars, req, ans, llReq, llAns, granted, expiredG, settled, nSend,
                              stonithBad, salvageRefused, destroyedEver, budget>>

\* tick: a host silent for E with an unexpired lease (F:1304-1310, expireHost F:1749-1753).
Expire(h) ==
  /\ status[h] = "active" /\ silence[h] >= E /\ lease.h = h /\ ~lease.x
  /\ lease' = [lease EXCEPT !.x = TRUE]
  /\ expiredG' = expiredG \cup {[e |-> lease.e, h |-> h]}
  /\ connected' = [connected EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ IF Stonith
     THEN /\ status' = [status EXCEPT ![h] = "stonith"] /\ UNCHANGED queue
     ELSE /\ queue' = QueueIns(QRow(h, lease.e, FALSE))
          /\ UNCHANGED status
  /\ UNCHANGED <<sbxVars, silence, fencePending, fleetDestroyed, llIn, alive, fenceLeft, wdFired,
                 row, retiring, newProc, ec2, chanVars, granted, settled, gens, nGen, nSend,
                 writerBad, stonithBad, salvageRefused, destroyedEver, budget>>

Ec2Terminate(h) ==
  /\ status[h] = "stonith" /\ ec2[h] = "running"
  /\ ec2' = [ec2 EXCEPT ![h] = "shutting"]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, row, retiring,
                 newProc, chanVars, ghostVars>>

\* pollStonith -> confirmHostDead (F:1787-1798, F:1833-1843).
PollStonith(h) ==
  /\ status[h] = "stonith"
  /\ ec2[h] = "terminated" \/ (ShuttingDownIsDead /\ ec2[h] = "shutting")
  /\ status' = [status EXCEPT ![h] = "dead"]
  /\ connected' = [connected EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ queue' = QueueAdd(h, TRUE)
  /\ settled' = IF lease.h = h THEN settled \cup {[e |-> lease.e, h |-> h]} ELSE settled
  /\ UNCHANGED <<sbxVars, lease, silence, fencePending, fleetDestroyed, llIn, alive, fenceLeft,
                 wdFired, row, retiring, newProc, ec2, chanVars, granted, expiredG, gens, nGen,
                 nSend, writerBad, stonithBad, salvageRefused, destroyedEver, budget>>

\* ensureStonithFence skips sandboxes in the reassign queue (F:1806-1808), keyed by sandbox only on
\* main; the fix keys it by the lease's own (host, epoch).
NotQueued(h) == IF FixStonithFence THEN ~\E q \in queue : q.h = h /\ q.e = lease.e ELSE queue = {}

\* ensureStonithFence (F:1805-1822): a reachable host must fence its expired leases.
EnsureFence(h) ==
  /\ status[h] \in {"active", "stonith"} /\ connected[h]
  /\ lease.h = h /\ lease.x /\ NotQueued(h) /\ ~fencePending[h]
  /\ cmds' = [cmds EXCEPT ![h] = Append(@, Cmd("fence", 0, 0, "stonith", ""))]
  /\ fencePending' = [fencePending EXCEPT ![h] = TRUE]
  /\ UNCHANGED <<sbxVars, lease, status, silence, queue, fleetDestroyed, llIn, hostVars,
                 hostEv, req, ans, llReq, llAns, ghostVars>>

\* stonithDoneIfClear (F:1827-1830). Never once FleetDO has asked EC2 to terminate the instance:
\* only EC2's answer (PollStonith) ends that host's STONITH.
StonithClear(h) ==
  /\ status[h] = "stonith" /\ connected[h] /\ ~(lease.h = h /\ lease.x) /\ ec2[h] = "running"
  /\ status' = [status EXCEPT ![h] = "active"]
  /\ UNCHANGED <<sbxVars, lease, silence, queue, fencePending, fleetDestroyed, llIn, hostVars,
                 chanVars, ghostVars>>

\* processReassign (F:1856-1866): drop the old lease, then call leaseLost.
ProcessReassign(q) ==
  /\ q \in queue /\ q \notin llIn
  /\ lease' = IF lease.h = q.h /\ lease.e = q.e THEN NoLease ELSE lease
  /\ llReq' = llReq \cup {q}
  /\ llIn' = llIn \cup {q}
  /\ UNCHANGED <<sbxVars, status, silence, queue, fencePending, fleetDestroyed, hostVars,
                 hostEv, cmds, req, ans, llAns, ghostVars>>

ResumeLL(a) ==
  /\ a \in llAns /\ a.q \in llIn
  /\ llAns' = llAns \ {a}
  /\ llIn' = llIn \ {a.q}
  /\ queue' = IF a.ok THEN queue \ {a.q} ELSE queue
  /\ UNCHANGED <<sbxVars, lease, status, silence, fencePending, fleetDestroyed, hostVars,
                 hostEv, cmds, req, ans, llReq, ghostVars>>

FleetReset ==
  /\ budget.reset < MaxReset
  /\ llIn' = {} /\ llAns' = {} /\ llReq' = {}
  /\ budget' = [budget EXCEPT !.reset = @ + 1]
  /\ UNCHANGED <<sbxVars, lease, status, silence, queue, fencePending, fleetDestroyed, hostVars,
                 hostEv, cmds, req, ans, granted, expiredG, settled, gens, nGen, nSend,
                 writerBad, stonithBad, salvageRefused, destroyedEver>>

-----------------------------------------------------------------------------
(* ---------------- network and time ---------------- *)

HbSend(h) ==
  /\ alive[h] /\ connected[h] /\ hb[h].d = "none"
  /\ hb' = [hb EXCEPT ![h] = [d |-> "up", age |-> 0, c |-> IF row[h].st = "run" THEN row[h].e ELSE 0]]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, row, retiring, newProc,
                 ec2, chanVars, ghostVars>>

\* onHeartbeat (F:941-956): last_rx, revoked claims.
HbRecv(h) ==
  /\ connected[h] /\ hb[h].d = "up"
  /\ silence' = [silence EXCEPT ![h] = 0]
  /\ LET c == hb[h].c
         rev == c # 0 /\ ~(lease.h = h /\ lease.e = c /\ ~lease.x)
     IN hb' = [hb EXCEPT ![h] = [d |-> "down", age |-> hb[h].age, c |-> IF rev THEN c ELSE 0]]
  /\ UNCHANGED <<sbxVars, lease, status, queue, fencePending, fleetDestroyed, llIn, alive,
                 connected, fenceLeft, wdFired, row, retiring, newProc, ec2, chanVars, ghostVars>>

\* heartbeat_ack: renew to send instant + F (NF:372-395), then fence revoked (H:812-818).
AckRecv(h) ==
  /\ alive[h] /\ connected[h] /\ hb[h].d = "down"
  /\ fenceLeft' = [fenceLeft EXCEPT ![h] = F - hb[h].age]
  /\ wdFired' = [wdFired EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ LET r == row[h]
         doit == hb[h].c # 0 /\ r.e = hb[h].c
     IN /\ row' = IF doit THEN [row EXCEPT ![h] = FenceRow(r)] ELSE row
        /\ retiring' = IF doit THEN [retiring EXCEPT ![h] = FenceRet(r, @)] ELSE retiring
        /\ hostEv' = IF doit THEN [hostEv EXCEPT ![h] = @ \o FenceEvs(r)] ELSE hostEv
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, newProc, ec2, cmds, req, ans, llReq, llAns,
                 ghostVars>>

Disconnect(h) ==
  /\ connected[h] /\ budget.disc < MaxDisc
  /\ connected' = [connected EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ budget' = [budget EXCEPT !.disc = @ + 1]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, fenceLeft, wdFired, row, retiring, newProc, ec2,
                 chanVars, granted, expiredG, settled, gens, nGen, nSend, writerBad, stonithBad,
                 salvageRefused, destroyedEver>>

\* Reconnect + hello (F:729-797): last_rx, reconcileSandboxes (F:822-850), dropUnreported (F:804),
\* failPendingCommands -> commandFailed re-issues a lost create (S:435); hello_ack renews (NF:285).
Connect(h) ==
  /\ alive[h] /\ ~connected[h] /\ status[h] # "dead"
  /\ LET r == row[h]
         rep == r.st # "none"
         honored == lease.h = h /\ lease.e = r.e /\ ~lease.x
         fenceIt == rep /\ ~honored /\ r.st # "fenced"
         hf == rep /\ honored /\ r.st = "fenced"
         drop == newProc[h] /\ lease.h = h /\ ~lease.x /\ ~rep
         reissue == newProc[h] /\ rep /\ lease.h = h /\ ~lease.x /\ lease.e # r.e
                    /\ lease.e = sEpoch /\ sHost = h
         fp == IF newProc[h] THEN FALSE ELSE fencePending[h]
         \* ensureStonithFence at the end of onHello (F:794)
         sfence == lease.h = h /\ lease.x /\ NotQueued(h) /\ ~fp
     IN /\ cmds' = [cmds EXCEPT ![h] = @ \o (IF fenceIt THEN <<Cmd("fence", 0, 0, "plain", "")>> ELSE <<>>)
                                         \o (IF reissue THEN <<Cmd("create", lease.e, sHead, "", "")>> ELSE <<>>)
                                         \o (IF sfence THEN <<Cmd("fence", 0, 0, "stonith", "")>> ELSE <<>>)]
        /\ queue' = IF hf \/ drop THEN QueueAdd(h, FALSE) ELSE queue
        \* a holder's fenced report, or a restarted nestd that lost it (VMs die with nestd: unverified)
        /\ settled' = IF hf \/ drop THEN settled \cup {[e |-> lease.e, h |-> h]} ELSE settled
        /\ fencePending' = [fencePending EXCEPT ![h] = fp \/ sfence]
  /\ connected' = [connected EXCEPT ![h] = TRUE]
  /\ silence' = [silence EXCEPT ![h] = 0]
  /\ fenceLeft' = [fenceLeft EXCEPT ![h] = F]
  /\ wdFired' = [wdFired EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ newProc' = [newProc EXCEPT ![h] = FALSE]
  /\ UNCHANGED <<sbxVars, lease, status, fleetDestroyed, llIn, alive, row, retiring, ec2, hostEv,
                 req, ans, llReq, llAns, granted, expiredG, gens, nGen, nSend, writerBad,
                 stonithBad, salvageRefused, destroyedEver, budget>>

\* Time passes; never past an alive host's due watchdog (it polls every 250 ms).
\* DO-to-DO RPCs complete within a tick (milliseconds against 5 s); a lost answer or a reset
\* is the explicit fault. DelayedRpc lifts this.
Tick ==
  /\ \A h \in Hosts : ~(alive[h] /\ fenceLeft[h] = 0 /\ SFDue(h))
  /\ RpcQuiet
  \* a queued reassignment is worked at once (queueReassign -> processReassign, F:1853)
  /\ queue \subseteq llIn
  /\ silence' = [h \in Hosts |-> Min2(E, silence[h] + 1)]
  /\ fenceLeft' = [h \in Hosts |-> IF fenceLeft[h] > 0 THEN fenceLeft[h] - 1 ELSE 0]
  /\ hb' = [h \in Hosts |-> IF hb[h].d = "none" THEN hb[h] ELSE [hb[h] EXCEPT !.age = Min2(F, @ + 1)]]
  /\ UNCHANGED <<sbxVars, lease, status, queue, fencePending, fleetDestroyed, llIn, alive,
                 connected, wdFired, row, retiring, newProc, ec2, chanVars, ghostVars>>

-----------------------------------------------------------------------------
(* ---------------- nestd ---------------- *)

\* lease_watchdog -> self_fence (H:1056-1094).
SelfFence(h) ==
  /\ alive[h] /\ fenceLeft[h] = 0 /\ SFDue(h)
  /\ wdFired' = [wdFired EXCEPT ![h] = TRUE]
  /\ row' = [row EXCEPT ![h] = FenceRow(@)]
  /\ retiring' = [retiring EXCEPT ![h] = FenceRet(row[h], @)]
  /\ hostEv' = [hostEv EXCEPT ![h] = @ \o FenceEvs(row[h])]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, hb, newProc, ec2, cmds, req, ans,
                 llReq, llAns, ghostVars>>

Work(h) ==
  /\ Running(h) /\ ~row[h].dirty
  /\ row' = [row EXCEPT ![h].dirty = TRUE]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, retiring, newProc,
                 ec2, chanVars, ghostVars>>

\* A turn-end / suspend commit (H:2040-2122).
CommitSend(h) ==
  /\ Running(h) /\ row[h].dirty /\ row[h].busy = "no" /\ nSend < MaxSends
  /\ row' = [row EXCEPT ![h].busy = "wait", ![h].par = row[h].head]
  /\ hostEv' = [hostEv EXCEPT ![h] = Append(@, Ev("commit", row[h].e, row[h].head, FALSE))]
  /\ nSend' = nSend + 1
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, retiring, newProc,
                 ec2, cmds, req, ans, llReq, llAns, granted, expiredG, settled, gens, nGen,
                 writerBad, stonithBad, salvageRefused, destroyedEver, budget>>

\* commit_timeout: the request is kept as `unanswered` (H:2101-2106); a late answer is ignored.
Timeout(h) ==
  /\ row[h].busy = "wait"
  /\ row' = [row EXCEPT ![h].busy = "unans"]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, retiring, newProc,
                 ec2, chanVars, ghostVars>>

\* retire_now (H:1176-1215): resend an unanswered request first (H:2052-2058), else salvage.
SalvageSend(h, x) ==
  /\ alive[h] /\ x \in retiring[h] /\ ~x.sent /\ nSend < MaxSends
  /\ retiring' = [retiring EXCEPT ![h] = (@ \ {x}) \cup {[x EXCEPT !.sent = TRUE]}]
  /\ hostEv' = [hostEv EXCEPT ![h] = Append(@, IF x.unans THEN Ev("resend", x.e, x.par, FALSE)
                                                      ELSE Ev("commit", x.e, x.head, TRUE))]
  /\ nSend' = nSend + 1
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, row, newProc, ec2,
                 cmds, req, ans, llReq, llAns, granted, expiredG, settled, gens, nGen, writerBad,
                 stonithBad, salvageRefused, destroyedEver, budget>>

RetireAt(rt, e) == {x \in rt : x.e = e /\ x.sent}

\* Commands in order (H:779-820 fence at once; H:1404-1490 create; H:1825 destroy; H:2150 apply_commit).
HostCmd(h) ==
  /\ alive[h] /\ cmds[h] # <<>>
  \* What was written to the socket before confirmHostDead closed it still arrives, in order
  \* (one stream); over-approximated as the whole queue of a dead but still-alive host.
  /\ connected[h] \/ status[h] = "dead"
  /\ Head(cmds[h]).t = "create" => RpcQuiet /\ FenceQuiet(h)
  /\ cmds' = [cmds EXCEPT ![h] = Tail(@)]
  /\ LET c == Head(cmds[h])
         r == row[h]
     IN CASE c.t = "create" ->
               IF r.st # "none" /\ r.e >= c.e
               THEN UNCHANGED <<row, retiring, hostEv, salvageRefused>>
               ELSE \* an older local incarnation is superseded: fenced and retired (H:1428-1436).
                    \* On main a create runs whatever the host lease; the fix (WatchdogOnce = FALSE)
                    \* starts it fenced when the lease has lapsed.
                    LET lapsed == ~WatchdogOnce /\ fenceLeft[h] = 0
                        st == IF lapsed THEN "fenced" ELSE "run"
                    IN
                    /\ row' = [row EXCEPT ![h] = [e |-> c.e, st |-> st, dirty |-> FALSE,
                                                  head |-> c.x, busy |-> "no", par |-> 0]]
                    /\ retiring' = [retiring EXCEPT ![h] = FenceRet(r, @)]
                    /\ hostEv' = [hostEv EXCEPT ![h] = @ \o FenceEvs(r) \o <<Ev(st, c.e, 0, FALSE)>>]
                    /\ UNCHANGED salvageRefused
          [] c.t = "fence" ->
               /\ row' = [row EXCEPT ![h] = FenceRow(r)]
               /\ retiring' = [retiring EXCEPT ![h] = FenceRet(r, @)]
               /\ hostEv' = [hostEv EXCEPT ![h] = @ \o FenceEvs(r)
                                \o (IF c.flag = "stonith" THEN <<Ev("fres", 0, 0, FALSE)>> ELSE <<>>)]
               /\ UNCHANGED salvageRefused
          [] c.t = "destroy" ->
               /\ row' = IF r.e = c.e THEN [row EXCEPT ![h] = NoRow] ELSE row
               /\ retiring' = [retiring EXCEPT ![h] = {x \in @ : x.e # c.e}]
               /\ UNCHANGED <<hostEv, salvageRefused>>
          [] c.t = "cres" /\ c.flag = "norm" ->
               IF r.e = c.e /\ r.busy = "wait"
               THEN IF c.out = "committed"
                    THEN /\ row' = [row EXCEPT ![h].head = c.x, ![h].dirty = FALSE, ![h].busy = "no"]
                         \* the retired copy's work is in the generation just committed
                         /\ retiring' = [retiring EXCEPT ![h] = {x \in @ : x.e # c.e}]
                         /\ UNCHANGED <<hostEv, salvageRefused>>
                    ELSE \* rejected: fence this incarnation, its work to salvage (H:2165-2171)
                         LET r2 == [r EXCEPT !.busy = "no"] IN
                         /\ row' = [row EXCEPT ![h] = FenceRow(r2)]
                         /\ retiring' = [retiring EXCEPT ![h] = FenceRet(r2, @)]
                         /\ hostEv' = [hostEv EXCEPT ![h] = @ \o FenceEvs(r2)]
                         /\ UNCHANGED salvageRefused
               ELSE UNCHANGED <<row, retiring, hostEv, salvageRefused>>
          [] c.t = "cres" /\ c.flag = "salv" ->
               \* parent_mismatch is retried; stale_epoch is final: the disk is deleted (H:1193)
               /\ retiring' = [retiring EXCEPT ![h] =
                     IF c.out = "parent" THEN {IF x.e = c.e THEN [x EXCEPT !.sent = FALSE] ELSE x : x \in @}
                     ELSE @ \ RetireAt(@, c.e)]
               /\ salvageRefused' = IF c.out = "stale" /\ RetireAt(retiring[h], c.e) # {}
                                    THEN salvageRefused \cup {[e |-> c.e, h |-> h]} ELSE salvageRefused
               /\ UNCHANGED <<row, hostEv>>
          [] c.t = "cres" /\ c.flag = "resend" ->
               \* committed: its generation is this work; stale: final (B-B1); parent: retry salvage
               LET final == c.out = "stale" /\ ResendFailIsFinal
                   gone  == c.out = "committed" \/ final
               IN /\ retiring' = [retiring EXCEPT ![h] =
                        IF gone THEN @ \ RetireAt(@, c.e)
                        ELSE {IF x.e = c.e /\ x.sent THEN [x EXCEPT !.sent = FALSE, !.unans = FALSE] ELSE x : x \in @}]
                  /\ salvageRefused' = IF final /\ RetireAt(retiring[h], c.e) # {}
                                       THEN salvageRefused \cup {[e |-> c.e, h |-> h]} ELSE salvageRefused
                  /\ UNCHANGED <<row, hostEv>>
  /\ UNCHANGED <<sbxVars, fleetVars, alive, connected, fenceLeft, wdFired, hb, newProc, ec2, req,
                 ans, llReq, llAns, granted, expiredG, settled, gens, nGen, nSend, writerBad,
                 stonithBad, destroyedEver, budget>>

\* nestd restarts: its VMs die with it (cgroup); a clean incarnation is deleted unreported, a dirty
\* one is reported fenced and salvaged; the persisted in-flight commit becomes `unanswered`
\* (H:395-470, H:2091). Unacked events/commands of the old process are gone.
NestdCrash(h) ==
  /\ alive[h] /\ budget.crash < MaxCrash
  /\ LET r == row[h]
         dirtyRun == r.st = "run" /\ r.dirty
     IN /\ row' = [row EXCEPT ![h] = IF dirtyRun THEN [r EXCEPT !.st = "fenced", !.busy = "no"]
                                     ELSE IF r.st = "run" THEN NoRow ELSE r]
        /\ retiring' = [retiring EXCEPT ![h] = {[x EXCEPT !.sent = FALSE] : x \in @}
                          \cup (IF dirtyRun THEN {[RetireOf(r) EXCEPT !.unans = (r.busy # "no")]} ELSE {})]
  /\ hostEv' = [hostEv EXCEPT ![h] = <<>>]
  /\ cmds' = [cmds EXCEPT ![h] = <<>>]
  /\ connected' = [connected EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ newProc' = [newProc EXCEPT ![h] = TRUE]
  /\ fenceLeft' = [fenceLeft EXCEPT ![h] = 0]
  /\ wdFired' = [wdFired EXCEPT ![h] = TRUE]
  /\ budget' = [budget EXCEPT !.crash = @ + 1]
  /\ UNCHANGED <<sbxVars, fleetVars, alive, ec2, req, ans, llReq, llAns, granted, expiredG, settled,
                 gens, nGen, nSend, writerBad, stonithBad, salvageRefused, destroyedEver>>

Die(h) ==
  /\ alive' = [alive EXCEPT ![h] = FALSE]
  /\ ec2' = [ec2 EXCEPT ![h] = "terminated"]
  /\ row' = [row EXCEPT ![h] = NoRow]
  /\ retiring' = [retiring EXCEPT ![h] = {}]
  /\ connected' = [connected EXCEPT ![h] = FALSE]
  /\ hb' = [hb EXCEPT ![h] = NoHb]
  /\ hostEv' = [hostEv EXCEPT ![h] = <<>>]
  /\ cmds' = [cmds EXCEPT ![h] = <<>>]
  /\ fenceLeft' = [fenceLeft EXCEPT ![h] = 0]

\* The instance dies (spot reclaim, hardware).
HostDie(h) ==
  /\ alive[h] /\ budget.crash < MaxCrash
  /\ Die(h)
  /\ budget' = [budget EXCEPT !.crash = @ + 1]
  /\ UNCHANGED <<sbxVars, fleetVars, wdFired, newProc, req, ans, llReq, llAns, granted, expiredG,
                 settled, gens, nGen, nSend, writerBad, stonithBad, salvageRefused, destroyedEver>>

\* A terminated instance finishes shutting down.
Ec2Die(h) ==
  /\ alive[h] /\ ec2[h] = "shutting"
  /\ Die(h)
  /\ UNCHANGED <<sbxVars, fleetVars, wdFired, newProc, req, ans, llReq, llAns, ghostVars>>

-----------------------------------------------------------------------------
Next ==
  \/ PlaceStart \/ ReconcileStart \/ DestroyStart \/ SbxReset \/ FleetReset \/ Tick
  \/ \E q \in queue : ProcessReassign(q)
  \/ \E a \in ans : ResumePlace(a) \/ ResumeReconcile(a) \/ ResumeDestroy(a) \/ LoseAnswer(a)
  \/ \E q \in llReq : ServeLL(q)
  \/ \E a \in llAns : ResumeLL(a)
  \/ \E r \in req : ServePlaceOther(r) \/ ServeLeaseOf(r) \/ ServeRelease(r)
                    \/ \E c \in Hosts : ServePlaceGrant(r, c)
  \/ \E h \in Hosts :
       \/ FleetEvent(h) \/ Expire(h) \/ Ec2Terminate(h) \/ PollStonith(h) \/ EnsureFence(h)
       \/ StonithClear(h) \/ HbSend(h) \/ HbRecv(h) \/ AckRecv(h) \/ Disconnect(h) \/ Connect(h)
       \/ SelfFence(h) \/ Work(h) \/ CommitSend(h) \/ Timeout(h) \/ HostCmd(h)
       \/ NestdCrash(h) \/ HostDie(h) \/ Ec2Die(h)
       \/ \E x \in retiring[h] : SalvageSend(h, x)

Spec == Init /\ [][Next]_vars

\* Fairness for the liveness configurations: the DOs, alarms, the network while connected,
\* reconnection and EC2 keep working; faults (crash, reset, disconnect, loss) have no fairness
\* and are bounded. A grant is strongly fair (capacity eventually appears).
Fairness ==
  /\ WF_vars(PlaceStart) /\ WF_vars(ReconcileStart) /\ WF_vars(\E q \in queue : ProcessReassign(q))
  /\ WF_vars(Tick)
  /\ \A h \in Hosts : WF_vars(FleetEvent(h)) /\ WF_vars(Expire(h)) /\ WF_vars(Ec2Terminate(h))
        /\ WF_vars(PollStonith(h)) /\ WF_vars(EnsureFence(h)) /\ WF_vars(StonithClear(h))
        /\ WF_vars(HbSend(h)) /\ WF_vars(HbRecv(h)) /\ WF_vars(AckRecv(h)) /\ WF_vars(Connect(h))
        /\ WF_vars(SelfFence(h)) /\ WF_vars(HostCmd(h)) /\ WF_vars(Ec2Die(h))
  /\ WF_vars(\E a \in ans : ResumePlace(a) \/ ResumeReconcile(a) \/ ResumeDestroy(a))
  /\ WF_vars(\E q \in llReq : ServeLL(q))
  /\ WF_vars(\E a \in llAns : ResumeLL(a))
  /\ WF_vars(\E r \in req : ServePlaceOther(r) \/ ServeLeaseOf(r) \/ ServeRelease(r))
  /\ SF_vars(\E r \in req : \E c \in Hosts : ServePlaceGrant(r, c))

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* ---------------- properties ---------------- *)

\* NoDoubleRun: never two running, unfenced incarnations on different hosts (timing: F < E).
NoDoubleRun == \A h1, h2 \in Hosts : h1 # h2 => ~(Running(h1) /\ Running(h2))

\* SingleWriter: a head-moving commit is accepted only while no other host runs the sandbox, and
\* every generation came from the host granted its epoch (S:585 + F:1191).
SingleWriter == /\ ~writerBad
                /\ \A g \in gens : [e |-> g.e, h |-> g.h] \in granted

\* EpochUnique: no epoch is ever leased to two hosts (across all history).
EpochUnique == \A x, y \in granted : x.e = y.e => x.h = y.h

\* EpochMonotone: SandboxDO.epoch never decreases ("an epoch is never retried", docs/README.md).
EpochMonotone == [][sEpoch' >= sEpoch]_vars

\* HeadChain: the head is a non-orphan generation; every parent exists; along non-orphan
\* parent links epochs never decrease.
HeadChain ==
  /\ sHead = 0 \/ \E g \in gens : g.id = sHead /\ ~g.orphan
  /\ \A g \in gens : g.parent = 0 \/ \E p \in gens : p.id = g.parent
  /\ \A g, p \in gens : (~g.orphan /\ ~p.orphan /\ g.parent = p.id) => p.e <= g.e

\* SalvageOnlyFromHolder: an orphaned generation at epoch e came from the host that held e.
SalvageOnlyFromHolder == \A g \in gens : g.orphan => [e |-> g.e, h |-> g.h] \in granted

\* SalvageNeverDropped (B1, B-B1): no dirty fenced incarnation's work is refused for good;
\* it ends as a head, an orphan, or is destroyed by an explicit command.
SalvageNeverDropped == salvageRefused = {}

\* StonithBeforeReassign: a newer epoch is granted only after every older expired lease was
\* settled by EC2 (terminated / shutting-down) or a successful STONITH fence.
StonithBeforeReassign == ~stonithBad

\* DestroyIsTerminal (B2): once destroy() returned, the sandbox stays destroyed with no host
\* and no lease.
DestroyIsTerminal == destroyedEver => (sDestroyed /\ sHost = None /\ lease = NoLease)

\* Liveness.
PlacingClears == (sPlacing # 0) ~> (sPlacing = 0)
QueueDrains   == (queue # {}) ~> (queue = {})
\* A sandbox whose lease was lost runs again at its current epoch somewhere.
Recovers == (queue # {}) ~> (sDestroyed \/ (\A h \in Hosts : ~alive[h] \/ status[h] = "dead")
                               \/ (sHost # None /\ Running(sHost) /\ row[sHost].e = sEpoch))

\* A sandbox without a host (lost, or never placed) eventually runs on one, unless no host is
\* left to take it (every host dead or STONITHed).
NoHostLeft == \A h \in Hosts : ~alive[h] \/ status[h] = "dead"
Placed == (~sDestroyed /\ sHost = None) ~> (sDestroyed \/ NoHostLeft \/ (sHost # None /\ Running(sHost)))
\* SandboxDO's host is eventually backed by FleetDO's lease at its epoch (or it lets go).
HostTruthful == (sHost # None) ~> (sHost = None \/ sDestroyed \/ (lease.h = sHost /\ lease.e = sEpoch))

\* Bounds for TLC.
StateBound == sEpoch <= MaxEpoch
Perms == Permutations(Hosts)
=============================================================================

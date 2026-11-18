----------------------------- MODULE HostDrain -----------------------------
(***************************************************************************)
(* A sandbox host's forced drain (docs/compute/autoscaling/, "Drain"): a   *)
(* spot notice or an operator's request, the suspends it sends, each       *)
(* resident's eviction once it reports `suspended`, the host's own fence   *)
(* and salvage of what its lease no longer covers, and the two ways the    *)
(* instance ends: FleetDO retires it once empty, or AWS takes it at the    *)
(* notice's deadline.                                                      *)
(*                                                                         *)
(* The fixes of 2026-11-18 are switches (ReapDestroyed, ResumeNeedsLease,  *)
(* ResumeIsBusy, EvictBeforeTold, SweepSuspended): off, each reproduces    *)
(* its bug.                                                                *)
(*                                                                         *)
(* One host. Each sandbox starts as a resident (running or suspended, as   *)
(* FleetDO last heard) or, if in `StaleSbx`, as an incarnation its lease   *)
(* no longer covers, recorded stale and not yet salvaged (a failed         *)
(* sandbox's release, FailedRelease.tla).                                  *)
(*                                                                         *)
(* Action -> code:                                                         *)
(*   Write          the guest writes; the incarnation holds work its head  *)
(*                  doesn't have                                           *)
(*   Wake, HostResume  control-plane/src/do/sandbox.ts wake: sandbox_resume*)
(*                  to a sandbox SandboxDO has as suspended; nestd resumes *)
(*   ReportRunning, ResumeAnswered  do/fleet.ts handleEvent sandbox_state: *)
(*                  the holder's report (recordState; a non-holder's is    *)
(*                  dropped), and the resume's command_result after it     *)
(*   Drain          do/fleet.ts drain (spot_notice, or drainHost): the     *)
(*                  host `draining`; suspended leases evicted              *)
(*                  (recordEvictions), sandbox_suspend{disk_only} to the   *)
(*                  rest. An operator may ask again (DrainAgain)           *)
(*   HostSuspend, SuspendFail  nestd's sandbox_suspend: the commit, then   *)
(*                  `suspended`; a failed commit leaves the VM running     *)
(*   ReportSuspended, EvictReported  handleEvent sandbox_state `suspended` *)
(*                  on a draining host: the lease deleted and the eviction *)
(*                  owed, before SandboxDO.reportState is awaited          *)
(*   Sweep          do/fleet.ts evictSuspendedOf, from a sandbox_resume's  *)
(*                  result (onCommandResult) and scaleDown's draining loop *)
(*   Evicted, Replace  do/fleet.ts processEvictions -> do/sandbox.ts       *)
(*                  evicted: unplaced; a busy one is placed elsewhere      *)
(*   HostFence      crates/nestd/src/host.rs: a heartbeat's revoked lease  *)
(*                  fences the incarnation ("lease revoked by control      *)
(*                  plane")                                                *)
(*   ReportFenced   handleEvent sandbox_state `fenced` from a non-holder:  *)
(*                  recordStale(dirty)                                     *)
(*   Salvage        host.rs retire_now: the salvage commit, accepted while *)
(*                  the sandbox hasn't moved on (decideCommit), else       *)
(*                  refused for good and the work dropped                  *)
(*   ReportRetired  handleEvent incarnation_retired: recordStale(clean)    *)
(*   WindowPass, Reap, HostDestroy  do/fleet.ts reapStale: sandbox_destroy *)
(*                  once clean, past SALVAGE_WINDOW_MS, or its sandbox is  *)
(*                  destroyed; nestd deletes it                            *)
(*   Retire         do/fleet.ts scaleDown, the draining loop: no lease and *)
(*                  no stale incarnation not yet told to go; die(drained)  *)
(*   AwsKill        EC2 reclaims the spot instance at the deadline         *)
(*   Tick           time passes, only when nothing else can happen         *)
(*                                                                         *)
(* Timing. `Tick` is enabled only when no step of FleetDO, SandboxDO or    *)
(* nestd is: the system does everything it can before the clock moves, so  *)
(* every commit fits the notice (the docs' size rule) unless it fails.     *)
(* `DrainsInTime` is meaningful only under that assumption.                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Sandboxes,
  StaleSbx,        \* start as stale, unsalvaged incarnations (a subset of Sandboxes)
  Destroyed,       \* those of StaleSbx whose sandbox was destroyed: nothing of theirs is work to keep
  Deadline,        \* ticks from the notice to AWS taking the instance
  Window,          \* ticks a dirty stale incarnation is waited for (SALVAGE_WINDOW_MS)
  MaxNow,          \* the clock's bound
  MaxWrite, MaxFail, MaxWake, MaxAgain,
  MaxResumeFail,   \* resumes that fail on the host (the VM stays suspended), at most
  \* ---- switches: the code as it is first ----
  Spot,            \* TRUE: a spot notice (AWS kills at the deadline). FALSE: an operator's drain
  ReportAfterCommit,  \* TRUE: nestd reports `suspended` only after its commit landed. FALSE (mutation)
  EvictSuspendedOnly, \* TRUE: Drain evicts only leases reported suspended. FALSE (mutation): every lease
  RetireWaitsLeases,  \* TRUE: Retire needs the host to hold no lease. FALSE (mutation)
  RetireWaitsStale,   \* TRUE: Retire keeps a host with a stale incarnation not yet told to go. FALSE (mutation; hosts inventory B9)
  RetiredReported,    \* TRUE: a retired incarnation's report reaches FleetDO. FALSE: a destroyed sandbox's doesn't: its own
                      \* sandbox_destroy deleted the incarnation under its retire, which then reports nothing (use1, 2026-11-18 15:58)
  ReapDestroyed,      \* TRUE: reapStale doesn't wait the window for a destroyed sandbox's incarnation. FALSE: before the fix
  ResumeNeedsLease,   \* TRUE: issueCommands refuses a sandbox_resume for a sandbox its host holds no lease on. FALSE: before the fix
  EvictBeforeTold,    \* TRUE: a `suspended` report's eviction is recorded before SandboxDO hears the report. FALSE: after (before the fix)
  SweepSuspended,     \* TRUE: a draining host's leases that read suspended, with no resume unanswered, are evicted whenever
                      \* they appear (a resume's result, the tick). FALSE: only at the drain and at a `suspended` report
  ResumeIsBusy,       \* TRUE: Drain suspends, rather than evicts, a lease with a resume unanswered. FALSE: before the fix
  EvictRecordsStale   \* FALSE: the code. TRUE (a fix shape not taken): an eviction records the incarnation it leaves as stale, in its step,
                      \* as releaseFailedLease does, so Retire waits until the host has fenced and retired it

VARIABLES
  \* FleetDO
  status,     \* the host: "active", "draining", "dead"
  lease,      \* s -> "none", "running", "suspended" (the state last reported)
  susp,       \* s -> the sandbox_suspend: "none", "sent", "done" (committed and suspended), "noop" (already suspended:
              \* answered, with no report), "reported" (FleetDO has the report; SandboxDO is hearing it), "failed"
  owed,       \* s -> an eviction SandboxDO hasn't been told
  stale,      \* s -> "none", "dirty", "clean", "expired", "reaped" (its sandbox_destroy issued)
  staleAt,    \* s -> when its stale row was first written
  \* SandboxDO
  place,      \* s -> "here", "unplaced", "elsewhere", "released" (StaleSbx: no longer this host's)
  sview,      \* s -> the state SandboxDO has: "running", "suspended"
  resume,     \* s -> the sandbox_resume: "none", "sent", "done" (the host ran it), "answered" (FleetDO has its result)
  \* the host
  inst,       \* "up", "retired" (FleetDO terminated it), "killed" (AWS did)
  vm,         \* s -> "running", "suspended", "fenced", "retired", "gone"
  dirty,      \* s -> the incarnation holds work its head doesn't have
  \* time
  now, noticeAt,
  \* ghosts
  lost,       \* s -> how work was lost: a subset of {"retire", "kill", "refused", "window"}
  emptyAtKill,\* AWS killed the host when FleetDO held no lease on it
  budget

vars == <<status, lease, susp, owed, stale, staleAt, place, sview, resume, inst, vm, dirty, now, noticeAt, lost, emptyAtKill, budget>>
fleetVars == <<status, lease, susp, owed, stale, staleAt>>
sbxVars == <<place, sview, resume>>
hostVars == <<inst, vm, dirty>>

NoNotice == MaxNow + 1
Spend(k) == budget' = [budget EXCEPT ![k] = @ - 1]
Lose(s, how) == lost' = [lost EXCEPT ![s] = IF s \in Destroyed THEN @ ELSE @ \cup {how}]

Init ==
  /\ status = "active" /\ inst = "up" /\ now = 0 /\ noticeAt = NoNotice /\ emptyAtKill = FALSE
  /\ lease \in [Sandboxes -> {"none", "running", "suspended"}]
  /\ \A s \in Sandboxes : (s \in StaleSbx) <=> (lease[s] = "none")
  /\ susp = [s \in Sandboxes |-> "none"] /\ owed = [s \in Sandboxes |-> FALSE]
  /\ stale = [s \in Sandboxes |-> IF s \in StaleSbx THEN "dirty" ELSE "none"]
  /\ staleAt = [s \in Sandboxes |-> 0]
  /\ place = [s \in Sandboxes |-> IF s \in StaleSbx THEN "released" ELSE "here"]
  /\ sview = [s \in Sandboxes |-> IF lease[s] = "suspended" THEN "suspended" ELSE "running"]
  /\ resume = [s \in Sandboxes |-> "none"]
  /\ vm = [s \in Sandboxes |-> IF s \in StaleSbx THEN "fenced" ELSE lease[s]]
  /\ dirty = [s \in Sandboxes |-> s \in StaleSbx]
  /\ lost = [s \in Sandboxes |-> {}]
  /\ budget = [write |-> MaxWrite, fail |-> MaxFail, wake |-> MaxWake, again |-> MaxAgain, rfail |-> MaxResumeFail]

-----------------------------------------------------------------------------
(* The guest and the agents (the environment) *)

Write(s) ==
  /\ inst = "up" /\ vm[s] = "running" /\ ~dirty[s] /\ budget.write > 0
  /\ dirty' = [dirty EXCEPT ![s] = TRUE] /\ Spend("write")
  /\ UNCHANGED <<fleetVars, sbxVars, inst, vm, now, noticeAt, lost, emptyAtKill>>

\* An agent needs a suspended sandbox: SandboxDO sends sandbox_resume to its holder.
Wake(s) ==
  /\ place[s] = "here" /\ sview[s] = "suspended" /\ resume[s] = "none" /\ budget.wake > 0
  \* Without the lease the command is refused (retryable): the wake fails, and is asked again once SandboxDO was told.
  /\ resume' = [resume EXCEPT ![s] = IF ResumeNeedsLease /\ lease[s] = "none" THEN "none" ELSE "sent"] /\ Spend("wake")
  /\ UNCHANGED <<fleetVars, place, sview, hostVars, now, noticeAt, lost, emptyAtKill>>

-----------------------------------------------------------------------------
(* nestd *)

\* The resume reaches the host (commands are delivered whatever became of the lease since).
HostResume(s) ==
  /\ resume[s] = "sent" /\ inst = "up"
  /\ resume' = [resume EXCEPT ![s] = "done"]
  /\ vm' = [vm EXCEPT ![s] = IF @ = "suspended" THEN "running" ELSE @]
  /\ UNCHANGED <<fleetVars, place, sview, inst, dirty, now, noticeAt, lost, emptyAtKill, budget>>

\* The resume fails on the host (its launch errors): the VM stays suspended, and the answer is an error.
HostResumeFail(s) ==
  /\ resume[s] = "sent" /\ inst = "up" /\ budget.rfail > 0
  /\ resume' = [resume EXCEPT ![s] = "done"] /\ Spend("rfail")
  /\ UNCHANGED <<fleetVars, place, sview, hostVars, now, noticeAt, lost, emptyAtKill>>

\* sandbox_suspend{disk_only}: the commit lands and the VM is suspended. One already suspended answers
\* "already suspended" and reports nothing (host.rs suspend).
\* A host runs its commands in the order they were issued: a resume issued before the suspend runs first.
HostSuspend(s) ==
  /\ susp[s] = "sent" /\ inst = "up" /\ vm[s] \in {"running", "suspended"} /\ resume[s] # "sent"
  /\ susp' = [susp EXCEPT ![s] = IF vm[s] = "running" THEN "done" ELSE "noop"]
  /\ vm' = [vm EXCEPT ![s] = "suspended"] /\ dirty' = [dirty EXCEPT ![s] = IF vm[s] = "running" THEN FALSE ELSE @]
  /\ UNCHANGED <<status, lease, owed, stale, staleAt, sbxVars, inst, now, noticeAt, lost, emptyAtKill, budget>>

\* Its commit fails: the VM keeps running, and nothing asks again but an operator.
SuspendFail(s) ==
  /\ susp[s] = "sent" /\ inst = "up" /\ vm[s] = "running" /\ budget.fail > 0 /\ resume[s] # "sent"
  /\ susp' = [susp EXCEPT ![s] = "failed"] /\ Spend("fail")
  /\ UNCHANGED <<status, lease, owed, stale, staleAt, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill>>

\* The suspend's command answered as fenced: the incarnation was fenced before it ran.
SuspendMoot(s) ==
  /\ susp[s] = "sent" /\ inst = "up" /\ vm[s] \notin {"running", "suspended"}
  /\ susp' = [susp EXCEPT ![s] = "failed"]
  /\ UNCHANGED <<status, lease, owed, stale, staleAt, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* A heartbeat's answer no longer lists the lease: the host fences what it has.
HostFence(s) ==
  /\ inst = "up" /\ lease[s] = "none" /\ vm[s] \in {"running", "suspended"}
  /\ vm' = [vm EXCEPT ![s] = "fenced"]
  /\ UNCHANGED <<fleetVars, sbxVars, inst, dirty, now, noticeAt, lost, emptyAtKill, budget>>

\* The retire: a salvage commit of what the head lacks, refused for good once the sandbox moved on.
Salvage(s) ==
  /\ inst = "up" /\ vm[s] = "fenced"
  /\ vm' = [vm EXCEPT ![s] = "retired"] /\ dirty' = [dirty EXCEPT ![s] = FALSE]
  /\ IF dirty[s] /\ place[s] = "elsewhere" THEN Lose(s, "refused") ELSE UNCHANGED lost
  /\ UNCHANGED <<fleetVars, sbxVars, inst, now, noticeAt, emptyAtKill, budget>>

\* sandbox_destroy at the stale epoch: the incarnation and whatever it still held are deleted.
HostDestroy(s) ==
  /\ inst = "up" /\ stale[s] = "reaped" /\ vm[s] # "gone"
  /\ vm' = [vm EXCEPT ![s] = "gone"] /\ dirty' = [dirty EXCEPT ![s] = FALSE]
  /\ IF dirty[s] THEN Lose(s, "window") ELSE UNCHANGED lost
  /\ UNCHANGED <<fleetVars, sbxVars, inst, now, noticeAt, emptyAtKill, budget>>

-----------------------------------------------------------------------------
(* FleetDO *)

\* The holder's `running` (after a resume). A non-holder's report is dropped.
ReportRunning(s) ==
  /\ lease[s] = "suspended" /\ vm[s] = "running" /\ inst = "up"
  /\ lease' = [lease EXCEPT ![s] = "running"] /\ sview' = [sview EXCEPT ![s] = "running"]
  \* The resume's result follows the report on the same ordered channel: one step here.
  /\ resume' = [resume EXCEPT ![s] = IF @ = "done" THEN "answered" ELSE @]
  /\ UNCHANGED <<status, susp, owed, stale, staleAt, place, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* A resume's result with no `running` before it: it failed, or its sandbox is no longer this host's.
ResumeAnswered(s) ==
  /\ resume[s] = "done" /\ inst = "up" /\ ~(lease[s] = "suspended" /\ vm[s] = "running")
  /\ resume' = [resume EXCEPT ![s] = "answered"]
  /\ UNCHANGED <<fleetVars, place, sview, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* drain(): suspended leases leave now, the rest are told to suspend.
Busy(s) == ResumeIsBusy /\ resume[s] \in {"sent", "done"}
Leaves(s) == lease[s] # "none" /\ (~EvictSuspendedOnly \/ (lease[s] = "suspended" /\ ~Busy(s)))
Told(s) == lease[s] # "none" /\ ~Leaves(s)
DrainBody ==
  /\ lease' = [s \in Sandboxes |-> IF Leaves(s) THEN "none" ELSE lease[s]]
  /\ owed' = [s \in Sandboxes |-> owed[s] \/ Leaves(s)]
  /\ susp' = [s \in Sandboxes |-> IF Told(s) THEN "sent" ELSE susp[s]]
  /\ stale' = [s \in Sandboxes |-> IF EvictRecordsStale /\ Leaves(s) /\ stale[s] = "none" THEN "dirty" ELSE stale[s]]
  /\ staleAt' = [s \in Sandboxes |-> IF EvictRecordsStale /\ Leaves(s) /\ stale[s] = "none" THEN now ELSE staleAt[s]]

Drain ==
  /\ status = "active" /\ inst = "up"
  /\ status' = "draining" /\ DrainBody
  /\ noticeAt' = IF Spot THEN now ELSE noticeAt
  /\ UNCHANGED <<sbxVars, hostVars, now, lost, emptyAtKill, budget>>

DrainAgain ==
  /\ ~Spot /\ status = "draining" /\ inst = "up" /\ budget.again > 0
  /\ DrainBody /\ Spend("again")
  /\ UNCHANGED <<status, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill>>

\* What an eviction on a draining host writes, in one step: the lease gone, the eviction owed.
Evict(s) ==
  /\ lease' = [lease EXCEPT ![s] = "none"] /\ owed' = [owed EXCEPT ![s] = TRUE]
  /\ IF EvictRecordsStale /\ stale[s] = "none"
       THEN stale' = [stale EXCEPT ![s] = "dirty"] /\ staleAt' = [staleAt EXCEPT ![s] = now]
       ELSE UNCHANGED <<stale, staleAt>>

\* `suspended` from the holder on a draining host: recorded, and SandboxDO told (an await). The eviction
\* is written before that await (EvictBeforeTold), or after it (EvictReported).
ReportSuspended(s) ==
  /\ status = "draining" /\ inst = "up" /\ lease[s] # "none"
  /\ \/ susp[s] = "done" /\ vm[s] = "suspended"
     \/ ~ReportAfterCommit /\ susp[s] = "sent" /\ vm[s] = "running"
  /\ sview' = [sview EXCEPT ![s] = "suspended"]
  /\ IF EvictBeforeTold
       THEN Evict(s) /\ susp' = [susp EXCEPT ![s] = "noop"]
       ELSE /\ lease' = [lease EXCEPT ![s] = "suspended"] /\ susp' = [susp EXCEPT ![s] = "reported"]
            /\ UNCHANGED <<owed, stale, staleAt>>
  /\ UNCHANGED <<status, place, resume, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

EvictReported(s) ==
  /\ susp[s] = "reported" /\ lease[s] # "none"
  /\ Evict(s) /\ susp' = [susp EXCEPT ![s] = "noop"]
  /\ UNCHANGED <<status, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* evictSuspendedOf, from a resume's result or the tick: a lease that reads suspended with no resume
\* unanswered leaves a draining host (a failed resume left its VM suspended, and the suspend reported nothing).
Sweep(s) ==
  /\ SweepSuspended /\ status = "draining" /\ inst = "up"
  /\ lease[s] = "suspended" /\ resume[s] \notin {"sent", "done"} /\ susp[s] # "reported"
  /\ Evict(s)
  /\ UNCHANGED <<status, susp, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* processEvictions: SandboxDO told (an await; retried until it answers).
Evicted(s) ==
  /\ owed[s]
  /\ owed' = [owed EXCEPT ![s] = FALSE]
  /\ place' = [place EXCEPT ![s] = IF @ = "here" THEN "unplaced" ELSE @]
  /\ sview' = [sview EXCEPT ![s] = "suspended"]
  /\ UNCHANGED <<status, lease, susp, stale, staleAt, resume, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* An evicted sandbox something needs is placed on another host, at a new epoch.
Replace(s) ==
  /\ place[s] = "unplaced"
  /\ place' = [place EXCEPT ![s] = "elsewhere"]
  /\ UNCHANGED <<fleetVars, sview, resume, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* `fenced` from a host that doesn't hold the lease: its incarnation is recorded stale, not salvaged.
ReportFenced(s) ==
  /\ inst = "up" /\ status # "dead" /\ vm[s] \in {"fenced", "retired"} /\ stale[s] = "none" /\ lease[s] = "none"
  /\ stale' = [stale EXCEPT ![s] = "dirty"] /\ staleAt' = [staleAt EXCEPT ![s] = now]
  /\ UNCHANGED <<status, lease, susp, owed, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* incarnation_retired: clean, so its destroy needn't wait out the window.
ReportRetired(s) ==
  /\ (RetiredReported \/ s \notin Destroyed) /\ inst = "up" /\ status # "dead" /\ vm[s] = "retired" /\ stale[s] = "dirty"
  /\ stale' = [stale EXCEPT ![s] = "clean"]
  /\ UNCHANGED <<status, lease, susp, owed, staleAt, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

WindowPass(s) ==
  /\ stale[s] = "dirty" /\ (now >= staleAt[s] + Window \/ (ReapDestroyed /\ s \in Destroyed))
  /\ stale' = [stale EXCEPT ![s] = "expired"]
  /\ UNCHANGED <<status, lease, susp, owed, staleAt, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* reapStale: one sandbox_destroy, once clean or past its window.
Reap(s) ==
  /\ status # "dead" /\ stale[s] \in {"clean", "expired"}
  /\ stale' = [stale EXCEPT ![s] = "reaped"]
  /\ UNCHANGED <<status, lease, susp, owed, staleAt, sbxVars, hostVars, now, noticeAt, lost, emptyAtKill, budget>>

\* What dies with the instance: work an incarnation of a sandbox still holds.
Dying(how) ==
  lost' = [s \in Sandboxes |-> IF dirty[s] /\ vm[s] \notin {"gone", "retired"} /\ s \notin Destroyed THEN lost[s] \cup {how} ELSE lost[s]]

\* scaleDown's draining loop: empty, so die(drained) and TerminateInstances.
Retire ==
  /\ status = "draining" /\ inst = "up"
  /\ RetireWaitsLeases => \A s \in Sandboxes : lease[s] = "none"
  /\ RetireWaitsStale => \A s \in Sandboxes : stale[s] \in {"none", "reaped"}
  /\ status' = "dead" /\ inst' = "retired" /\ Dying("retire")
  /\ UNCHANGED <<lease, susp, owed, stale, staleAt, sbxVars, vm, dirty, now, noticeAt, emptyAtKill, budget>>

-----------------------------------------------------------------------------
(* AWS and the clock *)

AwsKill ==
  /\ Spot /\ inst = "up" /\ noticeAt # NoNotice /\ now >= noticeAt + Deadline
  /\ inst' = "killed" /\ Dying("kill")
  /\ emptyAtKill' = \A s \in Sandboxes : lease[s] = "none"
  /\ UNCHANGED <<fleetVars, sbxVars, vm, dirty, now, noticeAt, budget>>

\* Every step the system takes by itself (not the guest's, an agent's, an operator's or a fault's).
System ==
  \/ Drain \/ Retire
  \/ \E s \in Sandboxes :
       \/ HostResume(s) \/ HostResumeFail(s) \/ HostSuspend(s) \/ SuspendMoot(s) \/ HostFence(s) \/ Salvage(s) \/ HostDestroy(s)
       \/ ReportRunning(s) \/ ResumeAnswered(s) \/ ReportSuspended(s) \/ EvictReported(s) \/ Sweep(s) \/ Evicted(s) \/ ReportFenced(s) \/ ReportRetired(s)
       \/ WindowPass(s) \/ Reap(s)

Tick ==
  /\ now < MaxNow /\ inst = "up" /\ ~ENABLED System
  /\ now' = now + 1
  /\ UNCHANGED <<fleetVars, sbxVars, hostVars, noticeAt, lost, emptyAtKill, budget>>

Next ==
  \/ System \/ DrainAgain \/ AwsKill \/ Tick
  \/ \E s \in Sandboxes : Write(s) \/ Wake(s) \/ SuspendFail(s) \/ Replace(s)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ status \in {"active", "draining", "dead"} /\ inst \in {"up", "retired", "killed"}
  /\ lease \in [Sandboxes -> {"none", "running", "suspended"}]
  /\ susp \in [Sandboxes -> {"none", "sent", "done", "noop", "reported", "failed"}]
  /\ stale \in [Sandboxes -> {"none", "dirty", "clean", "expired", "reaped"}]
  /\ place \in [Sandboxes -> {"here", "unplaced", "elsewhere", "released"}]
  /\ vm \in [Sandboxes -> {"running", "suspended", "fenced", "retired", "gone"}]
  /\ now \in 0..MaxNow

\* FleetDO's own termination never destroys work: what a retired host held was committed or salvaged.
NoLossByRetire == \A s \in Sandboxes : "retire" \notin lost[s]

\* Nothing an agent wrote is dropped by a refused salvage.
NoRefusedLoss == \A s \in Sandboxes : "refused" \notin lost[s]

\* A lease is dropped only for an incarnation with nothing uncommitted, or one the host will fence and salvage.
\* (The invariant behind NoLossByRetire: a sandbox off its lease and not yet stale-recorded holds no work.)
EvictedClean == \A s \in Sandboxes \ StaleSbx :
  (lease[s] = "none" /\ stale[s] = "none" /\ inst = "up") => ~dirty[s]

\* Under the timing assumption, a host FleetDO emptied is retired by FleetDO, not left for AWS to take.
DrainsInTime == ~emptyAtKill

\* A draining host never comes to rest holding a lease that could leave: suspended, with no resume unanswered.
NoStrandedLease ==
  ~(status = "draining" /\ inst = "up" /\ ~ENABLED System
    /\ \E s \in Sandboxes : lease[s] = "suspended" /\ resume[s] \notin {"sent", "done"})

\* No VM runs on a resume while its host holds no lease on it.
NoResumeOffLease == \A s \in Sandboxes : ~(vm[s] = "running" /\ lease[s] = "none" /\ resume[s] \in {"done", "answered"})

\* Reachability (each expected to be violated: the state happens).
NeverRetired == inst # "retired"
NeverKilledHolding == ~(inst = "killed" /\ \E s \in Sandboxes : lease[s] # "none")
NeverKillLoss == \A s \in Sandboxes : "kill" \notin lost[s]
NeverReplaced == \A s \in Sandboxes : place[s] # "elsewhere"
NeverResumed == \A s \in Sandboxes : resume[s] \notin {"done", "answered"}
NeverResumeFailed == budget.rfail = MaxResumeFail
=============================================================================

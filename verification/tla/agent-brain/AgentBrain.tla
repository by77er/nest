----------------------------- MODULE AgentBrain -----------------------------
(***************************************************************************)
(* The one-brain rule of nest's agent epoch: brain lifecycle across        *)
(* AgentDO, FleetDO, nestd and the agent runner.                           *)
(*                                                                         *)
(* One agent with hands; |Hosts| hosts that may run its brain; the         *)
(* sandbox's gateway is on another, healthy host.  A hands binding is      *)
(* for the sandbox epoch, which is unchanged here, so it is admitted for   *)
(* as long as the process that holds it lives: neither design has an      *)
(* agent-epoch fence at the gateway.                                       *)
(*                                                                         *)
(* Designs (constant RECORD):                                              *)
(*   FALSE  65bf6ef (origin/deferred/agent-epoch): awaiting_exit,          *)
(*          pending_start, stop_requested.                                 *)
(*   TRUE   single-record design (docs/verification/agent-brain/design):   *)
(*          brain {host, epoch, phase starting|live|condemned} + intent.   *)
(* Per-fix toggles (RECORD and all FIX_* FALSE = 65bf6ef as coded):        *)
(*   FIX_H1  nestd's brain table keyed by (agent, epoch): an older exit    *)
(*           never removes a newer entry, kill() never says "not running"  *)
(*           for a brain it lost track of; the runner keeps a tombstone    *)
(*           and refuses to register at or below it (rule 6).              *)
(*   RECORD  fix H2: one brain record, no separate awaiting_exit.          *)
(*   FIX_H3  a condemned brain's session is never current (rule 1).        *)
(*   FIX_H4  FleetDO expires any silent host (rule 5).                     *)
(*   FIX_DRAIN a drained host that still indexes brains is not dead by     *)
(*           fiat (rule 5).                                                *)
(* Amendments after this model's counterexamples (design file, 2026-10-26):*)
(*   A1      the kill is part of the condemn: a durable flag, sent from an *)
(*           alarm until FleetDO stored it; rule 4 re-sends when no kill   *)
(*           is stored and wedges only a stored, unprocessed one.          *)
(*   A2      rule 4 and every start release at once when FleetDO reports   *)
(*           brain.host dead or expired; brainsLost keeps the row until    *)
(*           AgentDO acked onHostLost, retried from the tick while the     *)
(*           host is still expired or dead (dede063 hostAgentsLost).       *)
(*   A3      (this pilot's proposal) a start never outlives a lapse or an  *)
(*           expiry: nestd drops the starts it holds when its lease lapses,*)
(*           and FleetDO drops the undelivered ones when it expires the    *)
(*           host, so an expired host that returns runs no older start.    *)
(*   REFUSED_WAITS (RefusedExitWaits, origin/deferred/brain-record         *)
(*           a38d3c0) a start refused under a tombstone has its exit       *)
(*           reported only once every older brain of the agent on that     *)
(*           host has deregistered (nestd's RunnerLink::refused).          *)
(*   START_FAIL (brain-record a38d3c0 as coded) a start nestd refuses also *)
(*           fails its command (host.rs:1941 Err(stale_epoch)); FleetDO's  *)
(*           onCommandResult drops the row and AgentDO.startFailed         *)
(*           releases the record, beside any owed exit.                    *)
(*   A5      the onHostLost ack deletes the row only if it still records   *)
(*           the epoch it was sent for (keyed by epoch or cmd).            *)
(*   A6      A2 releases on "dead" only once death is confirmed (EC2: the  *)
(*           instance is gone), or on expiry; not on a drain or idle       *)
(*           retire's "dead".                                              *)
(*   LOSS_EPOCH host loss carries the index row's epoch and releases only  *)
(*           a record at or below it (main@b2b9219 agent.ts:1085; a        *)
(*           previous-release host's epoch-less row is exempt).            *)
(*   LOST_RECHECK host loss releases only while FleetDO still reports the  *)
(*           host lost (agent.ts:1087 `hostGone`); otherwise the row stays. *)
(*           The current design has both; with both off, C6 (MC_c6).       *)
(* Mutations: WAIT = FALSE (kill and start elsewhere at once), TOMBSTONE = *)
(* FALSE (nestd's), F >= E.                                                *)
(*                                                                         *)
(* Action -> code (65bf6ef) or design rule (record):                       *)
(*  T*           agent.ts startBrain 434-517, killForMove 529-541,         *)
(*               onExited 631-648, onHostLost 655-674, wake 681-712,       *)
(*               alarms exit_wait / pending_start 1777-1798                *)
(*  R*           design rules 1-4                                          *)
(*  Hello        agent.ts onHello 951-1027 / rule 1                        *)
(*  Resolve*     agent.ts hands_resolve 862-875 (current() before & after) *)
(*  Deliver      FleetDO reliable channel, in order; agent_stop{kill}      *)
(*               applied on arrival (host.rs 808-811)                      *)
(*  Exec         nestd executor in order: agent_start (host.rs 1923-1934   *)
(*               tombstone; runner_link.rs agent_start), command results   *)
(*  RunnerStart  nest-runner agent.rs start 71-137 (lease check, register  *)
(*               loop, adopt); supervisor.rs 92-101 (AgentStop on an       *)
(*               unregistered agent is a no-op)                            *)
(*  Accept*      runner_link.rs accept_event 395-420                       *)
(*  LeaseLapse   host.rs self_fence 1096 + runner lease_watchdog, once     *)
(*               per lapse                                                 *)
(*  EventDeliver fleet.ts agent_exited 1093-1099 (brainGone, onExited)     *)
(*  HostHello    fleet.ts hello 744-808 (unacked commands resent,          *)
(*               reconcileAgents 961-985; refused if dead or wedged)       *)
(*  Expire       fleet.ts tick 1376-1386 (controller or wedged only;       *)
(*               any silent host with FIX_H4), expireController 1862       *)
(*  BrainsLost   fleet.ts brainsLost 1875-1884 (onHostLost failure only    *)
(*               logged)                                                   *)
(*  DrainRetire  fleet.ts scaleDown drained branch 1590-1600               *)
(*                                                                         *)
(* Time: ages, not clocks.  sinceAck[h] = now - send time of the newest    *)
(* acked heartbeat; the host lease holds iff sinceAck < F (nestd           *)
(* fleet.rs renew: sent_at + 20 s).  sinceRx[h] = now - FleetDO's last_rx; *)
(* expiry is enabled at sinceRx >= E (30 s).  A heartbeat is received the  *)
(* instant it is sent (the worst case for safety); its ack may be late.    *)
(* Time never passes a lapse the host hasn't acted on.  The 60 s timers    *)
(* (exit_wait, escalation) and the 2 min start deadline fire only once     *)
(* nothing is in flight on a connected link (a healthy link beats them),   *)
(* or the host is disconnected.                                            *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Hosts, NoHost,
  MaxEpoch, MaxFaults, MaxTurns, F, E,
  RECORD, FIX_H1, FIX_H3, FIX_H4, FIX_DRAIN, A1, A2, LOSS_EPOCH, A3, REFUSED_WAITS,
  START_FAIL, A5, A6, SPLIT_EXPIRE, EXPIRE_RECHECK, NO_REISSUE, NO_ADOPT,
  OLD_HOST,            \* NoHost, or the one host running the previous release
  LOST_RECHECK,        \* host loss re-checks FleetDO's lost flag at delivery
  WAIT, TOMBSTONE, ACK_DELAY,
  ALLOW_CRASH, ALLOW_PART, ALLOW_LOST, ALLOW_RESET, ALLOW_WEDGE,
  ALLOW_DRAIN, ALLOW_IDLE, ALLOW_STOP,
  SPLIT_RESTART,       \* an operator's restart records its intent, and condemns the brain in a later step (after AgentDO's awaits on FleetDO), as the code does
  PUMP_GUARD           \* with SPLIT_RESTART: no turn is sent while a restart is pending (AgentDO.pump; 2026-11-10)

VARIABLES
  up, link, conn, sinceAck, ackAge, lapsed,  \* host machine, fleet link, lease
  bTag, bBorn, bBind, bStop, bPend, rTomb,   \* runner: the registered brain process
  nSet, nSt, nEpoch, kills, nIn, hOut,       \* nestd: brain table, epochs, queues
  nOwed,                                     \* REFUSED_WAITS: a refused start's exit, owed
  fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, \* FleetDO
  fRpc,                                      \* A2: an onHostLost in flight (the row's epoch)
  fExp,                                      \* SPLIT_EXPIRE: a tick's snapshot of a silent host
  ag, tn,                                    \* AgentDO, turns
  faults, hBad, startAfterKill               \* fault budget, ghosts

hostV  == <<up, link, conn, sinceAck, ackAge, lapsed>>
brainV == <<bTag, bBorn, bBind, bStop, bPend, rTomb>>
nestdV == <<nSet, nSt, nEpoch, kills, nIn, hOut, nOwed>>
fleetV == <<fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, fRpc, fExp>>
ghostV == <<faults, hBad, startAfterKill>>
vars   == <<hostV, brainV, nestdV, fleetV, ag, tn, ghostV>>

Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b
Ev(k, e, r) == [k |-> k, e |-> e, r |-> r]   \* host -> FleetDO: "exit" | "result"
Cmd(k, e) == [k |-> k, e |-> e]              \* FleetDO -> host: "start" | "kill" | "stop"
NotStart(c) == c.k # "start"
IsStart(c) == c.k = "start"
\* A3: the exits reported for the starts dropped from queue s.
DropExits(s) == LET d == SelectSeq(s, IsStart) IN [i \in 1..Len(d) |-> Ev("exit", d[i].e, "fenced")]
DroppedEpochs(s) == {s[i].e : i \in {j \in DOMAIN s : s[j].k = "start"}}

-----------------------------------------------------------------------------
(* Derived *)

LeaseOK(h) == sinceAck[h] < F
Alive(h) == bTag[h] > 0
AgHost == IF RECORD THEN ag.bh ELSE ag.host
\* Is a session of epoch e from h current?  65bf6ef current(): e = agent_epoch
\* (the hello checked the host).  Rule 1: brain set, not condemned, e = brain.epoch.
SessOK(h, e) ==
  IF RECORD THEN ag.bh = h /\ e = ag.be /\ (FIX_H3 => ag.ph # "condemned")
  ELSE e = ag.epoch /\ (FIX_H3 => ~(ag.awaitH = h /\ ag.awaitE = e))
CanPlatform(h) == ag.sess = h /\ SessOK(h, ag.sessE) /\ bTag[h] = ag.sessE
CurSock == ag.sess # NoHost /\ CanPlatform(ag.sess)
CanHands(h) == Alive(h) /\ bBind[h] > 0
\* "Acting": an action of the brain on h would be accepted now (a platform call
\* or hands_resolve by AgentDO, or a hands call by the gateway).
Acting(h) == CanPlatform(h) \/ CanHands(h)
StartPending(h) == \/ \E i \in DOMAIN fQ[h] : fQ[h][i].k = "start"
                   \/ \E i \in DOMAIN nIn[h] : nIn[h][i].k = "start"
\* (A brain on its way out, a registration waiting, or an owed exit on a live
\* host is still in flight too: a killed process exits in well under 60 s.)
Quiet(h) == \/ ~(up[h] /\ link[h] /\ conn[h])
            \/ /\ fQ[h] = <<>> /\ nIn[h] = <<>> /\ hOut[h] = <<>>
               /\ ~(Alive(h) /\ bStop[h]) /\ bPend[h] = 0 /\ nOwed[h] = 0
CanFault == faults < MaxFaults
Work == tn.q > 0 \/ tn.cur # "none"

-----------------------------------------------------------------------------
(* nestd's handling of a runner exit (runner_link.rs accept_event), given     *)
(* its brain table S with status st:                                          *)
(*  65bf6ef: keyed by agent; no entry -> dropped; fenced before agent_started *)
(*  -> dropped; otherwise the entry goes, whichever start it belongs to.      *)
(*  FIX_H1: forwarded; only entries at or below the exit's epoch go.         *)
AccOut(S, st, out, e, r) ==
  IF FIX_H1 THEN Append(out, Ev("exit", e, r))
  ELSE IF S = {} \/ (r = "fenced" /\ st = "starting") THEN out ELSE Append(out, Ev("exit", e, r))
AccSet(S, st, e, r) ==
  IF FIX_H1 THEN {x \in S : x > e}
  ELSE IF S = {} \/ (r = "fenced" /\ st = "starting") THEN S ELSE {}
InsSet(S, e) == IF FIX_H1 THEN S \cup {e} ELSE {e}

-----------------------------------------------------------------------------
(* AgentDO reactions inside FleetDO steps *)

DieAg(a, h) == [a EXCEPT !.sess = IF a.sess = h THEN NoHost ELSE @]

TExited(a, h, e, r) ==
  IF a.host = h /\ e >= a.epoch
  THEN LET go == a.awaitH # NoHost /\ a.pending
       IN [a EXCEPT !.host = NoHost, !.state = "detached", !.awaitH = NoHost,
                    !.pendAlarm = IF go THEN TRUE ELSE @,
                    !.wake = IF go \/ r = "stopped" THEN @ ELSE TRUE]
  ELSE a
THostLost(a, h) ==
  IF a.host = h
  THEN LET b == [a EXCEPT !.host = NoHost, !.state = "detached", !.awaitH = NoHost]
       IN IF a.awaitH # NoHost /\ a.pending THEN [b EXCEPT !.pendAlarm = TRUE]
          ELSE [b EXCEPT !.sess = IF a.sess = h THEN NoHost ELSE @, !.wake = TRUE]
  ELSE a
\* Rule 3: the only release.
RRelease(a) == [a EXCEPT !.bh = NoHost, !.be = 0, !.ph = "none", !.wake = TRUE]
\* A previous-release host's brain is released only by its loss (OLD_HOST).
RExited(a, h, e) == IF a.bh = h /\ e >= a.be /\ h # OLD_HOST THEN RRelease(a) ELSE a
\* Host loss at delivery (main@b2b9219 agent.ts onHostLost 1079-1090): it
\* releases only a record at or below its epoch (LOSS_EPOCH; a previous-release
\* host's epoch-less legacy row counts as the record's own epoch), and only
\* while FleetDO still reports the host lost (LOST_RECHECK, `hostGone`).
StillLost(h) == fStatus[h] = "expired" \/ (fStatus[h] = "dead" /\ (A6 => ~up[h]))
RHostLost(a, h, e) ==
  IF /\ a.bh = h
     /\ (LOSS_EPOCH /\ h # OLD_HOST) => e >= a.be
     /\ LOST_RECHECK => StillLost(h)
  THEN RRelease(a) ELSE a

Exited(a, h, e, r) == IF RECORD THEN RExited(a, h, e) ELSE TExited(a, h, e, r)
\* e: the epoch of FleetDO's index row for (agent, h) when the loss was sent.
HostLost(a, h, e) == IF RECORD THEN RHostLost(a, h, e) ELSE THostLost(a, h)
Lost(s) == s \in {"dead", "expired"}

-----------------------------------------------------------------------------
\* OLD_HOST # NoHost: that host runs the previous release (mixed-version
\* closure, 82396b3).  It starts with a live brain at epoch 1 (with a binding
\* and the current session), FleetDO drains it on sight (it never gets a
\* start), and its brain is released only when the host is lost.
Old(h) == h = OLD_HOST
Init ==
  /\ up = [h \in Hosts |-> TRUE] /\ link = [h \in Hosts |-> TRUE]
  /\ conn = [h \in Hosts |-> TRUE] /\ sinceAck = [h \in Hosts |-> 0]
  /\ ackAge = [h \in Hosts |-> -1] /\ lapsed = [h \in Hosts |-> FALSE]
  /\ bTag = [h \in Hosts |-> IF Old(h) THEN 1 ELSE 0] /\ bBorn = [h \in Hosts |-> IF Old(h) THEN 1 ELSE 0]
  /\ bBind = [h \in Hosts |-> IF Old(h) THEN 1 ELSE 0] /\ bStop = [h \in Hosts |-> FALSE]
  /\ bPend = [h \in Hosts |-> 0] /\ rTomb = [h \in Hosts |-> 0]
  /\ nSet = [h \in Hosts |-> IF Old(h) THEN {1} ELSE {}]
  /\ nSt = [h \in Hosts |-> IF Old(h) THEN "started" ELSE "none"]
  /\ nEpoch = [h \in Hosts |-> IF Old(h) THEN 1 ELSE 0] /\ kills = [h \in Hosts |-> 0]
  /\ nIn = [h \in Hosts |-> <<>>] /\ hOut = [h \in Hosts |-> <<>>]
  /\ nOwed = [h \in Hosts |-> 0]
  /\ fStatus = [h \in Hosts |-> IF Old(h) THEN "draining" ELSE "active"] /\ fWedged = [h \in Hosts |-> FALSE]
  /\ sinceRx = [h \in Hosts |-> 0] /\ fQ = [h \in Hosts |-> <<>>]
  /\ fRow = [h \in Hosts |-> IF Old(h) THEN 1 ELSE 0] /\ fKillDone = [h \in Hosts |-> 0]
  /\ fRpc = [h \in Hosts |-> 0] /\ fExp = [h \in Hosts |-> FALSE]
  /\ LET o == OLD_HOST /= NoHost IN
     ag = [epoch |-> IF o THEN 1 ELSE 0, wake |-> FALSE, pc |-> "idle", target |-> NoHost, ie |-> 0,
           sess |-> IF o THEN OLD_HOST ELSE NoHost, sessE |-> IF o THEN 1 ELSE 0,
           lin |-> IF o THEN <<OLD_HOST, 1>> ELSE <<NoHost, 0>>, res |-> NoHost, resE |-> 0,
           host |-> NoHost, state |-> "detached", awaitH |-> NoHost, awaitE |-> 0,
           pending |-> FALSE, pendAlarm |-> FALSE, drain |-> NoHost, stopReq |-> 0,
           prev |-> NoHost, op |-> FALSE,
           bh |-> IF o THEN OLD_HOST ELSE NoHost, be |-> IF o THEN 1 ELSE 0,
           ph |-> IF o THEN "live" ELSE "none", intent |-> o, avoid |-> IF o THEN OLD_HOST ELSE NoHost,
           killq |-> FALSE, rq |-> FALSE]
  /\ tn = [q |-> 0, cur |-> "none", arrived |-> 0, afterAsk |-> FALSE, cut |-> FALSE]
  /\ faults = 0 /\ hBad = [h \in Hosts |-> FALSE] /\ startAfterKill = FALSE

-----------------------------------------------------------------------------
(* Turns: sent and completed only through the current session *)

Enqueue ==
  /\ tn.arrived < MaxTurns
  /\ tn' = [tn EXCEPT !.q = @ + 1, !.arrived = @ + 1]
  /\ ag' = [ag EXCEPT !.wake = TRUE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, ghostV>>

Pump ==
  /\ CurSock /\ tn.cur = "none" /\ tn.q > 0
  /\ (PUMP_GUARD => ~ag.rq)
  \* afterAsk (a ghost): sent while a restart was pending, which will cut it.
  /\ tn' = [tn EXCEPT !.q = @ - 1, !.cur = "sent", !.afterAsk = ag.rq]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, ag, ghostV>>

TurnDone ==
  /\ tn.cur = "sent" /\ CurSock
  /\ tn' = [tn EXCEPT !.cur = "none", !.afterAsk = FALSE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, ag, ghostV>>

-----------------------------------------------------------------------------
(* AgentDO, 65bf6ef: start() split at its awaits *)

TWakeCond == ag.state \in {"detached", "errored"} /\ ~CurSock /\ Work
TTrigger ==
  \/ ag.wake /\ TWakeCond
  \/ ag.op
  \/ ag.pendAlarm /\ ag.pending /\ ag.awaitH = NoHost
  \/ ag.drain # NoHost /\ ag.host = ag.drain

TWakeDrop ==
  /\ ~RECORD /\ ag.wake /\ (~TWakeCond \/ ag.pc # "idle")
  /\ ag' = [ag EXCEPT !.wake = FALSE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TPendDrop ==
  /\ ~RECORD /\ ag.pendAlarm /\ (~ag.pending \/ ag.awaitH # NoHost \/ ag.pc # "idle")
  /\ ag' = [ag EXCEPT !.pendAlarm = FALSE, !.wake = IF ag.pc # "idle" THEN TRUE ELSE @]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TDrainDrop ==
  /\ ~RECORD /\ ag.drain # NoHost /\ ag.host # ag.drain
  /\ ag' = [ag EXCEPT !.drain = NoHost]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TChoose(h) ==
  /\ ~RECORD /\ ag.pc = "idle" /\ TTrigger
  /\ fStatus[h] = "active" /\ conn[h] /\ h # ag.drain
  /\ ag' = [ag EXCEPT !.wake = FALSE, !.pendAlarm = FALSE, !.drain = NoHost, !.op = FALSE,
                      !.target = h, !.prev = ag.host,
                      !.pc = IF CurSock /\ ag.host = h /\ ag.stopReq # ag.epoch THEN "idle"
                             ELSE IF ag.host # NoHost /\ ag.host # h THEN "status"
                             ELSE "bump"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TStatus ==
  /\ ~RECORD /\ ag.pc = "status"
  /\ LET p == ag.prev IN
     ag' = IF fStatus[p] \in {"dead", "expired"}
           THEN [ag EXCEPT !.host = IF ag.host = p THEN NoHost ELSE @, !.pc = "bump"]
           ELSE IF ~WAIT THEN [ag EXCEPT !.sess = NoHost, !.pc = "killgo"]
           ELSE IF ag.awaitH = p /\ ag.awaitE = ag.epoch
           THEN [ag EXCEPT !.sess = NoHost, !.pending = TRUE, !.pc = "idle"]
           ELSE [ag EXCEPT !.sess = NoHost, !.pc = "kill"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

\* killForMove: issueCommands(kill), then (after the await) awaiting_exit and
\* pending_start.  "killgo" is the WAIT = FALSE mutation (kill, then start).
TKill ==
  /\ ~RECORD /\ ag.pc \in {"kill", "killgo"}
  /\ fQ' = [fQ EXCEPT ![ag.prev] = Append(@, Cmd("kill", ag.epoch))]
  /\ ag' = [ag EXCEPT !.pc = IF ag.pc = "killgo" THEN "bump" ELSE "killawait"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, ghostV>>

\* After the await (agent.ts 537-540): awaiting_exit and pending_start are
\* written whatever happened meanwhile.
TKillAwait ==
  /\ ~RECORD /\ ag.pc = "killawait"
  /\ ag' = [ag EXCEPT !.awaitH = ag.prev, !.awaitE = ag.epoch, !.pending = TRUE, !.pc = "idle"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TBump ==
  /\ ~RECORD /\ ag.pc = "bump" /\ ag.epoch < MaxEpoch
  /\ ag' = [ag EXCEPT !.epoch = @ + 1, !.host = ag.target, !.state = "starting",
                      !.pending = FALSE, !.stopReq = 0, !.ie = ag.epoch + 1, !.pc = "issue"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TDeadline ==
  /\ ~RECORD /\ ag.state = "starting" /\ ~CurSock /\ ag.pc = "idle"
  /\ ag.host = NoHost \/ (Quiet(ag.host) /\ ~(Alive(ag.host) /\ bTag[ag.host] = ag.epoch))
  /\ ag' = [ag EXCEPT !.state = "errored", !.wake = TRUE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

TExitWait ==
  /\ ~RECORD /\ ag.awaitH # NoHost /\ Quiet(ag.awaitH)
  /\ fStatus[ag.awaitH] \in {"active", "draining"} /\ ~fWedged[ag.awaitH]
  /\ fWedged' = [fWedged EXCEPT ![ag.awaitH] = TRUE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, sinceRx, fQ, fRow, fKillDone, fExp, fRpc, ag, tn, ghostV>>

\* An operator's graceful stop (stop_requested first), and POST /start.
TOpStop ==
  /\ ~RECORD /\ ALLOW_STOP /\ CanFault /\ ag.host # NoHost /\ ag.pc = "idle"
  /\ ag.stopReq # ag.epoch
  /\ fQ' = [fQ EXCEPT ![ag.host] = Append(@, Cmd("stop", ag.epoch))]
  /\ ag' = [ag EXCEPT !.stopReq = ag.epoch]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, hBad, startAfterKill>>

TOpStart ==
  /\ ~RECORD /\ ALLOW_STOP /\ CanFault /\ ~ag.op
  /\ ag' = [ag EXCEPT !.op = TRUE]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

\* (H3 as coded: a killed brain at the unchanged epoch is accepted again;
\* FIX_H3 refuses a session from the brain awaiting_exit names.)
THelloOK(h) == ag.host = h /\ bTag[h] = ag.epoch
               /\ (FIX_H3 => ~(ag.awaitH = h /\ ag.awaitE = ag.epoch) /\ ag.pc \notin {"kill", "killawait"})

-----------------------------------------------------------------------------
(* AgentDO, the record design *)

RWake ==
  /\ RECORD /\ ag.wake
  /\ ag' = [ag EXCEPT !.wake = FALSE, !.intent = IF Work /\ ~CurSock THEN TRUE ELSE @]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

Healthy(h) == fStatus[h] = "active" /\ conn[h]

\* Rule 2.  Target: the previous host when healthy (never moved to follow a
\* sandbox), else any healthy host; never `avoid`.
RStart(h) ==
  /\ RECORD /\ ag.pc = "idle" /\ ag.intent /\ ag.ph # "condemned"
  /\ Healthy(h) /\ h # ag.avoid
  /\ (ag.bh # NoHost /\ Healthy(ag.bh) /\ ag.bh # ag.avoid) => h = ag.bh
  /\ IF NO_REISSUE /\ ag.bh # NoHost /\ ag.bh = h
     THEN \* no same-host re-issue: a start while a non-condemned brain exists
          \* answers `none` (the brain reconnects itself, or exits and is released)
          /\ ag' = [ag EXCEPT !.intent = FALSE]
          /\ fQ' = fQ
     ELSE IF ag.bh = NoHost \/ ag.bh = h \/ ~WAIT
     THEN /\ ag.epoch < MaxEpoch
          /\ fQ' = IF ag.bh # NoHost /\ ag.bh # h          \* WAIT = FALSE mutation
                   THEN [fQ EXCEPT ![ag.bh] = Append(@, Cmd("kill", ag.be))] ELSE fQ
          /\ ag' = [ag EXCEPT !.epoch = @ + 1, !.bh = h, !.be = ag.epoch + 1, !.ph = "starting",
                              !.intent = FALSE, !.avoid = NoHost, !.target = h,
                              !.ie = ag.epoch + 1, !.pc = "issue"]
     ELSE /\ ag' = IF A1 THEN [ag EXCEPT !.ph = "condemned", !.killq = TRUE]
                   ELSE [ag EXCEPT !.ph = "condemned", !.target = ag.bh, !.ie = ag.be, !.pc = "kill"]
          /\ fQ' = fQ
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, ghostV>>

RKill ==
  /\ RECORD /\ ag.pc = "kill"
  /\ fQ' = [fQ EXCEPT ![ag.target] = Append(@, Cmd("kill", ag.ie))]
  /\ ag' = [ag EXCEPT !.pc = "idle"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, ghostV>>

\* The kill's issueCommands RPC fails before FleetDO stored anything.
RKillFail ==
  /\ RECORD /\ ag.pc = "kill" /\ ALLOW_LOST /\ CanFault
  /\ ag' = [ag EXCEPT !.pc = "idle"]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

\* The starting deadline (not in the design text; assumed): a starting brain
\* that can no longer say hello is condemned, and its start is wanted again.
RDeadline ==
  /\ RECORD /\ ag.ph = "starting" /\ ag.pc = "idle" /\ ~CurSock
  /\ Quiet(ag.bh) /\ ~(Alive(ag.bh) /\ bTag[ag.bh] = ag.be)
  /\ ag' = IF A1 THEN [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.killq = TRUE]
           ELSE [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.target = ag.bh, !.ie = ag.be, !.pc = "kill"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

\* An operator's restart (record design): condemn the brain and keep the
\* intent; the start runs once the brain is released (maybe on the same host).
\* With SPLIT_RESTART, only the intent here (`setIntent`); the condemn is ROpRestartCondemn.
ROpRestart ==
  /\ RECORD /\ ALLOW_STOP /\ CanFault /\ ag.pc = "idle" /\ ag.bh # NoHost /\ ag.ph # "condemned" /\ ~ag.rq
  /\ ag' = IF SPLIT_RESTART THEN [ag EXCEPT !.rq = TRUE]
           ELSE IF A1 THEN [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.killq = TRUE]
           ELSE [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.target = ag.bh, !.ie = ag.be, !.pc = "kill"]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

\* SPLIT_RESTART: `processIntent` after its awaits on FleetDO (`hostGone`, `hostStatus`): the brain still
\* there and not condemned is condemned, as ROpRestart did at once; else only the start is wanted.
\* A turn sent meanwhile (Pump without PUMP_GUARD) is cut by it: the ghost `tn.cut`.
ROpRestartCondemn ==
  /\ SPLIT_RESTART /\ ag.rq /\ ag.pc = "idle"
  /\ ag' = IF ag.bh # NoHost /\ ag.ph # "condemned"
             THEN IF A1 THEN [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.killq = TRUE, !.rq = FALSE]
                  ELSE [ag EXCEPT !.ph = "condemned", !.intent = TRUE, !.target = ag.bh, !.ie = ag.be, !.pc = "kill", !.rq = FALSE]
             ELSE [ag EXCEPT !.intent = TRUE, !.rq = FALSE]
  /\ tn' = [tn EXCEPT !.cut = @ \/ (tn.cur = "sent" /\ tn.afterAsk)]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, ghostV>>

\* SPLIT_RESTART: the pending restart is refused after it was recorded (`requireLaunch`, `intentFailed`), or
\* given up after RESTART_MAX_FAILURES retryable failures with the brain live (`restartGivenUp`): the intent
\* goes, the brain stays, and queued turns run on it.
ROpRestartDrop ==
  /\ SPLIT_RESTART /\ ag.rq /\ ag.pc = "idle"
  /\ ag' = [ag EXCEPT !.rq = FALSE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

KillStored(h, e) ==
  \/ fKillDone[h] >= e
  \/ \E i \in DOMAIN fQ[h] : fQ[h][i].k = "kill" /\ fQ[h][i].e >= e
  \/ \E i \in DOMAIN nIn[h] : nIn[h][i].k = "kill" /\ nIn[h][i].e >= e

\* A1: the condemned brain's kill, sent from an alarm until FleetDO stored it
\* (deduplicated by agent + epoch).
RKillAlarm ==
  /\ RECORD /\ A1 /\ ag.ph = "condemned" /\ ag.killq
  /\ fQ' = IF KillStored(ag.bh, ag.be) THEN fQ
           ELSE [fQ EXCEPT ![ag.bh] = Append(@, Cmd("kill", ag.be))]
  /\ ag' = [ag EXCEPT !.killq = FALSE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, ghostV>>

\* A2: brain.host is dead or expired: release at once (rule 4, every start).
RStatusRelease ==
  /\ RECORD /\ A2 /\ ag.pc = "idle" /\ ag.bh # NoHost /\ Lost(fStatus[ag.bh])
  /\ A6 => (fStatus[ag.bh] = "expired" \/ ~up[ag.bh])
  /\ ag.intent \/ ag.ph = "condemned"
  /\ ag' = RRelease(ag)
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

\* Rule 4 (since + 60 s, re-checked to the 15 min cap).
REscalate ==
  /\ RECORD /\ ag.ph = "condemned" /\ ag.pc = "idle" /\ Quiet(ag.bh)
  /\ ~ag.killq
  /\ A2 => ~Lost(fStatus[ag.bh])                 \* RStatusRelease first
  /\ ag.bh # OLD_HOST                            \* never wedges or releases a previous-release host
  /\ LET h == ag.bh
         \* "processed" = the host's own result for the kill (Exec -> EventDeliver).
         \* FleetDO never writes a kill's answer itself in this model, matching
         \* PR #32 (`commands.answered_by`: 'fleet' answers never count).
         processed == fKillDone[h] >= ag.be
         row == fRow[h] # 0 /\ fRow[h] <= ag.be
     IN IF processed /\ ~row
        THEN ag' = RRelease(ag) /\ UNCHANGED fWedged
        ELSE IF A1 /\ ~KillStored(h, ag.be)
        THEN \* A1: no kill stored: (re)send it, never wedge
             ag' = [ag EXCEPT !.killq = TRUE] /\ UNCHANGED fWedged
        ELSE /\ fStatus[h] \in {"active", "draining"} /\ ~fWedged[h]
             /\ fWedged' = [fWedged EXCEPT ![h] = TRUE] /\ ag' = ag
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, sinceRx, fQ, fRow, fKillDone, fExp, fRpc, tn, ghostV>>

\* 36b60d5 (N21): a condemned brain on a previous-release host is waited on
\* for its host's loss; at the 15 min cap the host is wedged (so its lease
\* lapses and it is expired, which releases the brain).
ROldCap ==
  /\ RECORD /\ OLD_HOST # NoHost /\ ag.bh = OLD_HOST /\ ag.ph = "condemned" /\ ag.pc = "idle"
  /\ ~ag.killq /\ Quiet(OLD_HOST)
  /\ fStatus[OLD_HOST] \in {"active", "draining"} /\ ~fWedged[OLD_HOST]
  /\ fWedged' = [fWedged EXCEPT ![OLD_HOST] = TRUE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, sinceRx, fQ, fRow, fKillDone, fRpc, fExp, ag, tn, ghostV>>

RHelloOK(h) == ag.bh = h /\ bTag[h] = ag.be /\ (FIX_H3 => ag.ph # "condemned")

-----------------------------------------------------------------------------
(* AgentDO, shared *)

\* A3: FleetDO refuses a start for a host it has expired (as for a dead one).
Issue ==
  /\ ag.pc = "issue"
  /\ IF A3 /\ Lost(fStatus[ag.target]) THEN UNCHANGED <<fQ, fRow>>
     ELSE /\ fQ' = [fQ EXCEPT ![ag.target] = Append(@, Cmd("start", ag.ie))]
          /\ fRow' = [fRow EXCEPT ![ag.target] = ag.ie]
  /\ ag' = [ag EXCEPT !.pc = "idle"]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fKillDone, fExp, fRpc, tn, ghostV>>

IssueFail ==
  /\ ag.pc = "issue" /\ ALLOW_LOST /\ CanFault
  /\ ag' = [ag EXCEPT !.pc = "idle", !.wake = TRUE,
                      !.state = IF ~RECORD /\ @ = "starting" THEN "detached" ELSE @]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

ResetAgentDO ==
  /\ ALLOW_RESET /\ CanFault /\ (ag.pc # "idle" \/ ag.res # NoHost)
  /\ ag' = [ag EXCEPT !.pc = "idle", !.res = NoHost]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

Hello(h) ==
  /\ Alive(h) /\ (IF RECORD THEN RHelloOK(h) ELSE THelloOK(h))
  /\ ~(ag.sess = h /\ ag.sessE = bTag[h] /\ ag.lin = <<h, bBorn[h]>>)
  /\ LET newLin == ag.lin # <<h, bBorn[h]>> IN
     /\ ag' = [ag EXCEPT !.sess = h, !.sessE = bTag[h], !.lin = <<h, bBorn[h]>>,
                         !.state = IF @ \in {"starting", "detached", "errored"} THEN "ready" ELSE @,
                         !.ph = IF @ = "starting" THEN "live" ELSE @]
     /\ tn' = IF newLin /\ tn.cur = "sent" THEN [tn EXCEPT !.q = @ + 1, !.cur = "none", !.afterAsk = FALSE] ELSE tn
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, ghostV>>

\* The session socket drops (network); the brain lives on and may reconnect.
SessDrop ==
  /\ ALLOW_IDLE /\ CanFault /\ ag.sess # NoHost
  /\ ag' = [ag EXCEPT !.sess = NoHost, !.wake = TRUE]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, hBad, startAfterKill>>

ResolveReq(h) ==
  /\ CanPlatform(h) /\ ag.res = NoHost /\ bBind[h] = 0
  /\ ag' = [ag EXCEPT !.res = h, !.resE = bTag[h]]
  /\ UNCHANGED <<hostV, brainV, nestdV, fleetV, tn, ghostV>>

ResolveResp ==
  /\ ag.res # NoHost
  /\ LET h == ag.res IN
     bBind' = IF bTag[h] = ag.resE /\ CanPlatform(h) THEN [bBind EXCEPT ![h] = 1] ELSE bBind
  /\ ag' = [ag EXCEPT !.res = NoHost]
  /\ UNCHANGED <<hostV, bTag, bBorn, bStop, bPend, rTomb, nestdV, fleetV, tn, ghostV>>

-----------------------------------------------------------------------------
(* nestd and the runner *)

\* The runner's brain on h exits now; its exit goes through nestd's filter.
Die(h, r) ==
  /\ bTag' = [bTag EXCEPT ![h] = 0] /\ bBind' = [bBind EXCEPT ![h] = 0]
  /\ bStop' = [bStop EXCEPT ![h] = FALSE]
  /\ hOut' = [hOut EXCEPT ![h] = AccOut(nSet[h], nSt[h], @, bTag[h], r)]
  /\ nSet' = [nSet EXCEPT ![h] = AccSet(@, nSt[h], bTag[h], r)]
  /\ ag' = DieAg(ag, h)

\* A start refused under a tombstone: its exit now, or (REFUSED_WAITS) owed
\* while an older brain of the agent is still registered on h.
OlderAlive(h, e) == Alive(h) /\ bTag[h] < e
RefuseOut(h, out, e) == IF REFUSED_WAITS /\ OlderAlive(h, e) THEN out ELSE Append(out, Ev("exit", e, "fenced"))
RefuseOwed(h, e) == IF REFUSED_WAITS /\ OlderAlive(h, e) THEN [nOwed EXCEPT ![h] = Max(@, e)] ELSE nOwed
\* A start nestd itself refuses: with START_FAIL its command fails too, at once.
NestdRefuseOut(h, out, e) ==
  LET o == RefuseOut(h, out, e) IN IF START_FAIL THEN Append(o, Ev("fail", e, "start")) ELSE o

\* agent_stop{kill, epoch e}, applied when it arrives (runner_link.rs kill()).
\* A kill makes the brain exit (kill_now); the process lives, holding its
\* binding, until its exit (StopExit), which is reported then.
ApplyKill(h, e) ==
  /\ kills' = [kills EXCEPT ![h] = Max(@, e)]
  /\ rTomb' = [rTomb EXCEPT ![h] = IF FIX_H1 THEN Max(@, e) ELSE @]
  /\ UNCHANGED <<bTag, bBorn, bBind, nSt, ag>>
  /\ IF FIX_H1
     THEN LET killOld == Alive(h) /\ bTag[h] <= e
              refusePend == bPend[h] # 0 /\ bPend[h] <= e
          IN IF ~(\E x \in nSet[h] : x <= e) \/ (~killOld /\ ~refusePend)
             THEN \* nothing at or below e here: say so
                  /\ hOut' = [hOut EXCEPT ![h] = Append(@, Ev("exit", e, "stopped"))]
                  /\ nSet' = [nSet EXCEPT ![h] = {x \in @ : x > e}]
                  /\ UNCHANGED <<bStop, bPend, nOwed, faults, hBad>>
             ELSE /\ \/ /\ bStop' = IF killOld THEN [bStop EXCEPT ![h] = TRUE] ELSE bStop
                        /\ UNCHANGED <<faults, hBad>>
                     \/ /\ killOld /\ ALLOW_WEDGE /\ CanFault   \* the runner never applies it
                        /\ faults' = faults + 1 /\ hBad' = [hBad EXCEPT ![h] = TRUE]
                        /\ UNCHANGED bStop
                  \* the runner's tombstone refuses a registration waiting at or below e
                  /\ bPend' = IF refusePend THEN [bPend EXCEPT ![h] = 0] ELSE bPend
                  /\ hOut' = IF refusePend THEN [hOut EXCEPT ![h] = RefuseOut(h, @, bPend[h])] ELSE hOut
                  /\ nOwed' = IF refusePend THEN RefuseOwed(h, bPend[h]) ELSE nOwed
                  /\ nSet' = IF refusePend THEN [nSet EXCEPT ![h] = @ \ {bPend[h]}] ELSE nSet
     ELSE /\ UNCHANGED <<nSet, nOwed, bPend>>
          /\ IF nSet[h] = {} \/ nEpoch[h] > e
             THEN \* "not running here": nestd reports the exit itself
                  /\ hOut' = [hOut EXCEPT ![h] = Append(@, Ev("exit", e, "stopped"))]
                  /\ UNCHANGED <<bStop, faults, hBad>>
             ELSE IF Alive(h)
             THEN /\ UNCHANGED hOut
                  /\ \/ bStop' = [bStop EXCEPT ![h] = TRUE] /\ UNCHANGED <<faults, hBad>>
                     \/ /\ ALLOW_WEDGE /\ CanFault
                        /\ faults' = faults + 1 /\ hBad' = [hBad EXCEPT ![h] = TRUE]
                        /\ UNCHANGED bStop
             ELSE \* nothing registered at the runner: AgentStop is a no-op
                  UNCHANGED <<hOut, bStop, faults, hBad>>

Deliver(h) ==
  /\ up[h] /\ link[h] /\ conn[h] /\ fQ[h] # <<>>
  /\ LET c == Head(fQ[h]) IN
     /\ fQ' = [fQ EXCEPT ![h] = Tail(@)]
     /\ IF c.k = "kill" THEN ApplyKill(h, c.e) /\ nIn' = [nIn EXCEPT ![h] = Append(@, c)]
        ELSE IF A3 /\ c.k = "start" /\ (lapsed[h] \/ ~LeaseOK(h))
        THEN \* A3: a start arriving while the lease is lapsed is refused, with its
             \* exit (owed under REFUSED_WAITS while an older brain lives)
             /\ hOut' = [hOut EXCEPT ![h] = NestdRefuseOut(h, @, c.e)]
             /\ nOwed' = RefuseOwed(h, c.e)
             /\ UNCHANGED <<brainV, nSet, kills, nIn, ag, faults, hBad>>
        ELSE /\ nIn' = [nIn EXCEPT ![h] = Append(@, c)]
             /\ UNCHANGED <<brainV, nSet, kills, hOut, nOwed, ag, faults, hBad>>
  /\ UNCHANGED <<hostV, nSt, nEpoch, fStatus, fWedged, sinceRx, fRow, fKillDone, fExp, fRpc, tn, startAfterKill>>

\* nestd ran agent_start{e}: its table already holds S0 (with the new entry).
RunnerStart(h, e, S0) ==
  IF ~LeaseOK(h) \/ lapsed[h]
  THEN \* no valid lease mirror: refused with exit{fenced} before agent_started
       \* (with FIX_H1 forwarded, and owed under REFUSED_WAITS)
       /\ hOut' = [hOut EXCEPT ![h] = IF FIX_H1 THEN RefuseOut(h, @, e)
                                       ELSE AccOut(S0, "starting", @, e, "fenced")]
       /\ nOwed' = IF FIX_H1 THEN RefuseOwed(h, e) ELSE nOwed
       /\ nSet' = [nSet EXCEPT ![h] = IF FIX_H1 THEN S0 \ {e} ELSE AccSet(S0, "starting", e, "fenced")]
       /\ nSt' = [nSt EXCEPT ![h] = "starting"]
       /\ UNCHANGED <<bTag, bBorn, bBind, bStop, bPend, ag, startAfterKill>>
  ELSE IF FIX_H1 /\ e <= rTomb[h]
  THEN /\ hOut' = [hOut EXCEPT ![h] = RefuseOut(h, @, e)]
       /\ nOwed' = RefuseOwed(h, e)
       /\ nSet' = [nSet EXCEPT ![h] = S0 \ {e}]
       /\ UNCHANGED <<nSt, bTag, bBorn, bBind, bStop, bPend, ag, startAfterKill>>
  ELSE IF ~Alive(h) /\ bPend[h] = 0
  THEN /\ bTag' = [bTag EXCEPT ![h] = e] /\ bBorn' = [bBorn EXCEPT ![h] = e]
       /\ bBind' = [bBind EXCEPT ![h] = 0] /\ bStop' = [bStop EXCEPT ![h] = FALSE]
       /\ nSet' = [nSet EXCEPT ![h] = S0] /\ nSt' = [nSt EXCEPT ![h] = "started"]
       /\ startAfterKill' = (startAfterKill \/ kills[h] >= e)
       /\ UNCHANGED <<bPend, hOut, nOwed, ag>>
  ELSE IF Alive(h) /\ (bStop[h] \/ NO_ADOPT)
  THEN \* never adopt a brain on its way out (stopping or killed) - with
       \* NO_ADOPT (82396b3) never adopt at all: the registered brain is ended
       \* (kill_now) and the new one registers once it is gone (Register).
       /\ bPend' = [bPend EXCEPT ![h] = e]
       /\ bStop' = [bStop EXCEPT ![h] = TRUE]
       /\ nSet' = [nSet EXCEPT ![h] = S0] /\ nSt' = [nSt EXCEPT ![h] = "starting"]
       /\ UNCHANGED <<bTag, bBorn, bBind, hOut, nOwed, ag, startAfterKill>>
  ELSE IF Alive(h) /\ e > bTag[h]
  THEN \* adopt the newer epoch, take the new hands, re-handshake the session
       /\ bTag' = [bTag EXCEPT ![h] = e] /\ bBind' = [bBind EXCEPT ![h] = 0]
       /\ nSet' = [nSet EXCEPT ![h] = S0] /\ nSt' = [nSt EXCEPT ![h] = "starting"]
       /\ ag' = [ag EXCEPT !.sess = IF @ = h THEN NoHost ELSE @]
       /\ startAfterKill' = (startAfterKill \/ kills[h] >= e)
       /\ UNCHANGED <<bBorn, bStop, bPend, hOut, nOwed>>
  ELSE /\ nSet' = [nSet EXCEPT ![h] = S0] /\ nSt' = [nSt EXCEPT ![h] = "starting"]
       /\ UNCHANGED <<bTag, bBorn, bBind, bStop, bPend, hOut, nOwed, ag, startAfterKill>>

Exec(h) ==
  /\ up[h] /\ nIn[h] # <<>>
  /\ LET c == Head(nIn[h]) IN
     /\ nIn' = [nIn EXCEPT ![h] = Tail(@)]
     /\ CASE c.k = "start" ->
              /\ IF TOMBSTONE /\ kills[h] >= c.e
                 THEN \* nestd's tombstone refuses it
                      /\ hOut' = [hOut EXCEPT ![h] = NestdRefuseOut(h, @, c.e)]
                      /\ nOwed' = RefuseOwed(h, c.e)
                      /\ UNCHANGED <<bTag, bBorn, bBind, bStop, bPend, nSet, nSt, nEpoch, ag, startAfterKill>>
                 ELSE /\ nEpoch' = [nEpoch EXCEPT ![h] = c.e]
                      /\ RunnerStart(h, c.e, InsSet(nSet[h], c.e))
              /\ UNCHANGED <<rTomb, kills>>
          [] c.k = "kill" ->      \* applied on arrival; in order now for its result
              /\ hOut' = [hOut EXCEPT ![h] = Append(@, Ev("result", c.e, "kill"))]
              /\ UNCHANGED <<brainV, nSet, nSt, nEpoch, kills, nOwed, ag, startAfterKill>>
          [] c.k = "stop" ->
              /\ bStop' = IF Alive(h) THEN [bStop EXCEPT ![h] = TRUE] ELSE bStop
              /\ UNCHANGED <<bTag, bBorn, bBind, bPend, rTomb, nSet, nSt, nEpoch, kills, hOut, nOwed, ag, startAfterKill>>
  /\ UNCHANGED <<hostV, fleetV, tn, faults, hBad>>

\* REFUSED_WAITS: the owed exit goes out once no older brain is registered.
OwedExit(h) ==
  /\ up[h] /\ nOwed[h] > 0 /\ ~OlderAlive(h, nOwed[h])
  /\ hOut' = [hOut EXCEPT ![h] = Append(@, Ev("exit", nOwed[h], "fenced"))]
  /\ nOwed' = [nOwed EXCEPT ![h] = 0]
  /\ UNCHANGED <<hostV, brainV, nSet, nSt, nEpoch, kills, nIn, fleetV, ag, tn, ghostV>>

\* The runner's start registers once the brain on its way out is gone.
\* The lease watchdog fired once at the lapse; a later registration is not
\* checked against the lease again (A3 drops it at the lapse).
Register(h) ==
  /\ up[h] /\ bPend[h] > 0 /\ ~Alive(h)
  /\ IF FIX_H1 /\ bPend[h] <= rTomb[h]
     THEN /\ hOut' = [hOut EXCEPT ![h] = Append(@, Ev("exit", bPend[h], "stopped"))]
          /\ nSet' = [nSet EXCEPT ![h] = {x \in @ : x > bPend[h]}]
          /\ UNCHANGED <<bTag, bBorn, nSt, startAfterKill>>
     ELSE /\ bTag' = [bTag EXCEPT ![h] = bPend[h]] /\ bBorn' = [bBorn EXCEPT ![h] = bPend[h]]
          /\ nSt' = [nSt EXCEPT ![h] = IF nSet[h] # {} THEN "started" ELSE @]
          /\ startAfterKill' = (startAfterKill \/ kills[h] >= bPend[h])
          /\ UNCHANGED <<hOut, nSet>>
  /\ bPend' = [bPend EXCEPT ![h] = 0]
  /\ UNCHANGED <<hostV, bBind, bStop, rTomb, nEpoch, kills, nIn, nOwed, fleetV, ag, tn, faults, hBad>>

\* A brain on its way out (told to stop, killed, or exiting idle) exits.
StopExit(h) ==
  /\ up[h] /\ Alive(h) /\ bStop[h]
  /\ Die(h, "stopped")
  /\ UNCHANGED <<hostV, bBorn, bPend, rTomb, nSt, nEpoch, kills, nIn, nOwed, fleetV, tn, ghostV>>

\* The brain starts exiting on its own (idle: stdin closed); its session drops.
IdleBegin(h) ==
  /\ ALLOW_IDLE /\ CanFault /\ up[h] /\ Alive(h) /\ ~bStop[h]
  /\ bStop' = [bStop EXCEPT ![h] = TRUE]
  /\ ag' = [ag EXCEPT !.sess = IF @ = h THEN NoHost ELSE @, !.wake = TRUE]
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, bTag, bBorn, bBind, bPend, rTomb, nestdV, fleetV, tn, hBad, startAfterKill>>

BrainCrash(h) ==
  /\ ALLOW_CRASH /\ CanFault /\ up[h] /\ Alive(h)
  /\ Die(h, "crashed")
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, bBorn, bPend, rTomb, nSt, nEpoch, kills, nIn, nOwed, fleetV, tn, hBad, startAfterKill>>

\* Lease lapse: nestd fences every entry (so their exits pass the filter) and
\* the runner's watchdog kills every registered brain; both once per lapse.
LeaseLapse(h) ==
  /\ up[h] /\ ~LeaseOK(h) /\ ~lapsed[h]
  /\ lapsed' = [lapsed EXCEPT ![h] = TRUE]
  /\ bTag' = [bTag EXCEPT ![h] = 0] /\ bBind' = [bBind EXCEPT ![h] = 0]
  /\ bStop' = [bStop EXCEPT ![h] = FALSE]
  /\ LET out1 == IF Alive(h) /\ nSet[h] # {}
                 THEN Append(hOut[h], Ev("exit", bTag[h], "fenced")) ELSE hOut[h]
         \* A3: the starts nestd holds, and a registration waiting in the
         \* runner, are refused too, each with its exit.
         out2 == IF A3 THEN out1 \o DropExits(nIn[h]) ELSE out1
         out3 == IF A3 /\ bPend[h] > 0 THEN Append(out2, Ev("exit", bPend[h], "fenced")) ELSE out2
     IN hOut' = [hOut EXCEPT ![h] = out3]
  /\ nSet' = IF Alive(h) THEN [nSet EXCEPT ![h] = AccSet(@, "started", bTag[h], "fenced")] ELSE nSet
  /\ ag' = DieAg(ag, h)
  /\ nIn' = IF A3 THEN [nIn EXCEPT ![h] = SelectSeq(@, NotStart)] ELSE nIn
  /\ bPend' = IF A3 THEN [bPend EXCEPT ![h] = 0] ELSE bPend
  /\ UNCHANGED <<up, link, conn, sinceAck, ackAge, bBorn, rTomb, nSt, nEpoch, kills, nOwed, fleetV, tn, ghostV>>

-----------------------------------------------------------------------------
(* Hosts, links, time *)

HostCrash(h) ==
  /\ ALLOW_CRASH /\ CanFault /\ up[h] /\ \E o \in Hosts : o # h /\ up[o]
  /\ up' = [up EXCEPT ![h] = FALSE] /\ conn' = [conn EXCEPT ![h] = FALSE]
  /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  /\ bTag' = [bTag EXCEPT ![h] = 0] /\ bBind' = [bBind EXCEPT ![h] = 0]
  /\ bStop' = [bStop EXCEPT ![h] = FALSE] /\ bPend' = [bPend EXCEPT ![h] = 0]
  /\ nIn' = [nIn EXCEPT ![h] = <<>>] /\ hOut' = [hOut EXCEPT ![h] = <<>>]
  /\ nSet' = [nSet EXCEPT ![h] = {}]
  /\ ag' = DieAg(ag, h)
  /\ faults' = faults + 1 /\ hBad' = [hBad EXCEPT ![h] = TRUE]
  /\ nOwed' = [nOwed EXCEPT ![h] = 0]
  /\ UNCHANGED <<link, sinceAck, lapsed, bBorn, rTomb, nSt, nEpoch, kills, fleetV, tn, startAfterKill>>

\* The instance of a host FleetDO retired, or whose spot deadline passed, goes.
Terminate(h) ==
  /\ up[h] /\ fStatus[h] \in {"dead", "draining"}
  /\ up' = [up EXCEPT ![h] = FALSE] /\ conn' = [conn EXCEPT ![h] = FALSE]
  /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  /\ bTag' = [bTag EXCEPT ![h] = 0] /\ bBind' = [bBind EXCEPT ![h] = 0]
  /\ bStop' = [bStop EXCEPT ![h] = FALSE] /\ bPend' = [bPend EXCEPT ![h] = 0]
  /\ nIn' = [nIn EXCEPT ![h] = <<>>] /\ hOut' = [hOut EXCEPT ![h] = <<>>]
  /\ nSet' = [nSet EXCEPT ![h] = {}]
  /\ ag' = DieAg(ag, h)
  /\ hBad' = [hBad EXCEPT ![h] = TRUE]
  /\ nOwed' = [nOwed EXCEPT ![h] = 0]
  /\ UNCHANGED <<link, sinceAck, lapsed, bBorn, rTomb, nSt, nEpoch, kills, fleetV, tn, faults, startAfterKill>>

\* The host <-> FleetDO path breaks; the session and gateway paths may stay up.
Partition(h) ==
  /\ ALLOW_PART /\ CanFault /\ link[h] /\ up[h]
  /\ link' = [link EXCEPT ![h] = FALSE] /\ conn' = [conn EXCEPT ![h] = FALSE]
  /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  /\ faults' = faults + 1 /\ hBad' = [hBad EXCEPT ![h] = TRUE]
  /\ UNCHANGED <<up, sinceAck, lapsed, brainV, nestdV, fleetV, ag, tn, startAfterKill>>

Heal(h) ==
  /\ ~link[h]
  /\ link' = [link EXCEPT ![h] = TRUE]
  /\ UNCHANGED <<up, conn, sinceAck, ackAge, lapsed, brainV, nestdV, fleetV, ag, tn, ghostV>>

\* nestd's fleet hello: refused if dead or wedged; expired -> active; the
\* hello_ack renews the lease; unacked commands stay queued (resent);
\* reconcileAgents: an indexed brain not reported, start completed -> exited.
HostHello(h) ==
  /\ up[h] /\ link[h] /\ ~conn[h] /\ fStatus[h] # "dead" /\ ~fWedged[h]
  /\ conn' = [conn EXCEPT ![h] = TRUE]
  /\ sinceAck' = [sinceAck EXCEPT ![h] = 0] /\ lapsed' = [lapsed EXCEPT ![h] = FALSE]
  /\ sinceRx' = [sinceRx EXCEPT ![h] = 0]
  /\ fStatus' = [fStatus EXCEPT ![h] = IF @ = "expired" THEN "active" ELSE @]
  /\ IF fRow[h] > 0 /\ nSet[h] = {} /\ ~StartPending(h)
     THEN /\ fRow' = [fRow EXCEPT ![h] = 0]
          /\ ag' = Exited(ag, h, fRow[h], "crashed")
     ELSE /\ fRow' = fRow
          /\ ag' = IF ~RECORD /\ nSet[h] # {} /\ ag.host = h /\ ag.state = "detached"
                   THEN [ag EXCEPT !.state = "ready"] ELSE ag
  /\ UNCHANGED <<up, link, ackAge, brainV, nestdV, fWedged, fQ, fKillDone, fExp, fRpc, tn, ghostV>>

\* Heartbeat received and acked at once: a late ack only moves the host's
\* deadline earlier, so the instant ack is the worst case for safety.  (The
\* ackAge machinery below is kept for a delayed-ack run: ACK_DELAY.)
Heartbeat(h) ==
  /\ up[h] /\ link[h] /\ conn[h] /\ ~fWedged[h] /\ (sinceRx[h] > 0 \/ sinceAck[h] > 0 \/ lapsed[h])
  /\ sinceRx' = [sinceRx EXCEPT ![h] = 0]
  /\ IF ACK_DELAY
     THEN ackAge' = [ackAge EXCEPT ![h] = 0] /\ UNCHANGED <<sinceAck, lapsed>>
     ELSE /\ sinceAck' = [sinceAck EXCEPT ![h] = 0] /\ lapsed' = [lapsed EXCEPT ![h] = FALSE]
          /\ UNCHANGED ackAge
  /\ UNCHANGED <<up, link, conn, brainV, nestdV, fStatus, fWedged, fQ, fRow, fKillDone, fExp, fRpc, ag, tn, ghostV>>

AckArrive(h) ==
  /\ up[h] /\ link[h] /\ conn[h] /\ ackAge[h] >= 0
  /\ sinceAck' = [sinceAck EXCEPT ![h] = Min(@, ackAge[h])]
  /\ lapsed' = [lapsed EXCEPT ![h] = IF ackAge[h] < F THEN FALSE ELSE @]
  /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  /\ UNCHANGED <<up, link, conn, brainV, nestdV, fleetV, ag, tn, ghostV>>

Tick ==
  /\ \A h \in Hosts : ~(up[h] /\ ~LeaseOK(h) /\ ~lapsed[h])
  /\ sinceAck' = [h \in Hosts |-> Min(F, sinceAck[h] + 1)]
  /\ ackAge' = [h \in Hosts |-> IF ackAge[h] < 0 THEN -1 ELSE Min(F, ackAge[h] + 1)]
  /\ sinceRx' = [h \in Hosts |-> Min(E, sinceRx[h] + 1)]
  /\ UNCHANGED <<up, link, conn, lapsed, brainV, nestdV, fStatus, fWedged, fQ, fRow, fKillDone, fExp, fRpc, ag, tn, ghostV>>

-----------------------------------------------------------------------------
(* FleetDO *)

EventDeliver(h) ==
  /\ up[h] /\ link[h] /\ conn[h] /\ hOut[h] # <<>>
  /\ LET ev == Head(hOut[h]) IN
     /\ hOut' = [hOut EXCEPT ![h] = Tail(@)]
     /\ IF ev.k = "exit"
        THEN /\ fRow' = [fRow EXCEPT ![h] = IF @ # 0 /\ @ <= ev.e THEN 0 ELSE @]
             /\ ag' = Exited(ag, h, ev.e, ev.r)
             /\ UNCHANGED fKillDone
        ELSE IF ev.k = "fail"
        THEN \* onCommandResult(error) for agent_start: its row goes (by cmd), and
             \* AgentDO.startFailed releases a record naming that start
             /\ fRow' = [fRow EXCEPT ![h] = IF @ = ev.e THEN 0 ELSE @]
             /\ ag' = IF RECORD /\ ag.bh = h /\ ag.be = ev.e THEN RRelease(ag) ELSE ag
             /\ UNCHANGED fKillDone
        ELSE /\ fKillDone' = [fKillDone EXCEPT ![h] = Max(@, ev.e)]
             /\ UNCHANGED <<fRow, ag>>
  /\ UNCHANGED <<hostV, brainV, nSet, nSt, nEpoch, kills, nIn, nOwed, fStatus, fWedged, sinceRx, fQ, fRpc, fExp, tn, ghostV>>

\* brainsLost on a transition to expired or dead.
\*  65bf6ef: the index row goes first, then onHostLost, whose failure is only
\*  logged (ALLOW_LOST).
\*  A2: the row stays; LostSend / LostDeliver deliver it, retried while the
\*  host is still expired or dead (dede063 hostAgentsLost).
BrainsLost(h) ==
  IF A2 THEN UNCHANGED <<fRow, ag, faults>>
  ELSE /\ fRow' = [fRow EXCEPT ![h] = 0]
       /\ \/ ag' = (IF fRow[h] > 0 THEN HostLost(ag, h, fRow[h]) ELSE ag) /\ UNCHANGED faults
          \/ ALLOW_LOST /\ CanFault /\ fRow[h] > 0 /\ ag' = ag /\ faults' = faults + 1

\* A2: the tick reads a lost host's row and calls onHostLost (an await).
\* (A6 here too: "lost" is expiry or proven death, never a drain's "dead".)
LostSend(h) ==
  /\ A2 /\ Lost(fStatus[h]) /\ fRow[h] > 0 /\ fRpc[h] = 0
  /\ A6 => (fStatus[h] = "expired" \/ ~up[h])
  /\ fRpc' = [fRpc EXCEPT ![h] = fRow[h]]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, fExp, ag, tn, ghostV>>

\* The call reaches AgentDO (whatever the host's status is by now).  Its answer
\* deletes the (agent, host) row, whatever start it now records; a lost answer
\* leaves the row, so the call is made again.
LostDeliver(h) ==
  /\ fRpc[h] > 0
  /\ ag' = HostLost(ag, h, fRpc[h])
  /\ fRpc' = [fRpc EXCEPT ![h] = 0]
  \* (with LOST_RECHECK a host no longer lost keeps its row: `hostGone` false)
  /\ \/ fRow' = [fRow EXCEPT ![h] = IF (A5 /\ @ # fRpc[h]) \/ (LOST_RECHECK /\ ~StillLost(h)) THEN @ ELSE 0]
        /\ UNCHANGED faults
     \/ ALLOW_LOST /\ CanFault /\ faults' = faults + 1 /\ UNCHANGED fRow
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fQ, fKillDone, fExp, tn, hBad, startAfterKill>>

\* The call fails before reaching AgentDO; the tick tries again.
LostDrop(h) ==
  /\ fRpc[h] > 0 /\ ALLOW_LOST /\ CanFault
  /\ fRpc' = [fRpc EXCEPT ![h] = 0] /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, fExp, ag, tn, hBad, startAfterKill>>

ExpireGuard(h) == fStatus[h] \in {"active", "draining"} /\ sinceRx[h] >= E /\ (FIX_H4 \/ fWedged[h])

\* The expiry's writes (from any status: the split commit writes "expired"
\* even for a host that is active again, as the code does).
ExpireWrite(h) ==
  /\ fExp' = [fExp EXCEPT ![h] = FALSE]
  /\ fStatus' = [fStatus EXCEPT ![h] = "expired"] /\ fWedged' = [fWedged EXCEPT ![h] = FALSE]
  /\ conn' = [conn EXCEPT ![h] = FALSE] /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  \* A3 (with A2): undelivered starts for an expired host are failed, never
  \* resent; a failed start's row goes and AgentDO hears it (startFailed).
  /\ IF A3 /\ A2
     THEN LET ds == DroppedEpochs(fQ[h]) IN
          /\ fRow' = [fRow EXCEPT ![h] = IF @ \in ds THEN 0 ELSE @]
          /\ ag' = IF RECORD /\ ag.bh = h /\ ag.be \in ds THEN RRelease(ag) ELSE ag
          /\ UNCHANGED faults
     ELSE BrainsLost(h)
  /\ fQ' = IF A3 THEN [fQ EXCEPT ![h] = SelectSeq(@, NotStart)] ELSE fQ
  /\ UNCHANGED <<up, link, sinceAck, lapsed, brainV, nestdV, sinceRx, fKillDone, fRpc, tn, hBad, startAfterKill>>

\* Atomic expiry (SPLIT_EXPIRE off).
Expire(h) == ~SPLIT_EXPIRE /\ ExpireGuard(h) /\ ExpireWrite(h)

\* N1 (6073da7 tick): the tick snapshots the silent hosts, then expires them
\* one by one across awaits; a host's hello can land in between.
ExpireRead(h) ==
  /\ SPLIT_EXPIRE /\ ExpireGuard(h) /\ ~fExp[h]
  /\ fExp' = [fExp EXCEPT ![h] = TRUE]
  /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, fRpc, ag, tn, ghostV>>

\* The write; EXPIRE_RECHECK re-reads the silence first and drops the
\* snapshot if the host spoke meanwhile.
ExpireCommit(h) ==
  /\ SPLIT_EXPIRE /\ fExp[h]
  /\ IF EXPIRE_RECHECK /\ ~ExpireGuard(h)
     THEN /\ fExp' = [fExp EXCEPT ![h] = FALSE]
          /\ UNCHANGED <<hostV, brainV, nestdV, fStatus, fWedged, sinceRx, fQ, fRow, fKillDone, fRpc, ag, tn, ghostV>>
     ELSE ExpireWrite(h)

\* STONITH confirmed by EC2 (or an operator): no fairness, as a silent host
\* without leases is never polled (H4).
ConfirmDead(h) ==
  /\ ~up[h] /\ fStatus[h] # "dead"
  /\ fStatus' = [fStatus EXCEPT ![h] = "dead"]
  /\ BrainsLost(h)
  /\ UNCHANGED <<hostV, brainV, nestdV, fWedged, sinceRx, fQ, fKillDone, fExp, fRpc, tn, hBad, startAfterKill>>

\* A spot notice: draining; AgentDO.onHostDraining asks for a start elsewhere.
Drain(h) ==
  /\ ALLOW_DRAIN /\ CanFault /\ up[h] /\ fStatus[h] = "active"
  /\ fStatus' = [fStatus EXCEPT ![h] = "draining"]
  /\ ag' = IF RECORD
           THEN (IF ag.bh = h THEN [ag EXCEPT !.intent = TRUE, !.avoid = h] ELSE ag)
           ELSE (IF ag.host = h THEN [ag EXCEPT !.drain = h] ELSE ag)
  /\ faults' = faults + 1
  /\ UNCHANGED <<hostV, brainV, nestdV, fWedged, sinceRx, fQ, fRow, fKillDone, fExp, fRpc, tn, hBad, startAfterKill>>

\* scaleDown: a draining burst host whose sandboxes all left is dead now
\* (FIX_DRAIN: only once it indexes no brain).
DrainRetire(h) ==
  /\ fStatus[h] = "draining" /\ (FIX_DRAIN => fRow[h] = 0)
  /\ fStatus' = [fStatus EXCEPT ![h] = "dead"]
  /\ conn' = [conn EXCEPT ![h] = FALSE] /\ ackAge' = [ackAge EXCEPT ![h] = -1]
  /\ BrainsLost(h)
  /\ UNCHANGED <<up, link, sinceAck, lapsed, brainV, nestdV, fWedged, sinceRx, fQ, fKillDone, fExp, fRpc, tn, hBad, startAfterKill>>

-----------------------------------------------------------------------------
TStep == TWakeDrop \/ TPendDrop \/ TDrainDrop \/ (\E h \in Hosts : TChoose(h))
         \/ TStatus \/ TKill \/ TKillAwait \/ TBump \/ TDeadline \/ TExitWait \/ TOpStop \/ TOpStart
RStep == RWake \/ (\E h \in Hosts : RStart(h)) \/ RKill \/ RKillFail \/ RDeadline \/ REscalate
         \/ RKillAlarm \/ RStatusRelease \/ ROpRestart \/ ROpRestartCondemn \/ ROpRestartDrop \/ ROldCap

Next ==
  \/ Enqueue \/ Pump \/ TurnDone
  \/ TStep \/ RStep
  \/ Issue \/ IssueFail \/ ResetAgentDO \/ SessDrop \/ ResolveResp \/ Tick
  \/ \E h \in Hosts :
       \/ Hello(h) \/ ResolveReq(h) \/ Deliver(h) \/ Exec(h) \/ Register(h)
       \/ StopExit(h) \/ IdleBegin(h) \/ BrainCrash(h) \/ LeaseLapse(h)
       \/ HostCrash(h) \/ Terminate(h) \/ Partition(h) \/ Heal(h)
       \/ HostHello(h) \/ Heartbeat(h) \/ AckArrive(h) \/ EventDeliver(h)
       \/ Expire(h) \/ ConfirmDead(h) \/ Drain(h) \/ DrainRetire(h)
       \/ LostSend(h) \/ LostDeliver(h) \/ LostDrop(h) \/ OwedExit(h)
       \/ ExpireRead(h) \/ ExpireCommit(h)

\* Progress is weakly fair; faults, operator actions, Enqueue and ConfirmDead are not.
Fairness ==
  /\ WF_vars(Pump) /\ WF_vars(TurnDone)
  /\ WF_vars(TWakeDrop) /\ WF_vars(TPendDrop) /\ WF_vars(TDrainDrop)
  /\ WF_vars(\E h \in Hosts : TChoose(h)) /\ WF_vars(TStatus) /\ WF_vars(TKill)
  /\ WF_vars(TKillAwait)
  /\ WF_vars(TBump) /\ WF_vars(TDeadline) /\ WF_vars(TExitWait)
  /\ WF_vars(RWake) /\ WF_vars(\E h \in Hosts : RStart(h)) /\ WF_vars(RKill)
  /\ WF_vars(RDeadline) /\ WF_vars(REscalate) /\ WF_vars(RKillAlarm) /\ WF_vars(RStatusRelease)
  /\ WF_vars(ROldCap)
  \* A pending restart resolves one way or the other: condemned, or refused (the code's bound on
  \* retryable failures, RESTART_MAX_FAILURES, gives up even when FleetDO never answers).
  /\ WF_vars(ROpRestartCondemn \/ ROpRestartDrop)
  /\ \A h \in Hosts : WF_vars(LostSend(h)) /\ WF_vars(LostDeliver(h))
  /\ WF_vars(Issue) /\ WF_vars(ResolveResp) /\ WF_vars(Tick)
  /\ \A h \in Hosts :
       /\ WF_vars(Hello(h)) /\ WF_vars(Deliver(h)) /\ WF_vars(Exec(h))
       /\ WF_vars(Register(h)) /\ WF_vars(StopExit(h)) /\ WF_vars(LeaseLapse(h))
       /\ WF_vars(Terminate(h)) /\ WF_vars(Heal(h)) /\ WF_vars(HostHello(h))
       /\ WF_vars(Heartbeat(h)) /\ WF_vars(AckArrive(h)) /\ WF_vars(EventDeliver(h))
       /\ WF_vars(Expire(h)) /\ WF_vars(DrainRetire(h)) /\ WF_vars(OwedExit(h))
       /\ WF_vars(ExpireRead(h)) /\ WF_vars(ExpireCommit(h))

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

TypeOK ==
  /\ ag.epoch \in 0..MaxEpoch
  /\ \A h \in Hosts : bTag[h] \in 0..MaxEpoch /\ kills[h] \in 0..MaxEpoch
                      /\ nSet[h] \subseteq 1..MaxEpoch

\* S, OneActingBrain: at most one brain process can have an action accepted -
\* on AgentDO (platform call, hands_resolve) or by the gateway (hands call with
\* a binding).  The runner keeps one process per agent per host, so hosts
\* name processes.
OneActingBrain == \A h1, h2 \in Hosts : (Acting(h1) /\ Acting(h2)) => h1 = h2

\* OneLiveBrain: never two live Claude Code processes of the agent.
OneLiveBrain == \A h1, h2 \in Hosts : (Alive(h1) /\ Alive(h2)) => h1 = h2

\* Rule 1 / H3: a brain AgentDO is killing never acts on AgentDO.
Condemned(h) ==
  IF RECORD THEN ag.ph = "condemned" /\ ag.bh = h /\ bTag[h] = ag.be
  ELSE ag.awaitH = h /\ bTag[h] = ag.awaitE
CondemnedFenced == \A h \in Hosts : ~(Condemned(h) /\ CanPlatform(h))

\* KillTombstone: no runner runs (registers or adopts) a start at or below a
\* kill that reached its host first.
KillTombstone == ~startAfterKill

\* H2 (65bf6ef): awaiting_exit names the assigned host at the current epoch.
AwaitConsistent == ~RECORD => (ag.awaitH # NoHost => (ag.awaitH = ag.host /\ ag.awaitE = ag.epoch))

\* L, part 3: a healthy host (never partitioned, crashed, or with a runner that
\* ignored a kill) is never wedged.
NoHealthyWedge == \A h \in Hosts : (fWedged[h] /\ h # OLD_HOST) => hBad[h]
\* (A previous-release host is wedged at the cap by design: excluded.)

\* Epochs never regress: AgentDO's counter, nestd's tombstone and latest start,
\* the runner's tombstone, and a running process's adopted epoch.
NoEpochRegression ==
  [][ /\ ag.epoch' >= ag.epoch
      /\ \A h \in Hosts :
           /\ kills'[h] >= kills[h] /\ rTomb'[h] >= rTomb[h]
           /\ (up'[h] => nEpoch'[h] >= nEpoch[h])
           /\ (bTag[h] > 0 /\ bTag'[h] > 0 /\ bBorn'[h] = bBorn[h]) => bTag'[h] >= bTag[h] ]_vars

\* L, parts 1-2: a queued turn eventually runs; the agent never wedges (a
\* condemned brain / awaiting_exit is eventually resolved).  Epoch exhaustion
\* is the model's bound, not a wedge.
TurnsDrain == Work ~> (~Work \/ ag.epoch = MaxEpoch)
\* A restart asked for only between turns never cuts a turn sent after it was asked (SPLIT_RESTART).
NoCutAfterAsk == ~tn.cut
NoWedge == (IF RECORD THEN ag.ph = "condemned" ELSE ag.awaitH # NoHost)
           ~> ((IF RECORD THEN ag.ph # "condemned" ELSE ag.awaitH = NoHost) \/ ag.epoch = MaxEpoch)

\* Liveness under a stable environment: a lease lapse with no fault behind it
\* (a host merely slow to heartbeat) is free in this model, so a behaviour can
\* lapse and expire hosts forever.  L is stated for behaviours where lapses
\* eventually stop (finitely many slow periods and faults).
LapseStep == \E h \in Hosts : ~lapsed[h] /\ lapsed'[h]
EventuallyStable == <>[][~LapseStep]_vars
StableTurnsDrain == EventuallyStable => TurnsDrain
StableNoWedge == EventuallyStable => NoWedge

Bounds == \A h \in Hosts : Len(fQ[h]) <= 3 /\ Len(nIn[h]) <= 3 /\ Len(hOut[h]) <= 4
\* The smaller bound used by the exhaustive runs.
SmallBounds == \A h \in Hosts : Len(fQ[h]) <= 2 /\ Len(nIn[h]) <= 2 /\ Len(hOut[h]) <= 3
\* For the epochs <= 3 sweep: SmallBounds, and never every host silent at
\* once (lapsed or expired) - excludes behaviours where no host can serve.
E3Bounds == SmallBounds /\ ~(\A h \in Hosts : lapsed[h] \/ fStatus[h] = "expired")
Perms == Permutations(Hosts)   \* symmetry, safety runs only
=============================================================================

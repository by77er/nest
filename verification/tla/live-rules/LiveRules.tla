------------------------------ MODULE LiveRules ------------------------------
(***************************************************************************)
(* Live capability rules (docs/control-plane/durable-objects/catalog/      *)
(* #live-rules): a capability's rules reach every live agent that reads    *)
(* them. One capability, whose rules are a version number; CatalogDO's     *)
(* watch, its nudge rows (agent -> rev), the `nudge` deadline row and the  *)
(* storage alarm; AgentDO's `rules` deadline and its read, split at its    *)
(* one await.                                                              *)
(*                                                                         *)
(* Action -> code (control-plane/src):                                     *)
(*   Write         do/catalog.ts putCapability / deleteCapability /        *)
(*                 deleteNamespace / a seed step, then nudgeWatchers: a    *)
(*                 row per watcher at a new rev, and armNudges (in one     *)
(*                 synchronous step)                                       *)
(*   AlarmStart    CatalogDO.alarm -> deliverNudges: the due rows sent     *)
(*   Take          AgentDO.rulesChanged: the `rules` deadline written,     *)
(*                 then the answer                                         *)
(*   AckArrive     deliverNudges: the answer; the row deleted if its rev   *)
(*                 is still the one sent (AckByRev)                        *)
(*   Lost          the RPC fails, before or after the agent took it: the   *)
(*                 row stays (attempts + 1), tried again                   *)
(*   AlarmEnd      deliverNudges' tail: the deadline again while rows wait *)
(*   ReadStart     AgentDO.refreshRules -> CatalogDO.watchRules: the watch *)
(*                 set and the rules read in one step; armNudges           *)
(*   ReadEnd       refreshRules after its await: the rules stored and      *)
(*                 pushed (rulesChanged)                                   *)
(*   Reset         AgentDO evicted mid-read: the deadline row was not      *)
(*                 deleted, so the read runs again                         *)
(*   LoseWatch     a watch row lost (a write the catalog made without it)  *)
(*   Hourly        AgentDO's `prune` arms the read hourly                  *)
(*   Rollback, OldWrite, OldAlarm, OldDropDue, RollForward  a `wrangler   *)
(*                 rollback` to the release before, of both DOs: CatalogDO *)
(*                 has no alarm handler (its run consumes the storage      *)
(*                 alarm, the deadline row stays), writes without nudges   *)
(*                 and has no watchRules; AgentDO (AgentRollback) has no   *)
(*                 `rules` handler (its alarm drops the deadline) and no   *)
(*                 rulesChanged; then forward again (the constructor's     *)
(*                 armNudges)                                              *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Agents,
  MaxWrites,      \* capability writes, at most
  MaxLost, MaxReset, MaxLoseWatch, MaxRollback,
  \* ---- switches: the code as built is TRUE ----
  AckByRev,       \* the answer deletes the row only at the rev sent. FALSE (mutation): whatever its rev
  RearmAlarm,     \* armNudges sets the storage alarm when none is (and the constructor calls it). FALSE: before review finding 1
  Hourly,         \* the agent's hourly read (FALSE: convergence by nudges alone)
  AgentRollback,  \* a rollback covers AgentDO too (FALSE: CatalogDO alone, to isolate its own faults)
  OldWrites       \* the rolled-back release may write the capability (it nudges nobody)

VARIABLES
  cap,       \* the capability's rules: the version last written
  rev,       \* CatalogDO's rules_rev
  watch,     \* rule_watch: the agents it nudges
  nudge,     \* rule_nudges: agent -> rev (0: no row)
  dl,        \* the `nudge` deadline row exists
  alarm,     \* the storage alarm is set
  running,   \* an alarm run (deliverNudges) is between its sends and its tail
  inflight,  \* rulesChanged RPCs out: <<agent, rev, "sent" | "taken">>
  old,       \* CatalogDO runs the previous release
  rules,     \* AgentDO: the version its rules (and its runner's cache) hold
  due,       \* AgentDO: its `rules` deadline is armed
  reading,   \* AgentDO: the version its read returned, its await not yet over (Idle: none)
  lost, resets, lostWatch, rollbacks

vars == <<cap, rev, watch, nudge, dl, alarm, running, inflight, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

Pending == {a \in Agents : nudge[a] > 0}
Idle == MaxWrites + 1

TypeOK ==
  /\ cap \in 0..MaxWrites /\ rev \in Nat /\ watch \subseteq Agents
  /\ nudge \in [Agents -> Nat] /\ dl \in BOOLEAN /\ alarm \in BOOLEAN /\ running \in BOOLEAN
  /\ inflight \subseteq (Agents \X Nat \X {"sent", "taken"}) /\ old \in BOOLEAN
  /\ rules \in [Agents -> 0..MaxWrites] /\ due \in [Agents -> BOOLEAN] /\ reading \in [Agents -> 0..(MaxWrites + 1)]

Init ==
  /\ cap = 0 /\ rev = 0 /\ watch = Agents /\ nudge = [a \in Agents |-> 0]
  /\ dl = FALSE /\ alarm = FALSE /\ running = FALSE /\ inflight = {} /\ old = FALSE
  /\ rules = [a \in Agents |-> 0] /\ due = [a \in Agents |-> FALSE] /\ reading = [a \in Agents |-> Idle]
  /\ lost = 0 /\ resets = 0 /\ lostWatch = 0 /\ rollbacks = 0

\* armNudges: the deadline row (Deadlines.set with keepEarlier returns early, before reschedule, when one
\* is armed), and with RearmAlarm the storage alarm whenever none is set.
Arm(pending) ==
  /\ dl' = (dl \/ pending)
  /\ alarm' = IF pending /\ (RearmAlarm \/ ~dl) THEN TRUE ELSE alarm

Write ==
  /\ ~old /\ cap < MaxWrites
  /\ cap' = cap + 1 /\ rev' = rev + 1
  /\ nudge' = [a \in Agents |-> IF a \in watch THEN rev + 1 ELSE nudge[a]]
  /\ Arm(watch # {})
  /\ UNCHANGED <<watch, running, inflight, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

AlarmStart ==
  /\ ~old /\ alarm /\ ~running
  /\ alarm' = FALSE /\ running' = TRUE /\ dl' = FALSE
  /\ inflight' = {<<a, nudge[a], "sent">> : a \in Pending}
  /\ UNCHANGED <<cap, rev, watch, nudge, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

Take(a, r) ==
  /\ ~(old /\ AgentRollback)
  /\ <<a, r, "sent">> \in inflight
  /\ inflight' = (inflight \ {<<a, r, "sent">>}) \cup {<<a, r, "taken">>}
  /\ due' = [due EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, old, rules, reading, lost, resets, lostWatch, rollbacks>>

AckArrive(a, r) ==
  /\ <<a, r, "taken">> \in inflight
  /\ inflight' = inflight \ {<<a, r, "taken">>}
  /\ nudge' = [nudge EXCEPT ![a] = IF ~AckByRev \/ nudge[a] = r THEN 0 ELSE nudge[a]]
  /\ UNCHANGED <<cap, rev, watch, dl, alarm, running, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

Lost(a, r, s) ==
  /\ lost < MaxLost /\ <<a, r, s>> \in inflight
  /\ inflight' = inflight \ {<<a, r, s>>} /\ lost' = lost + 1
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, old, rules, due, reading, resets, lostWatch, rollbacks>>

AlarmEnd ==
  /\ running /\ inflight = {}
  /\ running' = FALSE
  /\ IF Pending # {} THEN dl' = TRUE /\ alarm' = TRUE ELSE UNCHANGED <<dl, alarm>>
  /\ UNCHANGED <<cap, rev, watch, nudge, inflight, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

ReadStart(a) ==
  /\ ~old /\ due[a] /\ reading[a] = Idle
  /\ due' = [due EXCEPT ![a] = FALSE]
  /\ reading' = [reading EXCEPT ![a] = cap]
  /\ watch' = watch \cup {a}
  /\ Arm(Pending # {})
  /\ UNCHANGED <<cap, rev, nudge, running, inflight, old, rules, lost, resets, lostWatch, rollbacks>>

ReadEnd(a) ==
  /\ reading[a] # Idle
  /\ rules' = [rules EXCEPT ![a] = reading[a]]
  /\ reading' = [reading EXCEPT ![a] = Idle]
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, inflight, old, due, lost, resets, lostWatch, rollbacks>>

Reset(a) ==
  /\ resets < MaxReset /\ reading[a] # Idle
  /\ reading' = [reading EXCEPT ![a] = Idle] /\ due' = [due EXCEPT ![a] = TRUE] /\ resets' = resets + 1
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, inflight, old, rules, lost, lostWatch, rollbacks>>

LoseWatch(a) ==
  /\ lostWatch < MaxLoseWatch /\ a \in watch
  /\ watch' = watch \ {a} /\ lostWatch' = lostWatch + 1
  /\ UNCHANGED <<cap, rev, nudge, dl, alarm, running, inflight, old, rules, due, reading, lost, resets, rollbacks>>

HourlyRead(a) ==
  /\ Hourly /\ ~due[a]
  /\ due' = [due EXCEPT ![a] = TRUE]
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, inflight, old, rules, reading, lost, resets, lostWatch, rollbacks>>

Rollback ==
  /\ ~old /\ ~running /\ rollbacks < MaxRollback
  /\ old' = TRUE /\ rollbacks' = rollbacks + 1
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, inflight, rules, due, reading, lost, resets, lostWatch>>

OldWrite ==
  /\ old /\ OldWrites /\ cap < MaxWrites
  /\ cap' = cap + 1
  /\ UNCHANGED <<rev, watch, nudge, dl, alarm, running, inflight, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

OldAlarm ==
  /\ old /\ alarm
  /\ alarm' = FALSE
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, running, inflight, old, rules, due, reading, lost, resets, lostWatch, rollbacks>>

\* The previous AgentDO's alarm finds no handler for `rules` and drops the deadline.
OldDropDue(a) ==
  /\ old /\ AgentRollback /\ due[a]
  /\ due' = [due EXCEPT ![a] = FALSE]
  /\ UNCHANGED <<cap, rev, watch, nudge, dl, alarm, running, inflight, old, rules, reading, lost, resets, lostWatch, rollbacks>>

RollForward ==
  /\ old
  /\ old' = FALSE
  /\ IF RearmAlarm /\ Pending # {} THEN dl' = TRUE /\ alarm' = TRUE ELSE UNCHANGED <<dl, alarm>>
  /\ UNCHANGED <<cap, rev, watch, nudge, running, inflight, rules, due, reading, lost, resets, lostWatch, rollbacks>>

Next ==
  \/ Write \/ AlarmStart \/ AlarmEnd \/ Rollback \/ OldWrite \/ OldAlarm \/ RollForward
  \/ \E a \in Agents : ReadStart(a) \/ ReadEnd(a) \/ Reset(a) \/ LoseWatch(a) \/ HourlyRead(a) \/ OldDropDue(a)
  \/ \E e \in inflight : Take(e[1], e[2]) \/ AckArrive(e[1], e[2]) \/ Lost(e[1], e[2], e[3])

\* Eventual delivery: alarms fire, RPCs are answered, reads finish, a rollback is rolled forward, and
\* (with Hourly) the hourly read comes. Faults are bounded, so they stop.
Fairness ==
  /\ WF_vars(AlarmStart) /\ WF_vars(AlarmEnd) /\ WF_vars(RollForward)
  /\ \A a \in Agents : WF_vars(ReadStart(a)) /\ WF_vars(ReadEnd(a)) /\ WF_vars(HourlyRead(a))
  /\ \A a \in Agents, r \in 0..(MaxWrites + 1) : WF_vars(Take(a, r)) /\ WF_vars(AckArrive(a, r))

Spec == Init /\ [][Next]_vars /\ Fairness

\* Every live watcher's rules end at the capability's latest write, and stay there.
Converges == <>[](\A a \in Agents : rules[a] = cap)

\* The rev bound keeps the state space finite: one rev per write.
RevBound == rev <= MaxWrites
=============================================================================

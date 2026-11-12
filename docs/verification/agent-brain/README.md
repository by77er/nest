# Agent and brain lifecycle: inventory for modelling

The agent/brain lifecycle, the one-brain rule and the turn queue, across AgentDO, FleetDO, nestd, the runner and SandboxDO, as state machines ready to model. Two versions:

- **main** (`edf6829`): as built. Cited as `path:line`.
- **AE**: `origin/deferred/agent-epoch` at `65bf6ef`, the redesign in flux. Cited as `AE:path:line` (`git show origin/deferred/agent-epoch:<path>`). Earlier AE commits are cited by hash.

> **Status:** both versions are superseded by the single-record design (#30, brain hosts in #36), written against the findings below: [design/](design/). The model of it as built is in [pilot/](pilot/) and its check against the code in [conformance/](conformance/); whether an item below still applies is answered there, not here. The turn queue (§2.4) cites today's code (re-dated 2026-11-06 at `9fd147ff`: `dropped` added, #82; re-checked 2026-11-12 at `43e0dd6`: Q2's restart guard, Q8). Since `edf6829`, §2.1's machine also has `hostReport` making a detached brain on its recorded host `ready`, and `load()` migrating a previous release's record (a detached or errored brain with a host becomes `condemned`); both are in the conformance's [2026-11-06 section](conformance/#main-9fd147ff-re-dated-2026-11-06).

The intended rule (owner): *AgentDO starts a brain at agent epoch N+1 on another host only once the previous brain is confirmed gone (its `agent_exited` with epoch >= N, or its host dead/expired; the host lease self-fences brains at 20 s, the DO expires the host at 30 s); kills carry an epoch tombstone, so a queued start at or below a killed epoch is refused.*

`65bf6ef` has no gateway floors (`client_floor`, `floor_applied`, per-client floors, the `agent_epoch` binding claim) and no host capabilities: one brain per agent rests on the AgentDO rule alone. Floors appear only as S6 and in §7.

Paths: `agent.ts`, `fleet.ts` and `sandbox.ts` are under `control-plane/src/do/`. `runner_link.rs` and `host.rs` are under `crates/nestd/src/`. `agent.rs`, `supervisor.rs`, `runtime.rs` and `session.rs` are under `crates/nest-runner/src/`.

## 1. Actors and state

| Actor | State held (persistent unless marked volatile) | Code |
|---|---|---|
| **AgentDO** (one per agent) | `state` ∈ {detached, starting, ready, idle, working, compacting, waiting_permission, waiting_input, quota_parked, errored}; `host`; `runner_instance` (the session lineage); `current_turn`; `start_attempts`; `exit_restarts`; session sockets (attachment: host, epoch, helloed, stale, instance); `turns` rows; `tool_calls` keyed by (epoch, call). Volatile: `waking` (and on AE, `inflightStart`). **main:** the session epoch is `hands.epoch`, a copy of the sandbox epoch (0 for captains). **AE adds:** `agent_epoch` (a counter that only grows), `stop_requested`, `awaiting_exit {host, epoch, since_ms}` (in effect the AgentDO-side kill record), `pending_start`, `told_sandbox_epoch` | `agent.ts:85-131,171`; AE:`agent.ts:99,136-148,202-204` |
| **FleetDO** (one per cell) | `hosts.status` ∈ {active, draining, stonith_pending, expired, dead}, `last_rx`; `host_agents` (the brain index); `commands` (one result each); a per-host reliable channel; a per-host `SerialQueue` for hello and events. **main:** `host_agents(agent PK, host, cmd)`. **AE:** `host_agents((agent, host) PK, cmd, epoch)` and `hosts.wedged_ms` | `fleet.ts:194`; AE:`fleet.ts:933-952,214-216` |
| **nestd** (per host) | Runner link brain table: agent → {state, sent: Pending or On{conn, started}, fenced}; lease deadline = send instant of the last acked heartbeat + `host_fence_ms` (monotonic and boottime). **AE adds:** `epochs[agent]` (the latest start's epoch) and `killed[agent]` (the tombstone: the highest killed epoch, kept for the process's life) | `runner_link.rs:53-80`; `nestd/src/fleet.rs:374-379`; AE:`runner_link.rs:76-81` |
| **Runner** (per host) | Registry agent → Agent{epoch, pid, cancel, kill_reason, (AE) stopping}; a wall-clock lease mirror `valid_until_ms`; `conn_gen`. One Session per brain start, with a fresh `instance_id` | `runtime.rs:49,111,262-312`; `session.rs:409` |
| **SandboxDO** | `attached`, `attach_pending`, `working`, epoch, host. Mints bindings (sandbox epoch, client = agent, 1 h) | `sandbox.ts:720-897`; `protocol/gateway.ts:13` |
| **Gateway** | main and AE head: verifies the binding's sandbox epoch only. `0c3a85c` only: a per-(sandbox, client) floor | `0c3a85c` |

## 2. State machines

### 2.1 The agent/brain machine (AgentDO)

| # | Transition | Guard | Effect | Code |
|---|---|---|---|---|
| A1 | wake | `state ∈ {detached, errored}` ∧ no current socket ∧ (current_turn ∨ a queued turn) ∧ ¬waking ∧ (¬afterExit ∨ exit_restarts < 3) | `start_attempts:=0`; afterExit ⇒ `exit_restarts++`; start(); a retryable failure re-arms `wake` in 30 s. Hitting the guard sets `errored` | `agent.ts:495-526`; AE:`agent.ts:681-713` |
| A2 | start (accepted) | main: always. AE: single-flight; `prev.host ∈ {⊥, h}` or prev host dead/expired | main: `hands.epoch:=SandboxDO.epoch`, `host:=h`, `state:=starting`, a `starting` deadline in 120 s, `agent_start` to h. AE: also `agent_epoch++` and clears `stop_requested` and `pending_start` | `agent.ts:367-430`; AE:`agent.ts:417-512` |
| A2s | start (no-op, AE) | live socket ∧ `host = h` ∧ `stop_requested ≠ agent_epoch` | returns `cmd: null` | AE:`agent.ts:463` |
| A3 | start elsewhere (AE) | `prev.host ∉ {⊥, h}` ∧ prev host not dead/expired | fence all sessions; once per epoch, `agent_stop{kill, epoch: agent_epoch}` to prev.host; `awaiting_exit:=(prev.host, agent_epoch)`; `pending_start:=args`; `exit_wait` in 60 s. **main has no counterpart:** `start(hostHint)` sends no stop | AE:`agent.ts:468-478,529-542` |
| A4 | hello | fetch: `host = info.host` ∧ host active/draining. main: `epoch = hands.epoch`; AE: `epoch = agent_epoch` | otherwise the socket is stale (orphan branch only). Supersedes other sockets; `runner_instance:=instance`; starting, detached or errored become ready; clears the `starting` deadline; a new lineage means recovery (Q4) | `agent.ts:605-623,730-798`; AE:`agent.ts:951-1022` |
| A5 | onExited(h, reason, e) | `host = h`. AE: `e = ⊥ ∨ e >= agent_epoch` | `state:=detached`. AE: e ≠ ⊥ ⇒ `host:=⊥`; if awaiting_exit, brainGone (clear it; `pending_start` alarm now) and stop. Otherwise `RESTART_ON_EXIT[reason]` ⇒ wake(reason ≠ idle) | `agent.ts:457-468,51-53`; AE:`agent.ts:631-647` |
| A6 | onHostLost(h) | `host = h` | `host:=⊥`, `state:=detached`. AE: if awaiting_exit, brainGone and stop. Close h's sockets; wake(true) | `agent.ts:474-488`; AE:`agent.ts:655-672` |
| A7 | starting deadline (120 s) | `state = starting` ∧ no socket | `errored`; wake(true) | `agent.ts:1530-1539` |
| A8 | startFailed(h, err) | `host = h` | retryable ∧ attempts < 3 ⇒ attempts++, `restart` in 5 s (which runs start() if still starting with no socket); otherwise `errored` | `agent.ts:438-455,1520-1529` |
| A9 | exit_wait (AE, 60 s) | awaiting_exit ≠ ⊥ (**no check that it is still relevant**) | `FleetDO.hostWedged(awaiting_exit.host)` | AE:`agent.ts:1779-1783` |
| A10 | pending_start alarm (AE) | pending_start ∧ ¬awaiting_exit | start(pending args) | AE:`agent.ts:1784-1796` |
| A11 | stop(reason) | host ≠ ⊥ | AE: `stop_requested:=agent_epoch` *before* the await; `agent_stop{graceful, epoch}`. main: just sends `agent_stop` | `agent.ts:432-435`; AE:`agent.ts:556-571` |
| A12 | onSandboxMoved(s, e, h) | bound to s | **main:** `hands.epoch:=e`, `host:=⊥`, all sockets stale and closed, then `start(h)` **inline**. **AE:** record the move, a mid-turn inbox note, `wake` alarm now; never starts inline | `agent.ts:537-561`; AE:`agent.ts:728-749` |
| A13 | onHostDraining(h) (AE) | `host = h` | start(avoid = h) (so A3); a 409 retries in 5 s | AE:`agent.ts:592-605` |
| A14 | hostReport(h, s) | `host = h` ∧ detached | `state:=s` (a reconnecting host still runs it) | `agent.ts:529-534` |

### 2.2 FleetDO and the brain index

| # | Transition | Guard | Effect | Code |
|---|---|---|---|---|
| F1 | issueCommands(agent_start) | — | upsert the index row. main: keyed by agent (overwrites host). AE: keyed by (agent, host) and records the epoch | `fleet.ts:1164-1167`; AE:`fleet.ts:1216-1219` |
| F2 | event `agent_exited` | in order, per host | main: delete row; `onExited(h, reason)`. AE: `e := ev.epoch ?? row.epoch`; delete rows with epoch <= e; `onExited(h, reason, e)` | `fleet.ts:1044-1046`; AE:`fleet.ts:1093-1100` |
| F3 | `agent_stop` result ok | — | main: **deletes the row**. AE: nothing | `fleet.ts:1123-1125` |
| F4 | `agent_start` result error | — | delete the row by cmd; `startFailed` | `fleet.ts:1131-1135` |
| F5 | hello: reconcileAgents | — | reported ⇒ hostReport. Unreported, with its start completed ⇒ delete row, `onExited(h, host_lost[, row epoch])` (errors logged) | `fleet.ts:915-939` |
| F6 | tick: host silent | `now − last_rx >= 30 s`, status active/draining | live leases ⇒ expireHost (stonith_pending; brains wait for F7). Else controller (AE: or wedged) ⇒ `expired`, brainsLost. **Else nothing** | `fleet.ts:1304-1311`; AE:`fleet.ts:1380-1385` |
| F7 | confirmHostDead (EC2 or operator) | — | `dead`; reassign leases; AE: brainsLost | `fleet.ts:1833-1842`; AE:`fleet.ts:1933-1944` |
| F8 | brainsLost(h) | — | **delete all of h's rows, then** `onHostLost` for each (errors logged only) | `fleet.ts:1773-1784`; AE:`fleet.ts:1875-1885` |
| F9 | hostWedged(h) (AE) | h active/draining | `wedged_ms`; heartbeats get no ack and no `last_rx`; hellos are closed (4408) | AE:`fleet.ts:1341-1347,991,750-753` |
| F10 | drain / drained (AE) | spot notice / no leases left | drain: `onHostDraining` per row in the background. drained: **`dead` + brainsLost, with no `host_agents` check** | AE:`fleet.ts:1630-1641,1590-1599` |

### 2.3 Host side: nestd and the runner

| # | Transition | Guard | Effect | Code |
|---|---|---|---|---|
| N1 | batch arrives: `agent_stop{kill, e}` (AE) | on arrival, ahead of the in-order queue | `killed[a]:=max(killed[a], e)`. If a sent, unfenced brain at <= e is in the table, send AgentStop{kill} to the runner (it reports the exit); otherwise nestd reports `agent_exited{stopped, e}` itself | AE:`host.rs:804-811`; AE:`runner_link.rs:206-240` |
| N2 | in order: `agent_start{e}` | AE: refuses if `killed[a] >= e` (`agent_exited{fenced, e}` + `stale_epoch`) | table row Starting, Sent On or Pending; `epochs[a]:=e`; **result ok{dispatched} at once** (not on start) | `host.rs:1916-1922`; AE:`host.rs:1924-1935` |
| N3 | in order: `agent_stop` graceful | — | AgentStop{graceful} to the runner; with no runner connected, the row is removed | `host.rs:1388-1391`; `runner_link.rs:153-163` |
| N4 | runner: AgentStart | spawned task | no lease ⇒ exit fenced. register: ok ⇒ run; an older-connection brain ⇒ kill and retry for up to 10 s; AE: a stopping brain ⇒ kill and retry for up to 10 s; **else adopt** (main: set_hands; AE: set_hands + `adopt_epoch` = fetch_max) | `agent.rs:72-145`; AE:`agent.rs:110-136`; AE:`runtime.rs:389-396` |
| N5 | runner: AgentStop | **registered only** (otherwise a no-op) | kill, or graceful (close stdin; once no turn runs, the process group is killed if it hasn't exited within the exit grace, 30 s); AE sets `stopping` | `supervisor.rs:91-104`; AE:`supervisor.rs:94` |
| N6 | lease lapse / nestd lost | nestd watchdog at the deadline; runner watchdog `now_ms() > valid_until`; nestd socket EOF | runner kill_all (SIGKILL to the process group). nestd reports each brain of the lost connection as exited (crashed or fenced) | `host.rs:1055-1094`; `supervisor.rs:16-29,119-140`; `runner_link.rs:295-300` |
| N7 | brain process exits | pid matches | `agent_exited{reason}` (AE: `epoch`), deregister | `agent.rs:779-808` |
| N8 | idle | 120 s after turn end, no pending inbox | close stdin, then exit `idle` (killed if it hasn't exited within the exit grace, 30 s; respawned in place if input was stashed) | `agent.rs:656-664,779-797`; `config.rs:55` |

### 2.4 A turn's life (AgentDO `turns.status`)

| # | Transition | Guard | Effect | Code |
|---|---|---|---|---|
| Q1 | enqueue | agent exists; a `request_id` seen before returns the same turn | `queued` (ord = max+1); pump; wake | `AgentDO.enqueueTurn`, `TurnQueue.enqueue` (lib/turns.ts) |
| Q2 | pump | current socket ∧ `current_turn = ⊥` ∧ no restart pending (`intent.reason ≠ restart`, the model's `PUMP_GUARD`) | the oldest queued turn becomes `active`, `current_turn:=t`, `run_turn` pushed reliably (resent after a same-lineage reconnect), only if `t` is still current after the push's awaits (a Q4 meanwhile made R current) | `AgentDO.pump`, `TurnQueue.claimNext` |
| Q3 | complete | event from the current lineage, `ev.epoch` = session epoch, `ev.turn = current_turn`, not seen before | `done`; `current_turn:=⊥`; `exit_restarts:=0`; mirrored inbox messages never confirmed come back as one queued turn (Q1's effect, placed by the first message's arrival among the queued turns; at the front if one interrupted); pump. An event stamped with another turn changes no state (a finished turn's trailing `idle`) | `AgentDO.applyEvent`, `TurnQueue.complete` |
| Q4 | recover | a hello from a new lineage while `current_turn = X` | X becomes `interrupted`; a new `recovery` turn R (with X's original text) is queued at the front. The channel is reset, so `run_turn X` is never resent. All in the hello's step that clears `current_turn`; whether the sandbox moved during X is decided when R starts (Q2, `moveNoteDue`) | `AgentDO.onHello`, `TurnQueue.recover` |
| Q5 | undeliverable | runner stdin closed (stopping) | an error event; the turn stays `active` until Q4 | `Actor::handle` (nest-runner `agent.rs`) |
| Q6 | crash guard | 3 exit-restarts without a Q3 | `errored`; each new input gets exactly one more start (the counter isn't reset) | `AgentDO.wake`; lib/brain.ts `wakeDecision`, `RESTART_ON_EXIT`, `MAX_EXIT_RESTARTS` |
| Q7 | drop | the agent ends for good (#82) | every `queued` turn, and the `active` one if no brain is left to recover it, becomes `dropped`, with their mirrored messages; nothing is enqueued after (`ended`) | `AgentDO.endAgent`, `AgentDO.release`, `TurnQueue.dropAll` (lib/turns.ts) |
| Q8 | abandon | the hourly prune: an `active` turn that isn't `current_turn` and started more than 7 days ago | `interrupted`, with no successor; its mirrored messages never confirmed come back as one queued turn | `AgentDO.prune`, `TurnQueue.prune` |

There is no `failed` status: a turn ends as `done`, as `interrupted` (with a successor by Q4, or abandoned by Q8), or as `dropped` when its agent ended. `instance_id` is per brain session (a fresh `rin_` id per `Session`, nest-runner `session.rs`), so every brain start is a new lineage.

## 3. Messages and delivery

- **DO RPC:** an await opens the input gate. Input gates close only while storage operations are in flight; an outgoing request leaves them open, so other calls, including calls back into the waiting object, interleave ([Cloudflare blog](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/); that RPC behaves like fetch here is unverified). The runtime does not deadlock on a cycle; application-level waits can (L3). Code avoids stale copies with `update()` (`agent.ts:233`).
- **Lost answers:** an RPC that throws may still have taken effect. main sets `detached` after a failed `issueCommands` that may have queued the start (`agent.ts:421-427`); AE's tombstone covers the case where a later start goes elsewhere.
- **Dropped on failure:** F5 and F8 delete rows before the AgentDO call and only log (`fleet.ts:932-937,1777-1782`). main's move notices are log-only (`sandbox.ts:481-490`); AE retries them from an alarm.
- **DO reset:** volatile `waking`/`inflightStart` are lost. A reset between `update(state=starting)` and `deadlines.set("starting")` (`agent.ts:412-417`) leaves `starting` with no deadline (unverified as reachable).
- **Fleet channel:** reliable, ordered, one result per command (nestd caches results, `host.rs:1328-1347`). A new nestd process resets the lineage and fails pending commands (`fleet.ts:785-791`). Commands run in order; `fence` and AE's `agent_stop{kill}` are also applied **on arrival**.
- **Session WebSocket:** per brain session, hello first. Seq'd and acked both ways, processed in order (`SerialQueue`, `agent.ts:663`). The runner reconnects with backoff from 100 ms to 5 s (`session.rs:104-127`). **AgentDO ignores closes** (`agent.ts:693-699`).
- **nestd↔runner:** a unix socket, in order. Runner events from an earlier connection are dropped (`supervisor.rs:41-48`); nestd drops an early `agent_exited{fenced}` (`runner_link.rs:307-330`).

## 4. Timing assumptions

| Constant | Value | Code |
|---|---|---|
| heartbeat / host self-fence / CP expiry | 5 s / 20 s after the **send** of the last acked heartbeat / 30 s after `last_rx` | `nest-protocol/src/control.rs:23-27,1087`; `nestd/src/fleet.rs:374` |
| starting deadline; `MATERIALIZE_TIMEOUT` | 120 s; 120 s (equal: a slow resume can outlive the deadline) | `agent.ts:38`; `agent.rs:60` |
| start retry; wake retry; exit_wait (AE) | 5 s (3 tries); 30 s; 60 s | `agent.ts:32-44`; AE:`agent.ts:179` |
| runner DYING_WAIT; idle exit; SETTLE | 10 s; 120 s; 10 s | `agent.rs:64-69`; `config.rs:55` |
| binding lifetime | 1 h | `protocol/gateway.ts:13` |

Derived: fence instant <= send + 20 s <= `last_rx` + 20 s < `last_rx` + 30 s <= expiry. This holds for a wedged host too: F9 stops acks and `last_rx` together. It assumes:

- (T1) clock rate drift is negligible over 30 s;
- (T2) a watchdog actually runs. nestd's is monotonic; the runner's mirror is **wall clock** and is the only one left if nestd is wedged;
- (T3) SIGKILL takes effect promptly;
- (T4) the runner isn't wedged. Nothing outside it kills Claude Code; systemd's cgroup kill applies only when the unit stops (`deploy/host/install.sh:136`, unverified);
- (T5) an operator's `confirmHostDead` is true.

A late tick only delays expiry, which is safe.

## 5. Safety properties

Notation: `B(a)` is the set of live brain processes of agent a, each tagged (host, epoch). `acc(b, t)` means a platform call or hands call of brain b is *accepted* at time t (AgentDO `dispatch` runs, or the gateway forwards a call).

- **S1 (one acting brain):** ∀a, t: |{b ∈ B(a) : acc(b, t)}| <= 1. Stronger form: for any two accepted calls of different brains, every acceptance of the older brain precedes every acceptance of the newer one. **S1-hands caveat:** a hands call accepted before a kill keeps running in the guest until the gateway sees the hang-up (`docs/agents/hands/README.md:20-21`); define acceptance, not completion.
- **S1w (one live brain):** ∀a, t: |B(a)| <= 1, except within the windows of T2-T4 (kill latency, 20 s self-fence on a partitioned host). On AE this holds only for different hosts. On one host, the runner serializes (N4) with up to 10 s of overlap before it adopts.
- **S2 (no epoch regression):**
  - AgentDO: `agent_epoch` only increases (AE:`agent.ts:485`); a session, event or tool call is accepted only at `= agent_epoch` (AE:`agent.ts:946-949,964`); an exit with epoch < `agent_epoch` is ignored (AE:`agent.ts:635`).
  - nestd: `killed` only increases (AE:`runner_link.rs:208-213`).
  - runner: `adopt_epoch` is fetch_max (AE:`runtime.rs:390`).
  - main: vacuous (the epoch is the sandbox's; fencing is by `runner_instance`).
- **S3 (the intended rule):** AgentDO issues `agent_start(a, N+1)` to h' ≠ h_N only if, earlier, AgentDO received `agent_exited(a, h_N, e >= N)` from a host-side observation that the process is gone, or h_N reached `expired` by F6 or `dead` by F7. F10's `dead` is not enough (A-1).
- **S4 (tombstone):** no brain process ever registers in a runner with epoch <= `killed[a]` after the kill arrived at that host. AE guarantees this only at nestd's in-order dispatch (AE:`host.rs:1927`), not in the runner (A-2).
- **S5 (turn delivery):** a turn id is sent (`run_turn`) to at most one lineage, and completes at most once; the turn's *work* is at-least-once (Q4 re-runs it as R under a new id and new call ids, so platform side effects are idempotent only within an epoch: `(agent, epoch, call)`, `agent.ts:1196-1240`). Hands outcomes in flight are meant to come from `call_status` at start (not built: `docs/agents/runner/README.md:42`). Under S1, at most one brain works on X or its recovery at a time.
- **S6 (history, `0c3a85c` only):** a binding with `agent_epoch = N+1` is minted only after the sandbox's gateway confirmed floor >= N+1 for that client. Removed in `65bf6ef`.
- **S7 (index soundness, AE):** if AgentDO has `host = h` and the brain may be live, then `host_agents(a, h)` exists until F2 (epoch >= row) or F8 for h. Main breaks it with F3.

## 6. Liveness properties

Fairness assumed: every enabled alarm eventually fires; DO RPCs eventually succeed when retried; some active connected host eventually exists; each turn has finitely many brain crashes, or new input keeps arriving (Q6).

- **L1:** every queued turn is eventually `done`, or the agent is `errored` with no new input. Fails on main and AE through stuck non-wake states: the agent's state is ∉ {detached, errored} with no brain and no socket, and nothing moves it (closes are ignored, the starting deadline covers only `starting`). Paths: F3 (main), F8/F5 drop-on-failure (both), A-4 and A-5 (AE).
- **L2:** a brain on a host that died is eventually restarted elsewhere. This needs F6/F7 to fire for the host *and* its index row to survive to F8. F6 never fires for a silent `sandbox`-role host with no live lease that isn't wedged (`fleet.ts:1307-1311`), and the idle-retire scale-down won't retire it while it has a row (AE:`fleet.ts:1575`).
- **L3:** no deadlock between AgentDO, SandboxDO and FleetDO. Cycles, by version:

| Version | Cycle | Result |
|---|---|---|
| main | AgentDO.start → SandboxDO.wake → placeCurrentEpoch → notifyAgentsMoved (inline) → AgentDO.onSandboxMoved → start(h) → SandboxDO.wake (re-entrant; returns h) | No deadlock (no single-flight), but **two `agent_start`s** (M-4) |
| `0c3a85c` | single-flight start → SandboxDO.wake → place → inline notify → onSandboxMoved → wake() → start() joins `inflightStart`: **a promise waiting on itself** (when the outer start came from the API or the `restart` alarm, so `waking` was false) | Deadlock. Fixed in `65bf6ef` (notices from SandboxDO's alarm, AE:`sandbox.ts:487-504`; onSandboxMoved sets an alarm only, AE:`agent.ts:746-748`) |
| AE head | FleetDO host queue → onExited → wake → start → FleetDO.issueCommands/place (not queued). FleetDO tick → brainsLost → onHostLost → start → FleetDO | No cycle through a serial queue or a single-flight promise found. Holds FleetDO's host queue or tick for a whole start (latency only) |

Workers' subrequest-depth limit for call chains is unverified.

## 7. Past bugs and the properties that catch them

| Bug | Property | Caught at this abstraction? |
|---|---|---|
| `ce5c472` H1: a brain moved hosts while its sandbox stayed; the old one, stopped gracefully with a 1 h binding, kept acting | S1 | Yes, if a binding outlives its brain's stop and graceful stop isn't instant |
| `0c3a85c` H1: the floor was queued, not in effect | S6 | Only if the floor has distinct queued and applied states |
| `0c3a85c` M4 (main `fleet.ts:1123-1125`): an `agent_stop` ok dropped the index row | S7, L2 | Yes |
| `65bf6ef`: cross-DO deadlock (L3 table) | L3 | Only if RPCs are call/return with nested calls and the single-flight join (a wait-for graph); flat message passing misses it |
| `65bf6ef` M2: an epoch-less (old-version) exit | S2/S3 | Yes, with a mixed-version host |
| `ce5c472` M4/M5: start not single-flight; index keyed by agent, so an older exit dropped a newer row | S1, S7 | Yes |
| `a84a750`/`e76fe31`: session epoch was a cached sandbox epoch; a lost push left a brain refused forever | L1 | Yes, with lossy notices |
| `e76fe31`: a lost runner replayed a stale `agent_start` | S2 (runner) | Yes, with nestd reconnect |
| `e76fe31`: `starting` had no deadline | L1 | Yes, with lost commands |
| `e76fe31`: the runner ended turns one result early (overlap) | S5 | No: needs the runner's outstanding-message counter |
| `dede063` M1 (deferred/retention-enums): rows deleted before `onHostLost` succeeded; still on main and AE (F8) | L2 | Yes, with RPC failure |
| review lessons 4 and 6 (resume from durable bytes; retries that stop after one failure) | resume ⊇ acked bytes; L1 | Lesson 6 yes; lesson 4 needs the byte stream |

## 8. Bugs found

### main

| ID | Status | What | Confidence |
|---|---|---|---|
| M-1 | Real (operator-triggered) | `start(hostHint)` for a live brain on another host sends no stop. The old socket stays `current` until the new hello, and the old brain's binding (same sandbox epoch, 1 h) stays valid, so both brains act (S1). `agent.ts:367-430` | High |
| M-2 | Real | F3: the stop's ok drops the row. If the host then expires, `onHostLost` never comes and the agent is stuck (L1, L2). `fleet.ts:1123-1125` | High |
| M-3 | Real | F8 and F5 delete rows before calling AgentDO and only log failures; one transient error strands the agent. `fleet.ts:1776-1783,932-937` | High |
| M-4 | Suspected | A start that places an unplaced sandbox issues two `agent_start`s (L3 table). The runner answers `already_running`. Confirm with a test counting commands. `sandbox.ts:329,481-490`; `agent.ts:383,552` | Medium |
| M-5 | Real (gap) | No watchdog for a brain that vanished without an exit or a host loss (L1, L2) | High |

### AE (`65bf6ef`)

**A-1, suspected, S1/S3 (confidence medium-high).** A drained host is marked `dead` and its brains are handed back without checking `host_agents` (AE:`fleet.ts:1590-1599`). Instance termination is asynchronous. `onHostLost` then runs brainGone (or wake), and N+1 starts elsewhere at once, while the old brain lives until its lease lapses (up to 20 s after the 4410 close stops acks) or EC2 terminates the instance. This reaches a brain whose move was refused (no other host) or is still waiting for its exit.

**A-2, suspected, S4 plus collateral (confidence medium).** The runner keeps no tombstone, and N5 is a no-op for an agent not yet registered (AE:`supervisor.rs:94`). A start dispatched just before a kill arrives can register after it, most plausibly while it waits up to 10 s on a stopping predecessor (AE:`agent.rs:118`). nestd's `kill()` returned true, so no exit is reported. AgentDO waits 60 s, then calls `hostWedged`, and the host loses every brain (and is STONITH'd if it holds leases). S1 still holds.

**A-3, suspected, intent (confidence high).** killForMove fences sessions but `agent_epoch` stays N while it waits. The killed brain's runner reconnects within 5 s with hello epoch N from the old host, passes fetch and A4, and is accepted as current: its calls run and turns are pumped to it. This contradicts the AE:`agent.ts:523-528` comment ("late bytes go to the orphan branch"). A fenced-epoch mark would close it.

**A-4, suspected, L1 plus collateral (confidence medium; low probability, high impact).** A stale `awaiting_exit`. startBrain reads `prev` before `await hostStatus` (AE:`agent.ts:467-469`). killForMove sets `awaiting_exit` after `await issueCommands` (AE:`agent.ts:533-539`) without re-checking `host`. An exit landing in either await sets `host:=⊥` and skips brainGone; every later exit is dropped (`host ≠ A`). `exit_wait` then wedges a healthy host (A9 has no relevance check), and `pending_start` never runs.

**A-5, real, L2 (confidence high).** F6 ignores a silent `sandbox`-role host with no live lease. On AE, a brain stays on a host its sandbox left, so its agent can be stuck for ever.

**A-6, gap, S1 (confidence medium).** A controller or no-lease host expired at 30 s, wedged ones included, hands its brains back without STONITH. Safety then rests on T2 and T4. Yet `hostWedged` fires precisely when a brain didn't die on a kill, which can be a wedged runner. With floors gone, a surviving brain's 1 h binding is still honoured by the gateway. Suggestion: terminate before brainsLost for wedged hosts.

Doc mismatches:

- `docs/agents/runner/README.md:75` says nestd "stops every runner process"; the code fences brains via the runner (`host.rs:1086-1094`).
- `docs/control-plane/durable-objects/agent/README.md` says "runner process"; the lineage is per brain session.

## 9. Modelling notes

- **Abstraction:**
  - Agents: 1. Hosts: {A, B} with status and lease. Epochs <= 4. Turns <= 2. Crash budget 3.
  - DO methods are split into atomic steps at each await, re-reading state after it. A DO reset can happen at any await and drops the volatile variables.
  - Fleet channels are per-host FIFOs; `kill` and `fence` act on arrival.
  - Runner registration is a separate step after dispatch (exposes A-2).
  - Time is abstract. Expiry is enabled only when every brain on the host is dead, unless a `runnerWedged(h)` fault is on (exposes A-6). Drained-dead is a separate action (exposes A-1).
  - For L3, model RPC call stacks, the single-flight join and SandboxDO's inline or alarm notify.
- **Action to code:** wake A1, start A2/A2s/A3, hello A4, exit F2→A5, hostLost F6/F7/F8/F10→A6, deadlines A7-A10, stop A11, move A12, drain F10→A13, kill-arrive N1, start-dispatch N2, runner-register N4, runner-stop N5, lease-lapse N6, proc-exit N7, turn Q1-Q6.
- **Bounds to try:** 2 hosts × 3 epochs × 1 sandbox move × 1 drain × 1 lost RPC answer finds every A-item.
- **Runtime assertions and tests now:**
  1. In `startBrain`, assert `awaiting_exit = ⊥` whenever `host ≠ prev.host` (S3).
  2. In `dispatch`, assert the attachment's epoch is `agent_epoch` (S2).
  3. Tests: a drained host with a brain row (A-1); a kill arriving while a start waits on a stopping brain (A-2); a hello at epoch N from the old host during `awaiting_exit` is refused (A-3); an exit during killForMove's awaits doesn't wedge a host (A-4); a silent no-lease sandbox host is expired (A-5); `onHostLost` failing once is retried (M-3).

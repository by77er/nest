# Reliable channels: verification inventory

> **Study, not a decision.** Code on `main` (edf6829); every claim cites `file:line`. Contract: [control-host](../../interfaces/control-host/), [fleet](../../interfaces/control-host/fleet/), [session](../../interfaces/control-host/session/); settled rule in [docs/README.md](../../README.md) ("Reliable channels deliver strictly in order ... a new `instance_id` resets the lineage").

> **Since:** the fleet direction is now checked over nestd's real core ([nestd/](../nestd/)). B1, B2 (with the pilot's F2 and F3), B3 and the pilot's F4 are fixed there (#39); the checker shows each fix holds, and each, removed, fails. B5 is open ([nestd/](../nestd/#open-questions)); B4 and B6 have not been re-checked. The runner's session receiver still has no gap check.

## Scope and actors

| Channel | Sender → receiver | Seq'd messages | Ack | Lineage key |
|---|---|---|---|---|
| Fleet up | nestd → FleetDO | `events` batches | cumulative `ack`, after FleetDO processed | nestd `instance_id` (`hosts.nestd_instance`) |
| Fleet down | FleetDO → nestd | `commands` batches | cumulative `ack`, after nestd's executor ran the batch | same |
| Session up | runner → AgentDO | `events`, `tool_call`, `cancel_call` | cumulative `ack`, after AgentDO processed | runner `instance_id` (`runner_instance`) |
| Session down | AgentDO → runner | `run_turn`, `inbox`, `interrupt`, `cache_update`, `tool_result` | cumulative `ack`, **on receipt** (enqueue) | same |

Out of scope (not seq/ack channels): `segment` (offset-keyed), nestd↔runner (connection-scoped, no replay: `crates/nestd/src/runner_link.rs:9-14`), nestd↔proxy (mirror + full resync, queued ops skipped when `seq <= snapshot_seq`: `crates/nestd/src/proxy_link.rs:3-7,363-365,451`), nestd↔gateway (see [gateway-bindings](../gateway-bindings/)).

**State.**

| Actor | Durable | Volatile | Code |
|---|---|---|---|
| `ReliableChannels` (FleetDO per host, AgentDO one chan) | `rel_out(chan, seq, body)`, `rel_state(next_out, last_in?)` | — | `control-plane/src/lib/reliable.ts:9-79` |
| FleetDO | `hosts.nestd_instance`, `commands(cmd, result?)` | per-host `SerialQueue`, socket attachment `{helloed}`, `keysSent` | `control-plane/src/do/fleet.ts:161,243-247,1152-1173` |
| AgentDO | `runner_instance`, `events` dedup rows, `tool_calls` | one `SerialQueue`, attachment `{helloed, stale, instance, epoch}` | `control-plane/src/do/agent.ts:117,169,726-797` |
| nestd fleet task | none | `pending`, `unacked`, `next_seq`, `last_command_seq`, `forwarded_command_seq`, `shed` | `crates/nestd/src/fleet.rs:106-128` |
| runner session | none | `next_seq`, `unacked`, `last_in` | `crates/nest-runner/src/session.rs:51-63` |

## Transitions

**Fleet up (events).**

| # | Transition | Actor | Guard | Effect | Code |
|---|---|---|---|---|---|
| E1 | enqueue | nestd | — | `pending += e` (audit coalesced); if `pending+unacked > 4096` shed rank-0 then rank-1 `pending` events to 3072 | `fleet.rs:196-227` |
| E2 | flush | nestd | `pending ≠ ∅` (tick, 100 events, before a commands ack) | `seq := next_seq++`; `unacked += (seq, pending)`; send | `fleet.rs:362-371` |
| E3 | arrive | FleetDO | — | attachment read **at arrival**; first frame must be hello; per-event schema parse, bad events quarantined; enqueue on host queue | `fleet.ts:633-661` |
| E4 | duplicate | FleetDO | `seq ≤ last_in` | `ack(last_in)` | `fleet.ts:963-967`, `reliable.ts:57-62` |
| E5 | gap | FleetDO | `seq > last_in + 1` | `error{retryable}`; close 4409 | `fleet.ts:968-972` |
| E6 | process | FleetDO | `last_in = ⊥` or `seq = last_in + 1` | `handleEvent` each; throw → error + close 4500; else `markProcessed(seq)`; `ack(seq)` | `fleet.ts:973-982` |
| E7 | ack | nestd | — | `unacked := {s > up_to}` | `fleet.rs:405-407` |
| E8 | reconnect | nestd | socket closed, silent 2.5 heartbeats, or retryable error | hello{`last_command_seq`}; on `hello_ack`: drop `unacked ≤ last_event_seq`, resend rest in order; `forwarded := last_command_seq` | `fleet.rs:243-297,315-318,418-429` |

**Fleet down (commands).**

| # | Transition | Actor | Guard | Effect | Code |
|---|---|---|---|---|---|
| C1 | issue | FleetDO | — | insert `commands` rows; `push` (seq persisted); if a helloed socket exists, `await sendResolved` | `fleet.ts:1152-1173` |
| C2 | sendResolved | FleetDO | — | `await` BrokerDO per secret purpose (only `agent_start`, `secrets_update` have slots: `broker.ts:184-194`); on failure **return without sending**; else send in order | `fleet.ts:699-723` |
| C3 | arrive | nestd | `seq ≤ last` → re-ack `last`; `seq ≤ forwarded` → drop ("still processing"); else `forwarded := seq`, hand to host | **no gap check** | `fleet.rs:394-404` |
| C4 | execute | nestd executor | FIFO | run each command (dedup by `cmd`); `CommandsDone(seq)` | `host.rs:553-561` |
| C5 | done | nestd | — | `last := max(last, seq)`; flush events (results first); `ack(seq)` | `fleet.rs:337-342` |
| C6 | ack | FleetDO | — | delete `rel_out ≤ up_to` | `fleet.ts:663-665`, `reliable.ts:35-37` |
| C7 | resend | FleetDO (hello) | — | `ack(last_command_seq)`; `sendResolved(pendingAfter(last_command_seq))` | `fleet.ts:777-778` |

**Lineage (fleet).**

| # | Transition | Guard | Effect | Code |
|---|---|---|---|---|
| H1 | hello (in host queue) | version, host match | old sockets: `helloed := false`, close 4000; `nestd_instance := hello.instance_id`; this socket `helloed := true`, then `hello_ack{last_event_seq?}`, then **awaits** token rotation and binding keys, then C7, reconcile | `fleet.ts:729-797` (helloed at 762; awaits 772-774) |
| H2 | new process | `nestd_instance ≠ ⊥ ∧ ≠ hello.instance_id` | `rel.reset`: delete `rel_out`, `last_in := ⊥`, `next_out` kept; after reconcile, commands with `result IS NULL` (captured at 789) fail retryably, a reported `sandbox_create` completes | `fleet.ts:751-755,786-792,1086-1097`, `reliable.ts:68-72` |

**Session.** AgentDO hello (in its queue): stale epoch → hello_ack + `stale_epoch`, segments only; else supersede old sockets; new lineage → `rel.reset`, `DELETE FROM events`, requeue the cut-off turn as recovery; `hello_ack{last_seq?}`; resend `pendingAfter` (`agent.ts:726-797`). Inbound `events`/`tool_call`/`cancel_call` run in the queue with the attachment **read inside the queue** and `current(att)` checked (`agent.ts:664,1003-1015,1195-1235,1241-1270`); a throw → error, attachment stale, close 4500 (`agent.ts:677-689`). Outbound `pushReliable` pushes and sends synchronously (`agent.ts:718-723`). Runner: inbound `seq ≤ last_in` → ack, else `last_in := seq`, enqueue, ack — no gap check (`session.rs:296-338`); outbound seqs, `abandon` replaces an unacked `tool_call` by a `cancel_call` at the same seq (`session.rs:73-90`); reconnect resends `unacked > hello_ack.last_seq` (`session.rs:182-218`).

## Delivery and timing assumptions

- A WebSocket is FIFO, lossless and non-duplicating while open, and may close at any point. Frames on two sockets are unordered relative to each other.
- A Durable Object runs one event at a time, but its input gate opens across awaits on other DOs (stated at `reliable.ts:83-84`), so RPCs and alarms interleave with queued work. It can be evicted at any point, losing `SerialQueue` and `keysSent`, keeping SQLite.
- A DO's outgoing `send` after a SQLite write is held until the write is durable (output gate; [Cloudflare](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)). Unverified for hibernatable WebSocket sends.
- nestd and the runner hold channel state in memory only; a crash is a new process with a new `instance_id`.
- Timers: nestd backoff 200 ms–30 s (`fleet.rs:158,183`), liveness 2.5 heartbeats (`fleet.rs:306`); runner backoff 100 ms–5 s (`session.rs:100,129`).

## Safety properties

Per channel direction and lineage `L` (between two resets): `sent(L)` the seqs the sender pushed, `proc(L)` the seqs whose effects the receiver applied, `acked(L)` the highest `up_to` sent.

| Id | Predicate | Holds on main? |
|---|---|---|
| S1 no gap | `proc(L)` is a contiguous interval `[b, k]` and is applied in increasing order | FleetDO, AgentDO: yes (`reliable.ts:57-62`). **nestd, runner: no** (no gap check, `fleet.rs:394-404`, `session.rs:308-313`); see B1 |
| S2 at most once | each seq enters `proc(L)` at most once | batch level: yes (`markProcessed` after processing). Per event: **at least once** when a later event in the batch throws (B4) |
| S3 ack ⇒ processed | `ack(n)` sent ⇒ `∀ s ≤ n, s ∈ sent(L): s ∈ proc(L)` and durable | FleetDO, AgentDO, nestd: yes. Runner: ack on enqueue; acceptable only because its lineage dies with the process |
| S4 no loss | the sender deletes `m` from its outbox only if `m ∈ proc(L)`, or `L` was reset and `m` got a terminal outcome | **no**: B1 (commands), B3 (events) |
| S5 lineage isolation | after the reset at hello `H` (instance `I`), no message sent by a process `≠ I` is processed | AgentDO: yes (`current(att)` in queue). **FleetDO: suspected no** (B3) |
| S6 seq monotonic | `next_out` never decreases; a seq is never reused | yes (`reliable.ts:26-31`; `next_out` survives `reset`) |
| S7 bounded buffers | `|pending| + |unacked| ≤ 4096` | **no**: only sheddable events are dropped (`fleet.rs:206-226`); input channels are unbounded (`fleet.rs:86`) |
| S8 shedding | only `egress_audit`, `capacity`, `egress_denied`, `port_opened` are ever dropped, and only before they get a seq | yes (`fleet.rs:136-147,211-218`). Dependents: placement reservations wait for a later `capacity` (`fleet.ts:1217`) |

## Liveness (weak fairness on reconnect, flush, executor, DO alarms)

| Id | Property | Holds on main? |
|---|---|---|
| L1 | eventually-stable connectivity and no permanent processing failure ⇒ every pushed message is processed or its lineage is reset | yes for events; **no for commands** (B1) |
| L2 | every issued command eventually has exactly one `commands.result` | **no**: no timeout sweep; a lost batch keeps `result IS NULL` until a nestd restart (`fleet.ts:786-792`). B2 gives some commands a spurious result |
| L3 | a poison message cannot stall a channel | fleet: schema failures quarantined per event (`fleet.ts:655-660`, 93d1f52); processing failures are not (resent forever, earlier events re-applied each time). Session: no quarantine (B6) |

## Past bugs and the property that catches each

| Commit | Bug | Property |
|---|---|---|
| 93d1f52 (in #25) | a malformed id from a sandbox made FleetDO reject a whole batch; nestd resent it forever, stalling the host | L3, L1 |
| e76fe31 (#25) | AgentDO marked events seen before their side effects; a failure lost them | S3, S4 |
| pre-history; `control-plane/test/regressions.test.ts:175` | a later batch's cumulative ack covered an earlier failed one | S1, S3 |
| a9d3ce0, edf6829 (#27) | a nestd restart dropped what the old process left; now reconciled from the hello report, not replayed | S4 (reset branch) |
| 6d1586f (#25) | runner link replayed a stale `agent_start` on reconnect | S5 (connection-scoped analogue) |

## Bugs found

**B1 — command batches lost by reordering (real; high confidence from code).** FleetDO can put a higher seq on the wire before a lower one: (a) C2 awaits BrokerDO for batch N (`agent_start`/`secrets_update`) while a concurrent batch N+1 without secret slots sends synchronously (`fleet.ts:1169-1171`, `fleet.ts:706-722`); (b) H1 marks the new socket helloed (`fleet.ts:762`) and awaits BrokerDO (`fleet.ts:772-774`) before resending unacked N..M-1 (`fleet.ts:778`), so an `issueCommands` in that window sends M first; (c) C2 gives up without sending N (`fleet.ts:714`) and N+1 goes out. nestd forwards M, then drops N as "still processing" because `N ≤ forwarded` (`fleet.rs:399-401`), acks M, and FleetDO deletes N (`reliable.ts:35-37`). Breaks S1 (nestd), S4, L2; the docs' "a gap closes the socket" (`docs/interfaces/control-host/fleet/README.md:37`) is not implemented on nestd. Effects: lost `agent_start` (healed by AgentDO's 2 min `starting` deadline), lost `agent_attach` (SandboxDO keeps `attach_inflight`, `reissuePendingAttaches` skips it, `resolve` answers not-ready until the next placement: `sandbox.ts:794,848`), lost `agent_detach` (binding usable up to `exp`, see [gateway-bindings](../gateway-bindings/)), lost `fence`/`sandbox_destroy`. Reproduce: in the workers test pool, stub `BROKER.resolveRefs` with a deferred promise, `issueCommands(h, [agent_start])` then `issueCommands(h, [agent_attach])`, and assert wire order; in Rust, feed `fleet::State` `commands{seq 2}` then `commands{seq 1}` and observe `ack{2}` with batch 1 never forwarded.

**B2 — commands issued during a new-process hello failed spuriously (real for the reconcile fence; timing-dependent otherwise; medium).** The "unanswered by the old process" set is read at `fleet.ts:789`, after awaits and after `reconcileSandboxes` issued its own `fence` (`fleet.ts:782,841`). Every command issued to the new process in between is marked failed retryably (`fleet.ts:1086-1097`) and its real result ignored (`fleet.ts:1104`). A concurrent `agent_attach` or `sandbox_create` then triggers retries or a re-placement while the host runs it. Breaks L2 ("exactly one, real result"). The comment at `fleet.ts:788` claims the capture precedes new issues.

**B3 — a stale-instance batch can become the new lineage's baseline (suspected; low likelihood).** The attachment is read at arrival, outside the queue (`fleet.ts:634,661`), and `onEvents` never checks that the socket is current. If an old socket's batch `k` arrives after the new hello is queued but before `onHello` runs, it is processed after `rel.reset` as the baseline (`reliable.ts:59`); the new process's batches `1..k` are then duplicates, acked and dropped. Breaks S5, S4. AgentDO avoids this (`agent.ts:664,1004`). Confirm with two sockets and a `handleEvent` held on a deferred promise.

**B4 — partial batch failure re-applies earlier events (suspected; medium).** A throw at event `j` closes the socket; the resend re-runs events `< j`. Not idempotent per event: `guest_cli` relay (`fleet.ts:1048-1058,1067-1082`, no request-id dedup seen; unverified in `AgentDO.guestCli`), `egress_audit` (new R2 key each time, `fleet.ts:1031-1035`), `task_exited`, `workstream` ingest (unverified). A permanent failure repeats them forever.

**B5 — mixed-version frames vanish (latent).** An old nestd or runner that cannot parse a frame drops it silently (`fleet.rs:436-448`, `session.rs:240-243`); with no gap check the next seq is accepted and the cumulative ack deletes the unknown batch, including known commands in it. `CommandBody` has no catch-all (`crates/nest-protocol/src/control.rs:291-292`). "Compatible one version back" (`docs/control-plane/README.md:34`) covers fields, not variants; `protocol_version` must match exactly (`fleet.ts:730`, `agent.ts:730`), so no bump is possible without stranding hosts. Branch 0c3a85c gated new commands on host capabilities (later removed in 65bf6ef).

**B6 — session poison loop (suspected).** AgentDO rejects a frame that fails its schema with `invalid_message` and does not close (`agent.ts:626-635`); the runner reconnects on `invalid_message` (`session.rs:330-333`) and resends the same batch forever. Breaks L3.

**B7 — a failed send lost a runner session message and wedged the channel (fixed).** The runner assigned a seq, sent, and only then queued the message for resending; a send that failed (a broken socket) spent the seq and dropped the message, so every later batch was a gap to AgentDO until the brain exited. Now the message is queued before it is sent (`session.rs` `send_reliable`), as the model's separate *assign* and *send* actions require: the send may fail, the message stays in `unacked` under its seq. Test: `a_batch_whose_send_fails_is_resent_under_its_seq`.

## Modelling notes

- **Abstraction.** One direction at a time: `Sender{outbox: seq→msg, next}`, `Receiver{last: ⊥|n, forwarded}`, connections with ids and FIFO queues, `close` at any step, `crash` of either process (new instance; volatile state wiped, DO SQLite kept). Make **seq assignment and wire send separate actions** (B1), the **attachment read separate from processing** (B3), processing nondeterministically fail or partially apply (B4). Two receiver variants: TS (gap check) and nestd/runner (forwarded, no gap check).
- **Bounds.** 3–4 messages, 2 connections, one crash per side, batches of 1–2 events, one unknown-variant message (B5).
- **Tools.** The protocol spans TS and Rust, so check it as an abstract model: **Stateright** actor model (ordered per-connection network, `always`/`eventually` properties) fits and lives next to the Rust code; Quint/TLA+ is equivalent. nestd's fleet task owns its state in one `select!` loop (`fleet.rs:312-358`), so **loom/shuttle add nothing there**. The TS await interleavings are best found by **fast-check** model-based tests with `fc.scheduler()` driving BrokerDO/SandboxDO promises against the real FleetDO/AgentDO in the workers pool; `ReliableChannels` alone suits a plain fast-check model (`classify`/`markProcessed`/`pendingAfter` vs a list model).

| Model action | Code |
|---|---|
| push / send | `reliable.ts:26-31` / `fleet.ts:699-723`, `agent.ts:718-723`, `fleet.rs:362-371`, `session.rs:340-353` |
| receive + classify | `fleet.ts:962-982`, `agent.ts:1003-1015`, `fleet.rs:394-404`, `session.rs:308-313` |
| ack | `reliable.ts:35-37`, `fleet.rs:405-407`, `session.rs:325` |
| hello / reset / resend | `fleet.ts:729-797`, `agent.ts:726-797`, `fleet.rs:243-297`, `session.rs:182-218` |
| shed | `fleet.rs:196-227` |

## Runtime assertions and tests to add now

- nestd: accept a command batch only if `seq = forwarded + 1` (or the first after hello); otherwise reconnect. Test: seq 2 then 1 never acks 1's loss.
- FleetDO: one per-host send chain so wire order equals seq order (C1, C7); test with a deferred BrokerDO.
- FleetDO `onEvents`: re-read the attachment inside the queue and require `socketFor(host) === ws`; test B3.
- `ReliableChannels.markProcessed`: assert `seq = last_in + 1` or `last_in = ⊥`; `ack(up_to)`: log when `up_to ≥ next_out` (lineage confusion).
- Runner: log and reconnect on an inbound gap.
- Capture the new-process pending set synchronously in `onHello`, before the first await (B2).
- Session channel: per-event quarantine like the fleet channel (B6).

# Reliable channels pilot: Stateright model of command delivery

> **Study, not a decision.** Code on `main` (edf6829). Model: [verification/stateright/](../../../../verification/stateright/) (Stateright `=0.31.0`, `cargo test --release`). Inventory: [../README.md](../README.md) (finding B1). **Superseded:** #39 shipped both fixes below, with the capture at reset, and they are checked over nestd's real core in [nestd/](../../nestd/#fleet-link-phase-1).

## Verdict

- **B1 reproduces.** Main loses an acked command in 8 steps, with no fault and no secret ref: the onHello window alone is enough.
- **Both fixes hold at full bounds:**
  - (b) receiver gap check: 12.5M states;
  - (c) per-host send chain: 7.4M states; also 46M states with 2 drops.
- **Each fix needs pieces the model surfaced that the inventory doesn't name.** Each one is shown necessary by a diagnostic run:
  - a resend trigger after a BrokerDO failure;
  - failing the old lineage at `rel.reset`, not after the awaits;
  - for (b): a hello_ack baseline, and a monotone offline `last`.
- **New findings:** F2 to F5 below. F2 and F3 are in onHello's new-process path and are independent of ordering.

## Model to code

| Model element | Code |
|---|---|
| `Issue{secret}`: insert, `rel.push`, send if a helloed socket exists | `fleet.ts:1152-1172` (push 1169, `await sendResolved` 1171); secret slots `broker.ts:184-194` |
| `Task::Resolve`, `BrokerOk`, `BrokerFail` (returns, batch stays queued) | `fleet.ts:699-723` (await 711, return 714) |
| `FleetRecv Hello`: per-host queue, `rel.reset` on new instance, `helloed := true`, `hello_ack` | `fleet.ts:651`, 755, 762, 764-771 |
| `HelloResume`: awaits rotateToken and bindingPublicKeys, then `ack(last)` and `pendingAfter` | `fleet.ts:772-778` |
| `HelloReconcile`: capture `result IS NULL`, fail them | `fleet.ts:789-791`, `failPendingCommands` 1086-1097 |
| `FleetRecv Ack`: cumulative | `fleet.ts:663-665`, `reliable.ts:35-37` |
| `outbox`, `next_out`, `secret` (durable) | `rel_out`, `rel_state` (`reliable.ts:11-31`), command bodies |
| `NestdRecv Commands`: re-ack `<= last`, drop `<= forwarded`, else forward | `fleet.rs:394-404` |
| `NestdRecv HelloAck`: `forwarded := last` | `fleet.rs:297` |
| `Exec`: FIFO executor, cached replay by `cmd` | `host.rs:553-561`, 1330-1347 |
| `CommandsDone`: online `max` + `ack{up_to: seq}`; offline `last := seq` | `fleet.rs:337-342`, 190 |
| `Connect`: hello with `last_command_seq`, `instance_id` | `fleet.rs:243-258` |
| `NestdRestart`: new `instance_id`, volatile state gone | `host.rs:442`, `fleet.rs:93-96` |
| `FleetReset`: SQLite kept; continuations, send chain and sockets lost | DO restart |
| `Drop`: frames in flight lost; continuations write to a dead socket | `fleet.ts:685-691` (`send` swallows) |

**Abstractions:**

- One command per batch, so a seq names a command.
- Results are delivered when the command executes (the events channel is outside the model). As a result, `failPendingCommands` fails exactly the issued commands that were never executed.
- One socket at a time; superseding is atomic.
- During the handshake, nestd's `CommandsDone` is treated as online.
- Heartbeats, leases and events aren't modelled.
- The model doesn't track multiple hosts: all its commands go to one host.

**Assumptions (unverified):**

- A FleetDO restart (deploy, crash) closes its WebSockets.
- Hibernation eviction happens only with no pending await, so it loses nothing the model cares about.

**Bounds:** 3 commands, each with or without a secret ref, 1 drop, 1 nestd restart, 1 FleetDO reset and 1 BrokerDO failure.

## Properties

| Property | Kind | Meaning |
|---|---|---|
| `no_ack_without_execution` | always | a seq gone from `rel_out` was executed, or failed by a reset (or is awaiting that capture) |
| `in_order_per_lineage` | always | each process executes seqs `b, b+1, ...` from its lineage base, with no gap (replays allowed) |
| `failed_never_executed` | always | no command is both failed by FleetDO and executed by nestd (exactly one true result) |
| `gap_closes_bounded` | always | at most 4 socket closes caused by a gap or a BrokerDO failure, which catches a reconnect loop |
| `every_command_answered` | eventually | every issued command is executed or failed. Faults are bounded, so the network eventually stays up |

Stateright checks `eventually` only on acyclic paths. The predicate is monotone and every fault is bounded (gap closes too, through a boundary), so neither cycles nor DAG joins can hide a violation. Two `sometimes` properties confirm recovery paths exist.

## Results

| Variant | States | Time | Outcome |
|---|---|---|---|
| (a) main as coded | 5,953,442 | 10-20 s | violates all four (shortest traces: 8, 7, 12, 12 steps) |
| (a) with no faults | 14,707 | 0.02 s | `no_ack` (8 steps), `in_order` (7), liveness (10) |
| (b) gap check that closes, hello_ack baseline, offline `max`, close on BrokerDO failure, capture at reset | 12,486,462 | 47 s | holds |
| (c) per-host send chain, hello resend queued when `helloed` is set, close on BrokerDO failure, capture at reset | 7,366,370 | 13-33 s | holds; also 46,012,076 states (262 s) with 2 drops |
| (b), baseline = first batch after hello | 11.5M | 33 s | `no_ack` (8), `in_order` (7) |
| (b), offline `last := seq` as coded | 14.1M | 45 s | `gap_closes_bounded` (39): reconnect loop |
| (b) / (c), BrokerDO failure doesn't close | 4.7M / 2.6M | 18 s / 9 s | liveness (12) / `no_ack` (10) |
| (c), capture after the awaits | 18.8M | 81 s | `failed_never_executed` (13), liveness (16) |
| mutation of (b): gap dropped silently | 6.5M | 24 s | liveness (17) |
| mutation of (c): hello resend queued after the awaits | 6.5M | 21 s | `no_ack` (9) |

Times are single-threaded on a shared WSL2 box and vary by up to 2x.

**Counterexamples (a), in plain words:**

1. **Hello window (8 steps).**
   - FleetDO issues seq 1 while the host is offline.
   - nestd connects. onHello sets `helloed` (`fleet.ts:762`) and awaits `bindingPublicKeys` (774).
   - Meanwhile an `issueCommands` RPC pushes seq 2 and sends it: `socketFor` finds the helloed socket (1170-1171).
   - nestd forwards 2 and sets `forwarded = 2` (`fleet.rs:402`). It executes 2 and acks `up_to: 2` (341).
   - FleetDO deletes seqs ≤ 2 (`reliable.ts:36`). The resend at 778 finds nothing, and seq 1 is never executed or answered.
2. **Await reorder (7 steps).** Seq 1 is an `agent_start` awaiting BrokerDO (`fleet.ts:711`), and seq 2 has no secret, so it sends synchronously. nestd executes 2 first.
3. **BrokerDO failure (liveness, 12 steps).** The resend's `resolveRefs` fails (714). Nothing sends the pending batch until another hello comes. If another command is issued first, its ack deletes the pending batch, as in 1.
4. **F2, the capture race (12 steps).**
   - nestd restarts. The new hello runs `rel.reset` (755), then awaits.
   - An `issueCommands` RPC sends seq 1 to the new process.
   - The capture at 789 selects seq 1 (its `result IS NULL`) and fails it (791). nestd then executes it; its real result is dropped as "redelivered" (1104).
5. **F3, a FleetDO reset mid-hello (16 steps).**
   - FleetDO resets between `rel.reset` (755) and the capture (789).
   - The next hello carries the same `instance_id`, so `newProcess` is false. The old lineage's commands are never failed.
   - `failPendingCommands` awaits per command, so a reset partway through also leaves the rest unfailed.

**Other findings:**

- **F4.** Under (b), a BrokerDO failure with no later gap stalls the batch until an unrelated reconnect.
- **F5.** Under (b), a fresh lineage needs a baseline, because "first after hello" accepts N+1 when N is still awaiting. nestd's offline `last := seq` (`fleet.rs:190`) also moves `last` backwards after a cached replay, so a strict gap check closes forever.

## Bug write-up (B1)

- **Where:** `fleet.ts:762` with 772-778 (the hello window), `fleet.ts:1169-1171` with 706-716 (await or failure between push and send), and `fleet.rs:394-404` (no gap check, cumulative ack at 341).
- **Trigger:** a higher seq reaches nestd before a lower one on the same connection: (i) an `issueCommands` RPC from AgentDO or SandboxDO lands during onHello's BrokerDO await while unacked batches exist (most likely: a deploy reconnects every host at once); (ii) two batches to one host, the first carrying a secret ref; (iii) a BrokerDO failure followed by any later command (then deterministic). Event-driven issues (`commit_result`) share onHello's queue, so they can't cause (i).
- **Consequence:** the lower batch is dropped as "still processing", then deleted by the cumulative ack: never executed or answered (its result stays NULL until a nestd restart fails it). A lost `agent_start` is healed by AgentDO's `starting` deadline; a lost `agent_attach` leaves no binding until the next placement; a lost `agent_detach` leaves the binding usable until it expires; a lost `fence` leaves the sandbox running (a STONITH fence is re-issued at the next hello); a lost `sandbox_destroy` leaks the VM and disk (unverified); a lost `commit_result` makes nestd ask again under the same id.

## Fix options

| Option | Change | Model | Cost |
|---|---|---|---|
| **Sender chain (c)** | one per-host promise chain for every command send. onHello queues the resend in the same synchronous step that sets `helloed`. A BrokerDO failure closes the socket (retryable), so a hello resends | holds | ~30-40 TS lines, no protocol change |
| Resolve before `rel.push` | not modelled | doesn't close the hello window; stores secret values in `rel_out` | rejected |
| **Receiver gap check (b)** | nestd accepts only `forwarded ∨ last + 1`; a gap closes the socket. A fresh lineage takes its baseline from a new `hello_ack` field (the lowest seq FleetDO will send). Offline `last := max` (`fleet.rs:190`). FleetDO still closes on a BrokerDO failure | holds | protocol and fixture change, ~40 Rust + ~15 TS lines; reconnect churn under races |
| **Capture at reset** | at `fleet.ts:755`, select the old lineage's NULL results and write their failures synchronously with `rel.reset`; run the follow-ups (`onCommandResult` DO calls) afterwards | required by both | ~15 TS lines |

**Recommendation:** (c) plus capture at reset, with (b)'s gap check as a tripwire, only with the baseline and the offline `max`. The inventory's "or the first after hello" baseline is unsound (`b-firstbase`). #39 shipped all three.

## Effort

About 450 lines of model, 280 of harness and 105 of tests; about 4 agent-hours. Stateright's strengths and gaps as found here are in [methods](../../methods/).

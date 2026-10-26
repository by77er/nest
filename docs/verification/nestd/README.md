# nestd verification

nestd is verified as the code that ships. Each state machine's decisions live in a pure core, and the async code around it is a thin I/O shell. The checks run against the real cores:
- model checking, exhaustive within stated bounds;
- Kani proofs;
- mutation testing.

The parsers at nestd's trust boundaries are fuzzed. TLA+ and Quint stay for design exploration (the [study](../)); they aren't the source of truth for this code.

**Status:**
- **Phase 1 done:** the fleet link (with the executor's dedup and the lease watchdog) is extracted and checked; Kani covers the pure decision functions that exist today; fuzz targets cover every wire parser; runtime assertions are in place.
- **Phase 2 designed, not built** (below): sandbox incarnations, the proxy link, the gateway link and the runner link's brain table. It waits on the host.rs branches in flight.

Evidence tiers ([dev/practices.md](../../../dev/practices.md#evidence-tiers)): every result here is **bounded**. A model check holds for the bounds it names, a Kani proof for its unwind bounds, and a fuzz run for the time it ran. None of it says anything about the real network, the real control plane or real hosts.

## The core/shell split

- **A core** is `step(&mut state, now, input) -> Vec<Effect>`. It lives in `crates/nestd-core`, which has no dependencies at all.
  - The `nestd-core-purity` fence ([scripts/fences.toml](../../../scripts/fences.toml)) fails CI if anything under `crates/nestd-core/` names a clock (`Instant`, `SystemTime`), `std::fs`, `std::net`, `std::process`, `std::thread`, `std::env` or `std::io`, a hashed map (its hasher seeds from the OS), `async`/`.await`, `tokio`, `rand`, `libc`, `nix`, `unsafe`, or a `[dependencies]` table.
  - The crate is also `#![forbid(unsafe_code)]`.
- **The shell makes no decisions.** It only does five things:
  1. read and decode an input;
  2. read the clocks and pass them in (`Now { mono, boot, wall }` in ms);
  3. call `step`;
  4. persist the core's durable part;
  5. perform the effects in order.
- **Effects are a closed enum.** One small interpreter performs them, one arm per kind, and each arm is one I/O operation.
- **Outcomes go back to the core.** Every failure comes back as an input: a failed send returns its frame to the core. A fire-and-forget success carries no information and isn't fed back.
  - The interpreter keeps only transport state (the socket handle). Once a send fails, the socket is dropped and later sends in the same batch fail fast and come back too.
- **Timers are core state.** The core says when it next needs `Tick` (`wake_at()`); the shell sleeps until then.
- **Write-ahead.** A core whose state is durable returns the record to persist with the step's effects, and the shell persists it before performing any of them. Effects carry ids (cmd, request, epoch), so a replay after a crash is idempotent. The checkers model the crash: memory lost, durable state kept.
  - The fleet link has no durable state (a new process is a new `instance_id`, and FleetDO resets the lineage). Incarnations do (`meta.json`, phase 2).
- **Runtime assertions.** `nestd_core::invariant::check(cond, name)` asserts each core's invariants in the shipped code.
  - A violation panics in debug builds (every test, and the checker, which builds with debug assertions).
  - In release it is counted and logged through the hook `nestd` installs (`main.rs`), never fatal.

## Machines

| Machine | Core | State | Inputs | Effects | Durable | Phase |
|---|---|---|---|---|---|---|
| Fleet link | `nestd_core::fleet::FleetLink` | connection phase, backoff, token, lease timing, events outbox (pending, unacked, next seq), commands (last processed, forwarded, expected), heartbeat send times | host events, `CommandsDone`, CA renewal, connect outcome, send failure, close, decoded FleetDO frames, noise, `Tick` | connect, send frame, close, notify host, log | none (lineage per process) | 1, done |
| Command dedup | `nestd_core::results::ResultCache` | bounded `cmd → outcome` map | lookup, record | none | none | 1, done |
| Lease watchdog | `nestd_core::lease::check` | the deadline (in host.rs) | what remains of it on each clock | `Expired` (self-fence) or `Valid { recheck_ms }` | none | 1, done (decision only) |
| Incarnations | `nestd_core::incarnation` (decisions now; the machine in phase 2) | per `(sandbox, epoch)`: phase, `meta` (head, clean, unanswered), tombstone, salvage retry | commands, driver and store outcomes, commit answers, a scan at start | write meta, boot, pause or stop the VM, send `commit_request`, rename to `.del`, proxy and gateway ops, report | `meta.json`, the directory | 2 |
| Proxy link | phase 2 | mirror, `seq`, listener ownership, resync | proxy frames, connection, timers | send op, resync, pass fds | none | 2 |
| Gateway link | phase 2 | binding keys, per-sandbox entries, tombstones | gateway frames, sandbox upserts/forgets/removes | send op, replay | none | 2 |
| Runner link (brain table) | phase 2 | brains by agent: binding, state, connection | runner frames, `agent_start`/`agent_stop`, connection | send, report `agent_exited` | none | 2 |

## Fleet link (phase 1)

### Shell audit

[`crates/nestd/src/fleet.rs`](../../../crates/nestd/src/fleet.rs) is 327 lines: about 135 are the public types the host uses (unchanged), 30 are the `OutboxEvent` instance (shed rank, audit coalescing), and about 160 are the loop, the interpreter and the codecs. The core is 560 lines in [`crates/nestd-core/src/fleet.rs`](../../../crates/nestd-core/src/fleet.rs).

| Effect or input | I/O | Where |
|---|---|---|
| `Connect { token }` → `Connected` or `ConnectFailed` | WebSocket upgrade with `Authorization: Bearer`, 10 s timeout | `fleet.rs:168`, `:308-312` |
| `Send(frame)` → nothing, or `SendFailed(frame)` | one `ws.send` of the encoded frame. The hello adds the reporter's report and the heartbeat its lease claims (reads of host state) | `fleet.rs:175-185`, `encode` `:202-229` |
| `Close` | drop the socket | `fleet.rs:187` |
| `Notify(n)` | one `notices.send` to the host | `fleet.rs:191-193`, `notice` `:249-271` |
| `Log(l)` | one `tracing` line | `fleet.rs:195`, `log` `:295-306` |
| inputs | the host channel, `ws.next()` decoded (text or binary JSON → frame; ping, pong or unparseable → `Noise`; close, error or end → `Closed`), or the sleep until `wake_at` → `Tick` | `fleet.rs:146-156`, `decode` `:232-247`, `inbound` `:273-293` |

`inbound` maps an `error` frame to `fatal` (unauthorized, or another protocol version), using nest-protocol's code list. That is a translation of wire vocabulary, not a decision about state.

**Outside the shell (host.rs), unchanged in phase 1:**
- The executor loop (`host.rs:536-540`) and `execute` (`:1310`), which looks up and records `ResultCache` and dispatches.
- The lease watchdog (`:1036`), which calls `lease::check`.

The executor still branches on the cache lookup itself; it moves into a core with the incarnations in phase 2.

### Environment model (FleetDO as nestd sees it)

[`verification/nestd/check/src/fleet.rs`](../../../verification/nestd/check/src/fleet.rs) is a Stateright model. Its nestd side is the real `FleetLink`, stepped exactly as the shell steps it, plus the executor: FIFO, one batch at a time, dedup through the real `ResultCache`. Its FleetDO side follows `fleet.ts` and `reliable.ts`:

- **Durable** (kept across a FleetDO restart):
  - `rel_out`, `next_out` and `last_in`;
  - `commands.result`;
  - `hosts.nestd_instance`;
  - the `kv` orphan capture.
- **Volatile** (lost on a restart): the per-host `SerialQueue`, in-flight `sendResolved` awaits, and sockets with their `helloed` attachment.
- **Handlers.**
  - **`webSocketMessage`:** reads the attachment on arrival; the first frame must be a hello.
  - **`onHello`:** split at each `await`: its synchronous start (supersede other sockets, reset on a new instance, `helloed`, `hello_ack`), the resend (with its own BrokerDO await), and the reconcile that fails the old lineage.
  - **`onEvents`:** classify, `markProcessed`, ack, or gap → error and close.
  - **`issueCommands`:** push, then send at once, or after a BrokerDO await when the batch carries a secret reference.
  - **`ack`:** cumulative.
- **Faults:**
  - a dropped connection (frames in flight lost);
  - a nestd restart (new `instance_id`; core, executor and cache start empty);
  - a FleetDO restart;
  - a BrokerDO failure.
- **Abstractions:**
  - one command per batch, so a seq names a command;
  - results travel up as `events` through the real outbox;
  - FleetDO's event handler never fails;
  - reported sandboxes are not modelled (the `sandbox_create` reconciliation).
- **Reductions:** each one removes only interleavings this model can't observe.
  - FleetDO's heartbeat answer is left out; the lease check covers it.
  - A fresh connection's first timer tick runs in the step that opened it.
  - A hello with nothing to fail ends after its resend.
  - Time moves only for reconnect backoff, so heartbeats run once per connection.
- **Variants:** each FleetDO fix can be turned off on its own (`Config`), and `main` is FleetDO as on `edf6829`.

### Properties

| Property | Kind | Statement |
|---|---|---|
| `no_ack_without_execution` | always | a seq leaves `rel_out` by an ack only if some nestd process ran its command (a reset isn't an ack) |
| `in_order_per_lineage` | always | each process runs (not replays) commands at consecutive seqs from its lineage's first |
| `failed_never_executed` | always | a command FleetDO failed at instance `I`'s hello was never run by a process `≥ I` (exactly one true result) |
| `reconnects_bounded` | always | closes ≤ 3 per fault used + 2: only a loop exceeds it (the boundary stops exploring one step later) |
| `every_command_answered` | eventually | every issued command gets a result. Faults are bounded, so a terminal state has the link up and nothing left to do. Stateright checks `eventually` on terminal paths; the predicate is monotone and every path is finite |
| `answered_after_a_restart`, `answered_after_a_broker_failure` | sometimes | recovery paths exist, so a pass isn't vacuous |
| core invariants | assertion | effects well formed (one connect per step, no send after a close); unacked batches in order; a seq never reused; heartbeat keys increase; commands forwarded in order; the result cache bounded and consistent |

### Results

Each spec is FleetDO's variant, the number of commands (each with or without a secret reference), and the faults: drops, nestd restarts, FleetDO restarts, BrokerDO failures. Times are on a shared WSL2 box at load averages of 100 to 300, 8 threads (4 for the CI tests), and vary 2×.

| Spec | Unique states | Time | Outcome |
|---|---|---|---|
| fixed, 2 cmds, 1 of each fault | 20,698,472 | 38-42 s | holds |
| fixed, 3 cmds, 1 drop | 2,643,116 | 10 s | holds |
| fixed, 2 cmds, 1 drop, 1 restart | 575,951 | 1.2 s | holds |
| fixed, 2 cmds, 1 restart, 1 reset, 1 broker failure | 1,640,221 | 3.5 s | holds |
| main FleetDO + the extracted (pre-fix) nestd core, 3 cmds, no fault (the model before its reductions) | 455,821 | 1.5 s | B1: `no_ack_without_execution` (11 steps), `in_order_per_lineage` (9), `every_command_answered` (19) |
| main FleetDO, 2 cmds, 1 of each fault | 3,701,569 | 4 s | all of the above, plus `failed_never_executed` (16) and `reconnects_bounded` (37) |
| no baseline (a FleetDO older than `next_command_seq`), 2 cmds | 12,229,432 | 23 s | `no_ack` (11), `in_order` (9), liveness (19): the fallback is no worse than main, no better |
| capture after the awaits, 2 cmds | 27,444,541 | 79 s | `failed_never_executed` (16), liveness (20) |
| capture kept in memory only, 2 cmds | 20,489,626 | 49 s | liveness (20) |
| quiet BrokerDO failure, 2 cmds | 6,641,172 | 11 s | liveness (14) |
| no stale-hello guard, 2 cmds, 1 drop | 62,428 | 0.1 s | `reconnects_bounded` (37), liveness (45) |
| no stale-events guard, 2 cmds, 1 restart | 44,875 | 0.1 s | liveness (26) |

`verification/nestd/check/tests/variants.rs` pins the expected outcome of each spec at CI bounds (13 tests, about 16 s). The every-fault run is `#[ignore]`d and runs with `--include-ignored`.

### What it found, and the fixes

- **B1, commands lost by reordering (nestd and FleetDO).**
  - **Mechanism:**
    1. A higher batch overtook a lower one, either because the lower one awaited BrokerDO in `sendResolved`, or because it was issued during onHello's awaits.
    2. nestd forwarded the higher one, then dropped the lower one as "still processing".
    3. The higher one's cumulative ack deleted the lower one: never run, never answered.
  - **Evidence:** reproduced against the extracted core with no fault (11 steps); the replay is a unit test (`a_batch_that_overtakes_a_lower_one_is_a_gap_not_an_ack`).
  - **Fix (nestd):** the core forwards only the expected seq. That is `hello_ack.next_command_seq` (FleetDO's baseline: the lowest unacked seq above the host's `last_command_seq`, else `next_out`, read in the step that resets), raised to one past the last processed, then one past each forwarded batch. Anything else above what it has processed or is processing is a gap: it closes the connection, and the hello resends in order. The fleet contract already said a gap closes the socket ([fleet](../../interfaces/control-host/fleet/)).
  - **Old Worker:** without the field (a FleetDO older than this release), the first batch after the hello is taken. The model shows that fallback is unsound, exactly as before, so the Worker deploys first.
- **Offline `last_command_seq` went backwards (nestd).** A replayed older batch finishing while offline lowered it, so the next hello asked for acked batches, and with a gap check reconnected forever (the study's pilot showed the loop). Now it only rises. Test: `last_processed_never_moves_back_while_offline`.
- **F2, capture race (FleetDO).** onHello captured the old lineage's unanswered commands after its awaits, so a command issued to the new process meanwhile was failed while the new process ran it, and its real result was dropped as redelivered (16 steps). Fix: the capture is taken in the same step as `rel.reset`.
- **F3, capture lost with a FleetDO restart (FleetDO).** The capture is kept in `kv` (`orphaned_commands:<host>`) until failed, and every hello finishes it (20 steps without).
- **F4, quiet BrokerDO failure (FleetDO).** A failed secret resolution left the batch until an unrelated reconnect (14 steps without). It now sends a retryable error and closes (4503).
- **Stale hello (FleetDO; new).**
  - **Mechanism:**
    1. A hello waits in the host's queue while its socket drops.
    2. The host reconnects, and when the stale hello runs it supersedes, so closes, the live socket before that socket's hello_ack.
    3. Under one dropped connection this repeats as long as each stale hello outlasts the host's reconnect delay. The host gets no hello_ack (its lease lapses), and FleetDO's `last_rx` keeps being refreshed.
  - **Fix:** onHello returns at once if its socket isn't open.
  - **Caveats:** the loop's persistence depends on timing the model abstracts. vitest shows a stale hello closing the live socket, not the loop.
- **B3, a dead process's event batch becomes the new lineage's baseline (FleetDO; the study's suspicion, now a 26-step trace).**
  - **Mechanism:**
    1. The batch arrives on the old socket after the new hello is queued.
    2. It runs after the reset as the new lineage's first batch.
    3. The new process's own batch 1 is acked as a duplicate, so its command result is lost.
  - **Fix:** onEvents processes a batch only if its socket is still the host's helloed one.
- **Shedding over-shed rank 1 (nestd, minor).** Rank 1 shed up to the whole original excess even when rank 0 had covered part of it. It now sheds only what's left.

The FleetDO fixes have vitest regressions in [control-plane/test/regressions.test.ts](../../../control-plane/test/regressions.test.ts) (`#28`), each mutation-checked. The nestd fixes have core tests and a WebSocket-level test in [crates/nestd/tests/fleet.rs](../../../crates/nestd/tests/fleet.rs).

### Lease

[`verification/nestd/check/src/lease.rs`](../../../verification/nestd/check/src/lease.rs) composes:
- the real core (the hello and heartbeats, and the renewal each ack makes);
- the real watchdog decision;
- FleetDO's liveness rule: `last_rx` set on receipt; expired once `cp_expiry_ms` old.

Time is abstract: 5 s steps, 70 s explored. Frames are delayed any number of steps (one in flight per direction) or lost with a drop. A suspend stops the monotonic clock for 20 s while real time and `CLOCK_BOOTTIME` run on.

- **`lease_never_outlives_fleetdo` (always):** whenever FleetDO may consider the host expired, nestd's lease has already run out. **Holds** (526,278 states, 0.7 s). `expired_and_fenced` (sometimes) shows the property is reachable, not vacuous.
- **It holds by construction, and the check pins the construction.** A renewal counts from the acked frame's send time, which is no later than FleetDO's receipt, and 20 s < 30 s.
  - Renewing from the ack's arrival instead fails in 11 steps.
  - A watchdog that ignores `CLOCK_BOOTTIME` fails in 7 steps, across a suspend.
- **Assumed:** clock rates agree; the watchdog's 250 ms poll is far inside the 10 s margin.

### Residuals

- A silently half-open socket reads `OPEN`, so the stale-hello guard misses it until the edge notices; one extra reconnect, not a loop.
- After a FleetDO restart between `onCommandResult`'s write and its follow-up DO calls, the follow-ups are lost. That is true of every result, not only this path.
- A restart before `dropUnreported` leaves leases of sandboxes the old process lost until the next new-process hello.
- B5 (a frame an old nestd can't parse is dropped, and a later batch's ack covers it) is not modelled. The gap check now turns it into a reconnect loop instead of a silent loss, which is louder but still needs capability gating.
- The fleet link's events direction is checked only with results as events, and FleetDO's event handler never fails (the study's B4, partial-batch re-application, is out of this model).

## Kani

The proofs are in `crates/nestd-core` behind `#[cfg(kani)]`. Run them with `cargo kani -p nestd-core`: kani-verifier 0.68.0 with CBMC 6.11.0, about 1 min in all, peak about 1.1 GB.

**What was extracted.** Phase 1 moved the decision functions that already existed into [`nestd_core::incarnation`](../../../crates/nestd-core/src/incarnation.rs), unchanged in behaviour. Table-driven tests of today's behaviour came first; then nestd's call sites changed to call them:
- `tombstones.rs`'s comparisons;
- `recovery.rs`'s `meta.json` version verdict and the scan's per-entry decisions;
- `host.rs`'s clean-at-start check, retire backoff, "nothing to salvage" check and `salvage_retryable` (single expressions, plus two constants).

**Harnesses.** Epochs and versions range over all of `u64` unless a bound is given.

| Harness | Property | Bounds | Time |
|---|---|---|---|
| `a_fence_never_lowers_the_tombstone` | the result is at least the old tombstone and the new epoch, and one of them | — | 0.07 s |
| `a_fence_refuses_its_epoch_and_every_older_one` | after fencing e every e' ≤ e is refused; nothing above both is | — | 0.06 s |
| `refusal_is_monotone_in_the_fenced_epoch` | no tombstone refuses nothing; a higher one refuses what a lower one does | — | 0.04 s |
| `a_run_prunes_exactly_the_tombstones_it_gets_past` | a newer epoch running at e prunes only tombstones below e, exactly when they wouldn't refuse e | — | 0.03 s |
| `a_destroy_keeps_every_tombstone_above_it` | a destroy at e never removes a tombstone above e | — | 0.04 s |
| `a_fenced_epoch_stays_refused_until_a_destroy_or_newer_run_reaches_it` | any sequence of fences, destroys and runs | 4 operations | 0.8 s |
| `only_the_current_meta_version_reads_on` | one verdict per input; only the current version reads on | all `u64` pairs | 0.05 s |
| `the_scan_finds_only_its_own_incarnation_and_never_removes_an_unreadable_one` | found only for a meta naming this incarnation; an unreadable meta is kept | — | 0.03 s |
| `a_deleting_entry_is_always_removed` | a name ending `.del` is a deletion whatever its type; only a directory is an incarnation | names ≤ 6 ASCII bytes | 31 s |
| `a_found_incarnation_with_work_is_always_reported` | a dirty disk or an unanswered commit is never deleted unreported | — | 0.02 s |
| `a_final_refusal_ends_the_salvage_and_a_parent_mismatch_never_does` | `parent_mismatch` is always retried; non-retryable and no mismatch is final | — | 0.02 s |
| `the_retire_backoff_grows_to_the_max_and_stays` | from any wait in [1 s, 300 s]: never shrinks or passes 300 s, doubles unless capped, reaches 300 s within 9 steps | any ns in range | 1.6 s |
| `only_a_salvage_of_the_heads_own_disk_is_skipped` | skipped iff a salvage of a disk equal to its head's | — | 0.06 s |
| `the_cache_is_bounded_and_keeps_recent_outcomes` | after every insert: size ≤ cap; map and order hold the same keys once; a never-inserted key has no value; a value is the latest for its key; a key stays while fewer than cap other keys entered since | cap 1-3, 6 inserts, keys 0-3 | 29-41 s |

**Mutation sanity.** Each of these mutations made its harness fail:
- a fence that lowers the tombstone (`max` → `min`);
- pruning at an equal epoch;
- an unreadable meta removed;
- the cache evicting at `len >= cap`.

**Limits.**
- **The cache proof:** Kani doesn't finish over `BTreeMap` and `VecDeque` (a popped `VecDeque` value stalls CBMC), so `ResultCache` is generic over its map and queue. The proof runs the cache's own code over fixed-array stand-ins, which leaves the standard map and FIFO trusted, not proved.
- **The fleet core is too large for Kani:** a harness on the real `FleetLink` (strict command order from the baseline) passed 2 GB in symbolic execution and was dropped. Stateright covers it instead. Kani on it would need the same stand-ins for its `sent` map and `unacked` queue.
- **A possible gap, found while proving:** the scan accepts `007` or `+7` as epoch 7 (`u64` parsing). nestd writes plain decimal names, so it matters only if something else writes there.

## Fuzzing

[`verification/nestd/fuzz/`](../../../verification/nestd/fuzz/README.md) is a cargo-fuzz crate on a pinned nightly.

**Targets:**

| Target | Parser | Production code |
|---|---|---|
| `guest_stream` | the guest frame decoder over arbitrary chunking, which is untrusted input from the VM | `nest_protocol::guest::frame::Decoder`, used by `guest.rs` and the gateway |
| `guest_control_json` | `ControlFrame` JSON | `guest.rs` |
| `vsock_handshake` | the vsock `OK <port>` line | `vsock.rs` |
| `proxy_events` | `fdpass::recv` over a real SEQPACKET pair | `proxy_link.rs` |
| `gateway_events` | the length-delimited codec plus `GatewayEvent` | `gateway_link.rs` |
| `runner_events` | the length-delimited codec plus `RunnerEvent` | `runner_link.rs` |
| `fleet_to_host` | text and binary `FleetToHost` | `fleet.rs` |
| `meta_json` | the real `read_meta`, then `write_meta` | `recovery.rs` |

**Properties checked:**
- no panic, and no OOM at 2 GB;
- chunking-independence;
- encode → decode round trips.

**Local runs (bounded):**
- 10 to 16 min for the guest targets, 3 to 10 min for the others, 0.7M to 52M executions each;
- **no crash, hang or mismatch.**

**Observations:**
- The guest decoder copies the remaining buffer per frame. That is quadratic in what is buffered, but bounded by nestd's 64 KiB reads.
- The link codecs reserve up to `MAX_FRAME` (16 MiB) on a header from a local process.
- An empty packet from nest-proxy reads as EOF.

## Mutation testing

`cargo mutants -p nestd-core` (cargo-mutants 27.1.0; exclusions with reasons in [`.cargo/mutants.toml`](../../../.cargo/mutants.toml)).
- **First run:** 160 mutants; 44 missed.
- **Missed mutants:** 31 were real test gaps, each now caught by a test that names the behaviour it pins. The other 15 are excluded:
  - invariant conditions weakened where no input reaches the difference;
  - a field only the checker's trace printer reads;
  - a release-only hook;
  - an `is_empty` nothing calls;
  - a mutant that only hangs.
- **Final run:** 145 mutants, **0 missed** (140 caught, 5 unviable).
- **After the incarnation module joined** (exclusions also cover the `#[cfg(kani)]` proof code, which `cargo test` never compiles): 192 mutants, **0 missed** (181 caught, 11 unviable), about 2 min.
- **Exclusion pins:** some exclusions are pinned to a line, so a moved line shows up as missed again rather than being silently excluded.

## CI

- **Every PR, existing jobs:**
  - `rust` runs nestd-core's tests and clippy.
  - `guards` runs the purity fence and its tests.
- **New jobs on every PR** (`verify-nestd`, `kani-nestd`, `fuzz-nestd`; times on a runner not yet measured):
  - the checker's tests (`verification/nestd/check`, `cargo test --release`);
  - the Kani proofs;
  - cargo-mutants on nestd-core;
  - a 60 s run per fuzz target.
- **Longer runs** (the every-fault check, longer fuzzing) are in [dev/ci.md](../../../dev/ci.md#verification).

## Phase 2 design

Phase 2 waits for `deferred/brain-record` and PR #28 to merge. Each machine moves out of `host.rs` the way the fleet link did:
1. characterization tests first;
2. the core with its invariants;
3. a shell that only performs effects;
4. a checker that composes the core with a peer model;
5. replayable counterexamples;
6. Kani on its decisions;
7. mutants;
8. shuttle tests where a shell keeps shared-memory concurrency: host.rs's summary and per-sandbox locks, the lock-free pause handles, the fence-on-arrival path that runs beside the executor. The fleet shell needs none: one task owns its state in one `select!` loop.

### Incarnations (`nestd_core::incarnation`)

- **State per `(sandbox, epoch)`:**
  - phase: `Creating → DiskReady → Running ↔ Paused → Suspended | Fenced | Retiring → Gone`;
  - `meta` (durable): head, clean, unanswered;
  - the tombstone (the highest fenced epoch per sandbox);
  - salvage retry state (attempts, next try).
- **Inputs:**
  - commands (create, suspend, resume, checkpoint, archive, fork, destroy, fence);
  - the start scan's findings;
  - outcomes: driver (booted, failed, stopped), disk (synced, copied), store (uploaded, failed), and commit answers (committed, orphaned, rejected with reason, timeout);
  - `Tick` (backoff).
- **Effects:**
  - write `meta` (write-ahead: before the VM runs or a request is sent);
  - create the disk, boot, pause, resume or stop the VM;
  - send `commit_request` (carrying its request id);
  - rename to `.del` and delete;
  - proxy ops and gateway ops;
  - report state, `incarnation_retired` and command results.
- **Durable:** `meta.json` and the directory. A crash keeps exactly those, and the scan rebuilds memory from them.
- **Environment model:**
  - SandboxDO's commit CAS as an oracle (epoch and history; it answers a repeated request id with the stored outcome);
  - a lossy event path;
  - crash and restart (memory lost, files kept, `.del` and `meta.json.tmp` crash points);
  - FleetDO's stale-incarnation reap and its 11 min window;
  - newer-epoch creates.
- **Properties:**
  - **Safety:**
    - a dirty incarnation's work ends as a head, an orphan, or a logged final refusal, and is never deleted otherwise;
    - `clean ⇒ disk = head` (or the base image);
    - `Fenced` is terminal per epoch;
    - no create at or below a tombstone;
    - an older epoch never touches a newer one's row, pause handle or directory;
    - tombstones are pruned only when a newer epoch runs here or a destroy covers them.
  - **Liveness:** every found or fenced dirty incarnation is retired.
- **Expected finding:** the study's incarnation B1 is expected to reproduce: a re-asked non-salvage request answered `stale_epoch` ends the retire without a salvage.
- **Bounds:** one sandbox, epochs 1 to 3, two commits, one crash at each point, one store failure.

### Proxy link

- **Core:** the mirror (policies, listeners, secrets, lease, CA), its `seq`, the snapshot or resync rule (queued ops with `seq <= snapshot_seq` are skipped), listener ownership, and the ping watchdog.
- **Environment:** a proxy peer that acks, drops, reconnects with a new boot id, and wedges.
- **Properties:**
  - the proxy's view converges to the mirror;
  - a fenced epoch is never re-added (tombstones);
  - an fd is passed only with its op;
  - a send never blocks the core: timeouts are effects' outcomes.

### Gateway link

- **Core:** binding keys and per-sandbox entries (epoch, vsock, clients, guest version), present only while running. It gets `upsert`, `forget` (suspend) and `remove` (fence, which tombstones), and replays in full on connect.
- **Environment:** a gateway peer that reconnects, stops reading, or is silent for 15 s.
- **Properties:**
  - a suspended or fenced sandbox is never admitted;
  - no epoch regression;
  - a replay equals the mirror.

### Runner link (brain table)

- **Core:** the brain table (binding, state, the connection its start went out on) on the brain-record design: no replay of a start; on a runner disconnect each brain started on it is reported `crashed` (or `fenced`); a start with no runner is sent once on connect.
- **Environment:** the runner peer, and AgentDO's restart on `agent_exited`.
- **Properties:**
  - at most one start per brain per connection;
  - every started brain is reported exited exactly once when its connection drops;
  - a fenced brain leaves the report at once.

## Open questions

- **Capability gating for new command variants:** the study's B5, so an old nestd never drops an unknown batch. Owned by the fleet contract.
- **Should the checker's every-fault run gate merges?** It does at about a minute on CI hardware, unmeasured; today it runs only with `--include-ignored`.

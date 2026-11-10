# nestd verification

nestd is verified as the code that ships. Each state machine's decisions live in a pure core, and the async code around it is a thin I/O shell. The checks run against the real cores:
- model checking, exhaustive within stated bounds;
- Kani proofs;
- mutation testing.

The parsers at nestd's trust boundaries are fuzzed. TLA+ and Quint stay for design exploration (the [study](../)); they aren't the source of truth for this code.

**Status:**
- **Phase 1 done:** the fleet link (with the executor's dedup and the lease watchdog) is extracted and checked; Kani covers the pure decision functions that exist today; fuzz targets cover every wire parser; runtime assertions are in place.
- **Phase 2 designed, not built** (below): sandbox incarnations, the proxy link, the gateway link and the runner link's brain table.

Evidence tiers ([dev/practices.md](../../../dev/practices.md#evidence-tiers)): every result here is **bounded**. A model check holds for the bounds it names, a Kani proof for its unwind bounds, and a fuzz run for the time it ran. None of it says anything about the real network, the real control plane or real hosts.

## The core/shell split

- **A core** is `step(&mut state, now, input) -> Vec<Effect>`. It lives in `crates/nestd-core`, which has no dependencies at all. What is enforced, and where:
  - **The compiler, in CI.** The `rust` job builds the library for `x86_64-unknown-none`, a target with no `std`, so code that uses `std` there fails to build: a clock, the filesystem, the network, processes, threads, the environment, stdio, an OS-seeded hasher. That covers `extern crate std as s` split over lines and a `#[path]` module that uses `std`. Code compiled only off that target would escape it; the source check below rejects the `cfg` that would do that.
    - The crate is `#![cfg_attr(not(test), no_std)]` with `extern crate alloc`. On the host, `no_std` alone doesn't forbid an explicit `extern crate std`; the no-std target does.
    - It is `#![forbid(unsafe_code)]`.
    - Its unit tests are built with `std`, on the host only.
  - **The manifest and the sources, in CI `plan`.** [scripts/check-core-manifest.py](../../../scripts/check-core-manifest.py) fails on:
    - any dependency table or key in `crates/nestd-core/Cargo.toml` (parsed as TOML: dotted, inline or per target);
    - any build key, `[patch]` or `[replace]`, or a `build.rs`;
    - a `lib.rs` without the `no_std` line;
    - in any source file, an `extern crate` other than `alloc`, a `#[path]` module, `include!`, or a `cfg`, `cfg_attr` or `cfg!` predicate on any `target_*` key.

    It checks the sources with comments stripped and string, byte-string, raw-string and char literals emptied, so neither a commented-out line nor a comment marker inside a literal changes what it sees. Tests prove each case fails.
  - **A text fence**, `nestd-core-purity` ([scripts/fences.toml](../../../scripts/fences.toml)): a line-based third layer over the same names.
  - **Not enforced:** a core could still loop forever, or allocate without bound. Model checking and tests find those, not the build.
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
- **Runtime assertions.** Each core asserts its invariants in the shipped code (`nestd_core::invariant`). A violation panics in debug builds (every test, and the checker, which builds with debug assertions). In release it is never fatal, and the core never logs:
  - inside a fleet step, it is that step's `Log::InvariantViolated { name }` effect, which the shell logs;
  - outside a step (`ResultCache::insert`), it is counted in an atomic that `main.rs` polls every 10 s, logging each rise.

## Machines

| Machine | Core | State | Inputs | Effects | Durable | Phase |
|---|---|---|---|---|---|---|
| Fleet link | `nestd_core::fleet::FleetLink` | connection phase, backoff, token, lease timing, events outbox (pending, unacked, next seq), commands (last processed, forwarded, expected), heartbeat send times | host events, `CommandsDone`, CA renewal, connect outcome, send failure, close, decoded FleetDO frames, noise, `Tick` | connect, send frame, close, notify host, log | none (lineage per process) | 1, done |
| Command dedup | `nestd_core::results::ResultCache` | bounded `cmd → outcome` map | lookup, record | none | none | 1, done |
| Lease watchdog | `nestd_core::lease::check` | the deadline (in host.rs) | what remains of it on each clock | `Expired` (self-fence) or `Valid { recheck_ms }` | none | 1, done (decision only) |
| Proxy CA renewal | `nestd_core::ca::CaRenewal`, `cert_public_key` | the installed key and expiry; a renewal in flight (key, sent at) | a clock (due?), a CSR sent, an answer with the key its certificate names | install the renewal's or the current key, or refuse | none (the pair is in the credentials file, written by the shell) | done (unit tests, mutants, fuzz target `cert_public_key`; a data-structure core with a `names` closure, not a stepped one) |
| Owed detaches | `nestd_core::detach::Detaches` (a data structure, not a stepped machine) | per guest: agent → (ask number, kill) while unconfirmed | ask, confirm (of the newest ask only) | none: the guest connection decides when to send (after each `configure`, before ready; every 10 s while owed; on a repeated `agent_detach`; before an attach of the agent) and keeps owed agents in `configure`; that ordering is checked by `guest.rs` and `tests/host.rs` tests, not modelled | none (memory only: the VM, and its guest, don't outlive nestd). **Constraint on memory restore (not built):** a restored guest outlives the connection that owed it a detach, so restore must carry what is owed, or the first `configure` drops the agent without stopping it | done (unit tests, mutants 0 missed) |
| Unchanged-disk memo | `nestd_core::checkpoint::ScanMemo` | per incarnation: the last stable pass's disk stamp and manifest | a pass (stable or not, with the stamp read after the sentinel), a stamp read before a commit | reuse the manifest, or read the disk | none (memory only) | done (M1) |
| Incarnations | `nestd_core::incarnation` (decisions now; the machine in phase 2) | per `(sandbox, epoch)`: phase, `meta` (head, clean, unanswered), tombstone, salvage retry | commands, driver and store outcomes, commit answers, a scan at start | write meta, boot, pause or stop the VM, send `commit_request`, rename to `.del`, proxy and gateway ops, report | `meta.json`, the directory | 2 |
| Proxy link | phase 2 | mirror, `seq`, listener ownership, resync | proxy frames, connection, timers | send op, resync, pass fds | none | 2 |
| Gateway link | phase 2 | binding keys, per-sandbox entries, pause marks (per sandbox and epoch), tombstones | gateway frames, sandbox upserts/forgets/removes | send op, replay | none | 2 |
| Runner link (brain table) | phase 2 | brains by agent: binding, state, connection | runner frames, `agent_start`/`agent_stop`, connection | send, report `agent_exited` | none | 2 |

## Fleet link (phase 1)

### Shell audit

[`crates/nestd/src/fleet.rs`](../../../crates/nestd/src/fleet.rs) is 327 lines before its tests:
- about 130 are the public types the host uses, plus the `OutboxEvent` instance. That instance only reads an event's kind (`EventKind`: audit with its record count, capacity, egress denied, port opened, other) and appends audit records when the core says to merge;
- about 200 are the loop, the interpreter and the codecs.

The core is 740 lines in [`crates/nestd-core/src/fleet.rs`](../../../crates/nestd-core/src/fleet.rs). It decides shedding and coalescing from the kind, and whether a peer error is fatal from its code (`error_is_fatal`, cross-checked by a nestd test against every code in nest-protocol).

| Effect or input | I/O | Where (in `fleet.rs`) |
|---|---|---|
| `Connect { token }` → `Connected` or `ConnectFailed` | WebSocket upgrade with `Authorization: Bearer`, 10 s timeout | `perform`, `connect` |
| `Send(frame)` → nothing, or `SendFailed(frame)` | one `ws.send` of the encoded frame. The hello adds the reporter's report and the heartbeat its lease claims (reads of host state) | `perform`, `encode` |
| `Close` | drop the socket | `perform` |
| `Notify(n)` | one `notices.send` to the host | `perform`, `notice` |
| `Log(l)` | one `tracing` line, `InvariantViolated` included | `perform`, `log` |
| inputs | the host channel; `ws.next()` through `decode`, a pure public function (text or binary JSON → a frame; ping, pong or unparseable → `Noise`; close, error or end → `Closed`, on which the shell drops its socket); or the sleep until `wake_at` → `Tick` | `Shell::run`, `decode`, `inbound` |

**Outside the shell (host.rs), unchanged in phase 1:**
- The executor loop (in `Host::start`) and `Inner::execute`, which looks up and records `ResultCache` and dispatches.
- `Inner::lease_watchdog`, which calls `lease::check`.

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
  - **`onHello`:** split at each `await`. Its synchronous start does the following: the stale-socket guard, superseding other sockets, the reset and capture on a new instance, the ack of `last_command_seq`, the socket's `sent` mark, `helloed`, `hello_ack`, and enqueuing the resend on the send chain. The reconcile that fails the old lineage comes after the awaits.
  - **The send chain (`flush`):** one per host, never awaited by issuers.
    - A run takes `socketFor(host)` (the first socket that is helloed and open) and sends everything above that socket's `sent` mark, batch by batch in seq order. A batch without secrets goes at once; one with secrets goes after its own BrokerDO answer, if the socket is still the host's.
    - The first BrokerDO failure stops the run and closes the socket; what went before stays sent.
    - The alarm tick starts a run for a connected host whose socket is behind the outbox.
  - **`onEvents`:** the socket must still be the host's helloed one; then classify, `markProcessed` and ack, or on a gap an error and a close.
  - **`issueCommands`:** push, then enqueue a run.
  - **`ack`:** cumulative.
- **Faults:**
  - a dropped connection (frames in flight lost);
  - a nestd restart (new `instance_id`; core, executor and cache start empty);
  - a FleetDO restart;
  - a BrokerDO failure.
- **Abstractions:** each part of fleet.ts the model leaves out, with why, is listed in the model's module docs. In short:
  - one command per batch, so a seq names a command;
  - every command is the same kind, so #30's filter of answered `agent_start`s never applies;
  - results travel up as `events` through the real outbox, and FleetDO's event handler never fails;
  - no wedged hosts, CA renewals or malformed frames: all are closes, which a drop already covers;
  - no sandboxes: `dropUnreported`, the `sandbox_create` reconciliation, `answered_by` and `killProgress` read or write results but never send;
  - an `onCommandResult` throw midway through the failures leaves the `kv` capture for the next hello, which a FleetDO restart already models.
- **Reductions:** each one removes only interleavings this model can't observe.
  - FleetDO's heartbeat answer is left out; the lease check covers it.
  - A fresh connection's first timer tick runs in the step that opened it.
  - A hello with nothing to fail ends after its resend.
  - Time moves only for reconnect backoff, so heartbeats run once per connection.
- **Variants:** each FleetDO fix can be turned off on its own (`Config`), and `main` is FleetDO as on main: none of this work's fixes.

### Properties

| Property | Kind | Statement |
|---|---|---|
| `no_ack_without_execution` | always | a seq leaves `rel_out` by an ack only if some nestd process ran its command (a reset isn't an ack) |
| `in_order_per_lineage` | always | each process runs (not replays) commands at consecutive seqs from its lineage's first |
| `failed_never_executed` | always | a command FleetDO failed at instance `I`'s hello was never run by a process `≥ I` (exactly one true result) |
| `never_a_gap` | always | nestd never meets a command gap: with an in-order sender, any gap would be a reconnect per overtaking batch |
| `finished_never_reforwarded` | always | a batch a process has finished is never handed to its executor again |
| `reconnects_bounded` | always | closes ≤ 3 per fault used, and none without a fault: a loop exceeds it (the boundary stops exploring one step later) |
| `every_command_answered` | eventually | every issued command gets a result. Faults are bounded, so a terminal state has the link up and nothing left to do. Stateright checks `eventually` on terminal paths; the predicate is monotone and every path is finite |
| `answered_after_a_restart`, `answered_after_a_broker_failure` | sometimes | recovery paths exist. A spec whose faults allow one fails if its example is never found, so a pass isn't vacuous |
| core invariants | assertion | effects well formed (one connect per step, no send after a close); unacked batches in order; a seq never reused; heartbeat keys increase; commands forwarded in order; the result cache bounded and consistent |

### Results

Each spec is FleetDO's variant, the number of commands (each with or without a secret reference), and the faults: drops, nestd restarts, FleetDO restarts, BrokerDO failures. The violating variants are the fixed system with one fix removed, at the smallest bounds that show it. Times are on a shared WSL2 box on 4 threads, and vary 2×.

| Spec | Unique states | Time | Outcome |
|---|---|---|---|
| fixed, 2 cmds, 1 of each fault | 12,341,939 | 54 s | holds; both recovery examples found |
| fixed, 3 cmds, 1 drop, 1 broker failure | 6,556,034 | 41 s | holds |
| fixed, 4 cmds, no fault | 62,580 | 0.3 s | holds |
| fixed, 3 cmds, 1 drop | 606,844 | 2.8 s | holds |
| fixed, 2 cmds, 2 drops | 468,204 | 2.0 s | holds |
| fixed, 2 cmds, 1 drop, 1 restart | 477,070 | 1.6 s | holds |
| fixed, 2 cmds, 1 restart, 1 reset, 1 broker failure | 769,847 | 2.7 s | holds |
| an in-order FleetDO without the baseline, 2 cmds, 1 drop, 1 restart | 477,070 | 1.6 s | holds |
| main FleetDO + the extracted (pre-fix) nestd core, 3 cmds, no fault (the first model, before its reductions) | 455,821 | 1.5 s | B1: `no_ack_without_execution` (11 steps), `in_order_per_lineage` (9), `every_command_answered` (19) |
| main FleetDO, 2 cmds, no fault | 2,466 | <0.1 s | `no_ack` (11), `in_order` (9), liveness (14) |
| no send chain (H1), 2 cmds, no fault | 2,721 | <0.1 s | `never_a_gap` (8), `reconnects_bounded` (8) |
| capture after the awaits (F2), 1 cmd, 1 restart | 3,800 | <0.1 s | `failed_never_executed` (17) |
| capture kept in memory only (F3), 1 cmd, 1 restart, 1 reset | 17,039 | <0.1 s | liveness (21) |
| quiet BrokerDO failure (F4) and no tick, 1 cmd, 1 broker failure | 144 | <0.1 s | liveness (10). Either the close or the tick alone recovers it |
| no stale-hello guard, 1 cmd, 1 drop | 3,814 | <0.1 s | `reconnects_bounded` (25), liveness (37) |
| no stale-events guard (B3), 2 cmds, 1 restart | 30,704 | 0.1 s | liveness (30) |

**Mutations of the nestd core the checker catches:**
- an offline `last_command_seq` that goes backwards: `finished_never_reforwarded`, 31 steps at 2 commands and 2 drops;
- the hello's baseline without `.max(last + 1)`: `never_a_gap`, 20 steps at 2 commands and 1 drop;
- `CommandsDone` not moving the expected seq: `never_a_gap`, 20 steps at 2 commands and 1 drop.

`verification/nestd/check/tests/variants.rs` pins the expected outcome of each spec at CI bounds: 15 tests plus the lease and the unchanged-disk memo, about 10 s on 4 threads. The every-fault run is `#[ignore]`d and runs with `--include-ignored`.

### What it found, and the fixes

- **B1, commands lost by reordering (nestd and FleetDO).**
  - **Mechanism:**
    1. A higher batch overtook a lower one, either because the lower one awaited BrokerDO in `sendResolved`, or because it was issued during onHello's awaits.
    2. nestd forwarded the higher one, then dropped the lower one as "still processing".
    3. The higher one's cumulative ack deleted the lower one: never run, never answered.
  - **Evidence:** reproduced against the extracted core with no fault (11 steps); the replay is a unit test (`a_batch_that_overtakes_a_lower_one_is_a_gap_not_an_ack`).
  - **Fix (nestd):** the core forwards only the expected seq. That is `hello_ack.next_command_seq` (FleetDO's baseline: the lowest unacked seq above the host's `last_command_seq`, else `next_out`, read in the step that resets), raised to one past the last processed, then one past each forwarded batch. Anything else above what it has processed or is processing is a gap: it closes the connection, and the hello resends in order. The fleet contract already said a gap closes the socket ([fleet](../../interfaces/control-host/fleet/)).
  - **Old Worker:** without the field (a FleetDO older than this release), the first batch after the hello is taken. Against main's FleetDO, which sends out of order, that fallback is unsound exactly as before, so the Worker deploys first. Against an in-order FleetDO without the field, it holds.
- **H1, FleetDO sent batches out of seq order with no fault (FleetDO; found by the first independent review).**
  - **Mechanism:** three paths put a higher batch on the wire before a lower one:
    1. a batch issued while onHello awaited BrokerDO went out ahead of the hello's resend;
    2. a plain batch overtook one awaiting BrokerDO in `sendResolved`;
    3. two `agent_start`s resolved in either order.
  - **Consequences:** against the new nestd, a reconnect per overtaking batch (a storm risk); against an old nestd, B1.
  - **Evidence:** the checker without the chain fails `never_a_gap` and `reconnects_bounded` in 8 steps with no fault.
  - **Fix (at the source):** one per-host send chain (`flush`) for `issueCommands` and the hello's resend.
    - Each run sends everything above its socket's `sent` mark, batch by batch in seq order. A batch waits only for its own secrets, so a kill ahead of a secret batch is never held back by BrokerDO.
    - Rows and seqs are still written synchronously; only the send moved, and issuers don't wait for it.
    - A run that fails closes its socket.
    - The alarm tick re-runs a host whose socket is behind the outbox.
  - **Tests:** vitest on all three orderings, plus a BrokerDO failure mid-run.
- **The expected seq stayed behind a batch that finished after the hello (nestd; found by the checker once FleetDO sent in order).**
  - **Mechanism:** with one dropped connection, a batch still running at the reconnect finished after the hello, and its ack deleted it from FleetDO's outbox. The resend then started one past it while nestd still expected it: a gap, so a reconnect.
  - **Fix:** `CommandsDone` moves the expected seq past the finished batch.
  - **Test:** replayed as a core test (`a_batch_finished_after_the_hello_moves_the_expected_seq_past_it`); 20 steps without the fix.
- **Offline `last_command_seq` went backwards (nestd).** A replayed older batch finishing while offline lowered it, so the next hello asked for acked batches, and with a gap check reconnected forever (the study's pilot showed the loop). Now it only rises. Test: `last_processed_never_moves_back_while_offline`.
- **F2, capture race (FleetDO).** onHello captured the old lineage's unanswered commands after its awaits, so a command issued to the new process meanwhile was failed while the new process ran it, and its real result was dropped as redelivered (16 steps). Fix: the capture is taken in the same step as `rel.reset`.
- **F3, capture lost with a FleetDO restart (FleetDO).** The capture is kept in `kv` (`orphaned_commands:<host>`) until failed, and every hello finishes it (20 steps without).
- **F4, quiet BrokerDO failure (FleetDO).** A failed secret resolution left the batch until an unrelated reconnect (14 steps without). It now sends a retryable error and closes (4503).
- **Stale hello (FleetDO; new).**
  - **Mechanism:**
    1. A hello waits in the host's queue while its socket drops.
    2. The host reconnects, and when the stale hello runs it supersedes, so closes, the live socket before that socket's hello_ack.
    3. Under one dropped connection this repeats as long as each stale hello outlasts the host's reconnect delay. The host gets no hello_ack (its lease lapses), and FleetDO's `last_rx` keeps being refreshed.
  - **Fix:** onHello returns at once if its socket isn't open (`readyState`).
  - **Caveats:**
    - The loop's persistence depends on timing the model abstracts. vitest shows a stale hello closing the live socket, not the loop.
    - That `readyState` reports `CLOSED` once the peer has closed was observed in the workers test pool. It is unverified on Cloudflare's runtime, and a silently half-open socket reads `OPEN` until the edge notices.
- **B3, a dead process's event batch becomes the new lineage's baseline (FleetDO; the study's suspicion, now a 26-step trace).**
  - **Mechanism:**
    1. The batch arrives on the old socket after the new hello is queued.
    2. It runs after the reset as the new lineage's first batch.
    3. The new process's own batch 1 is acked as a duplicate, so its command result is lost.
  - **Fix:** onEvents processes a batch only if its socket is still the host's helloed one.
- **Shedding over-shed rank 1 (nestd, minor).** Rank 1 shed up to the whole original excess even when rank 0 had covered part of it. It now sheds only what's left.

- **FleetDO's own answers counted as the host's (FleetDO; review M2).**
  - **Mechanism:** the failures written at a new process's hello, and `dropUnreported`'s, were untagged, so `killProgress` read them as the host processing commands.
  - **Fix:** they carry `answered_by = 'fleet'`, and pruning keeps a fleet-answered row on a live host only for a kill.
- **A FleetDO restart before `dropUnreported` (FleetDO; review L5).**
  - **Fix:** the `kv` capture also records, at the reset, the leases the new process doesn't report. A recovery hello drops them too, and a host's death deletes the record.

The FleetDO fixes have vitest regressions in [control-plane/test/regressions.test.ts](../../../control-plane/test/regressions.test.ts) and [retention.test.ts](../../../control-plane/test/retention.test.ts), each mutation-checked. The nestd fixes have core tests and a WebSocket-level test in [crates/nestd/tests/fleet.rs](../../../crates/nestd/tests/fleet.rs).

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

### Unchanged disk (M1, M2)

[`verification/nestd/check/src/sentinel.rs`](../../../verification/nestd/check/src/sentinel.rs) drives the real `ScanMemo` as `host.rs` does, with both kinds of commit. A disk has two one-bit chunks and a modification time that every write moves to a clock tick. The VM runs, is paused, or is gone (a nestd restart, which also empties the memo and drops every cut).
- **A read** (`Inner::scan`), made only with the VM paused or gone: take the memo (`begin`), reuse or read, then as separate steps set the sentinel and record the pass. It may fail after either without recording.
- **A cut** (`Inner::cut_checkpoint`, M2), in one pause: take the memo, reuse or clone, set the sentinel. It is recorded later in the background (`Inner::commit_cut`), after the guest may have written and newer cuts may have been taken. Cuts queue one deep behind the one in flight, a newer one replacing the queued one; a read drops the queued cut ([disk](../../sandbox/state/disk/#m2-a-reflink-cut-in-a-brief-pause-committed-in-the-background)).

- **`a_reused_manifest_is_the_disk` (always):** a reused manifest is the disk's content. **Holds** (4 writes, 4 commits, 1 restart: 12,277 states in 19 ms; 32,002 at 5, 5 and 2).
  - `a_commit_reused_a_manifest` (sometimes) shows the reuse is reached;
  - `a_cut_was_recorded_behind_a_newer_one` (sometimes) shows the overlap passes exist for is reached.
- **It holds by the shell's four rules, and the check pins each:**
  - a write that lands after its time moved, as Firecracker's `Async` io_engine allows across a pause, fails in 6 steps (`Write, Pause, Cut, Land, RecordCut, Cut`). That is why a cut while the VM runs, which needs `Async`, would have to turn the memo off;
  - a shell that calls a running VM's disk stable fails in 5;
  - a read that peeks at the memo (`unchanged`) instead of taking it (`begin`) fails in 10: a pass that fails after its sentinel leaves an older memo, whose stamp the sentinel matches again. A memory suspend whose snapshot couldn't be read reached exactly that state (found in review of #122), so the memo is taken when a pass begins and the sentinel is the pass's last step (`a_failed_pass_leaves_nothing_to_reuse` in `crates/nestd/tests/host.rs`);
  - a cut recorded under the newest pass instead of its own fails in 8 (`Pause, Cut, Resume, Write, Pause, Cut, RecordCut, Read`): the older cut's manifest lands over the sentinel a newer cut set. So the memo hands out passes, and only the newest begun records.
- **Assumed:** every write moves the modification time before its data lands, and only nestd sets the sentinel (the kernel's write path; unverified on a host beyond the tests in `crates/nestd`).

### Shadow cut (M3′)

[`verification/nestd/check/src/shadow.rs`](../../../verification/nestd/check/src/shadow.rs) drives the real `nestd_core::shadow::{normalize, changed}` as `host.rs` does, against a copy-on-write filesystem: five physical blocks with values and reference counts, a two-block disk and its shadow. A write to a block only the disk references overwrites it in place; any other write takes the lowest free block (so freed numbers are reused). A clone makes the shadow reference the disk's blocks over a range.
- **The cut:** read the disk's map, read the shadow's and compare, clone the ranges one at a time (the guest may write between any two steps), read the shadow's map again; then pause, compare the disk's map with that, clone, and check.
- **Property:** when a cut ends, the shadow holds the disk's bytes. It holds: 11,339 states, and 82,984 at `writes=6,cuts=3`.
- **Variant:** `stale-shadow-map` compares with the shadow's map from before its clones, and fails in 8 steps (`Write, ReadDisk, ReadShadowAndCompare, CloneNext, Write, ReadShadowAgain, PauseAndClone, CheckAndResume`). The clone freed the shadow's old block, and the next copy-on-write reused it at the same offset.
- **Also checked:** `live-base`, comparing with the disk's own map from the pre-copy, holds. Every block that map names is shared with the shadow or cloned into it, so it can't be reused.

[`verification/nestd/check/src/shadow_slots.rs`](../../../verification/nestd/check/src/shadow_slots.rs) (`slots`) drives the real `nestd_core::shadow::Shadows` as `host.rs` does: a cut (locked) takes `target()`, dropping the queued cut when both shadows are held, writes its shadow (torn) and then fails or is queued, replacing any queued cut; a commit takes the queued cut and later ends; a suspend drops the queued cut; the guest writes throughout.
- **Property:** a shadow a queued or taken cut names holds that cut's generation in every state (the commit reads it at any moment while it holds it). It holds: 3,862 states, reaching both the drop for room and a cut failing beside a queued cut.
- **Variant:** `unheld-queue`, a queued cut's shadow held only from its read on (#159's first version, where the commit's re-ask came first), fails in 6 steps (`CutBegins, CutEnds, CommitTakes, CutBegins, CutEnds, CutBegins`).

### Residuals

- A silently half-open socket reads `OPEN`, so the stale-hello guard misses it until the edge notices; one extra reconnect, not a loop.
- After a FleetDO restart between `onCommandResult`'s write and its follow-up DO calls, the follow-ups are lost. That is true of every result, not only this path.
- B5 (a frame an old nestd can't parse is dropped, and a later batch's ack covers it) is not modelled. The gap check now turns it into a reconnect loop instead of a silent loss, which is louder but still needs capability gating.
- The fleet link's events direction is checked only with results as events, and FleetDO's event handler never fails (the study's B4, partial-batch re-application, is out of this model).

## Kani

The proofs are in `crates/nestd-core` behind `#[cfg(kani)]`. Run them one at a time with `cargo kani -p nestd-core --harness <module>::proofs::<name> --exact` (for example `incarnation::proofs::the_retire_backoff_grows_to_the_max_and_stays`, or `results::proofs::` for the cache) (kani-verifier 0.68.0, CBMC 6.11.0). Every harness runs shipped code over symbolic inputs.

**What was extracted.** Phase 1 moved the decision functions that already existed into [`nestd_core::incarnation`](../../../crates/nestd-core/src/incarnation.rs), unchanged in behaviour. Table-driven tests of today's behaviour came first; then nestd's call sites changed to call them:
- the tombstone map, `TombstoneMap` (nestd's `Tombstones` only shares one behind its lock; nest-proxy's session keeps its own instance for `sandbox_drop` fences, so the proof covers both);
- `recovery.rs`'s `meta.json` version verdict and the scan's per-entry decisions;
- `host.rs`'s clean-at-start check, retire backoff, "nothing to salvage" check and `salvage_retryable` (single expressions, plus two constants).

Since then, new decisions land there as they are made: `reask_failure_ends_commit` (whether a salvage goes on past a refused re-ask, the fix of the inventory's B1), and `nestd_core::checkpoint`'s memo (M1, new code, not an extraction). M3′ adds `nestd_core::shadow`, also new code: `shadow::proofs::a_cut_never_targets_a_shadow_a_queued_or_taken_cut_names` (any six steps of cuts that queue, fail or drop the queued cut for room, commits that take and end, and drops; about 3 minutes). The comparison itself, `changed`, is checked exhaustively by a unit test over the same small domain a harness would take (`exhaustive_changed_covers_every_differing_offset`: 524,288 map pairs, every offset). A Kani harness of it ran past 40 minutes and 20 GB of CBMC on its growing `Vec`, and was dropped.

Functions of one expression have table tests and no harness of their own; the tombstone harness proves them in use.

**Harnesses.** Epochs range over all of `u64` unless a bound is given. Each was run alone on this box; peak memory is the whole process tree.

| Harness | Property | Bounds | Time | Peak |
|---|---|---|---|---|
| `the_tombstone_map_refuses_a_fenced_epoch_until_a_destroy_or_newer_run_reaches_it` | `TombstoneMap` as `Tombstones` drives it. After a fence of `k@e` and any 4 calls (fence, destroy or run of either sandbox, at any epoch), `k@e` stays refused until a destroy at or above `e` or a run above `e`. A fence keeps the higher epoch; a destroy keeps exactly a tombstone above it, and a run exactly one that refuses it. Other sandboxes are untouched, and `refuses` and `len` agree with the map | 2 sandboxes, 5 calls | 19 s | 0.3 GB |
| `a_deleting_entry_is_always_removed` | a name ending `.del` is a deletion whatever its type; only a directory is an incarnation | names ≤ 6 ASCII bytes | 46 s | 1.0 GB |
| `the_retire_backoff_grows_to_the_max_and_stays` | from any wait in [1 s, 300 s]: never shrinks or passes 300 s, doubles unless capped, reaches 300 s within 9 steps | any ns in range | 4 s | 0.2 GB |
| `reuse_only_of_the_newest_stable_sentinel_pass_with_the_same_stamp` | after any 4 calls (a pass begun; a pass recorded, the newest or an older one, stable or not, with any or no stamp; a forget), a reused manifest is the one the newest pass begun recorded, from a stable pass, with exactly the stamp seen now, which is the sentinel, and the disk is stable now; `begin` reuses exactly what `unchanged` would and leaves nothing behind | stamps of 2 values per field, 2 passes | 3 s | — |
| `a_stable_sentinel_pass_is_reused` | right after a stable sentinel pass, the same stamp reuses it (the first isn't vacuous) | any stamp with the sentinel time | 1 s | — |
| `the_cache_is_bounded_and_keeps_recent_outcomes` | after every insert: size ≤ cap; map and order hold the same keys once; a never-inserted key has no value; a value is the latest for its key; a key stays while fewer than cap other keys entered since | cap 1-3, 6 inserts, keys 0-3 | 60 s | 1.5 GB |

**Mutation sanity.** Each of these mutations made its harness fail:
- `prune_below` using the destroy rule;
- a fence that overwrites the tombstone instead of keeping the higher epoch;
- `refuses` with `<` instead of `<=`;
- the cache evicting at `len >= cap`;
- the memo recording an unstable pass, recording a pass without the sentinel, and recording a pass that is no longer the newest.

**Limits.**
- **The map stand-ins:** Kani doesn't finish over `BTreeMap` and `VecDeque` (a popped `VecDeque` value stalls CBMC; the tombstone harness over the real `BTreeMap` had no verdict after 900 s at 3.2 GB). So `ResultCache` and `TombstoneMap` are generic over their map (and queue), and the proofs run their own code over fixed-array stand-ins. The standard map and FIFO are trusted, not proved.
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
| `fleet_to_host` | text and binary WebSocket messages through the shell's pure `decode` (FleetDO is authenticated, so this is a robustness check, not a trust boundary) | `fleet.rs` `decode` |
| `meta_json` | the real `read_meta`, then `write_meta` | `recovery.rs` |

**Properties checked:**
- no panic, and no OOM at 2 GB;
- chunking-independence;
- encode → decode round trips.

**Local runs (bounded):**
- 10 to 16 min for the guest targets, 3 to 10 min for the others, 0.7M to 52M executions each;
- `fleet_to_host` over the real `decode`: 60 s, 1.5M runs;
- **no crash, hang or mismatch.**

The seeds are built from `protocol/fixtures/` at every run and never committed, so the fixtures stay the only copy.

**Observations:**
- The guest decoder copies the remaining buffer per frame. That is quadratic in what is buffered, but bounded by nestd's 64 KiB reads.
- The link codecs reserve up to `MAX_FRAME` (16 MiB) on a header from a local process.
- An empty packet from nest-proxy reads as EOF.

## Mutation testing

`cargo mutants -p nestd-core` (cargo-mutants 27.1.0; exclusions with reasons in [`.cargo/mutants.toml`](../../../.cargo/mutants.toml)).
- **Now:** 255 mutants, **0 missed** (241 caught, 14 unviable), about 2 min.
- **The first run missed 44 of 160:** 31 were real test gaps, each now caught by a test that names the behaviour it pins. The rest are excluded: invariant conditions weakened where no input reaches the difference, a field only the checker's trace printer reads, a release-only hook, an `is_empty` nothing calls, a mutant that only hangs, and the `#[cfg(kani)]` proof code, which `cargo test` never compiles.
- **Exclusions name a function and a mutation, never a line.** Where a function held both a killable mutant and an equivalent one of the same shape, the equivalent one's expression moved into a function of its own (the invariants' predicates, the heartbeat bookkeeping).

## CI

On every PR that touches their inputs: nestd-core's tests, its no-`std` build and the purity checks; the checker's tests then cargo-mutants (`verify-nestd`); the Kani proofs (`kani-nestd`); a replay of the fuzz seeds and corpus (`fuzz-nestd`). Timed fuzzing runs weekly. Jobs and longer runs: [dev/ci.md](../../../dev/ci.md#verification).

## Phase 2 design

Phase 2 waits for the proxy link's rework (PR #28, open) to merge. Each machine moves out of `host.rs` the way the fleet link did:
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
- **Expected finding:** the study's incarnation B1 (fixed in #62) should reproduce with `reask_failure_ends_commit` reverted: a re-asked non-salvage request answered `stale_epoch` ends the retire without a salvage.
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

- **Capability gating for new command variants:** the study's B5. An old nestd can't parse a new variant. Since phase 1 it no longer loses the batch silently: it skips it as unparseable, the next batch's gap makes it reconnect, and the resend brings the same batch back, so the host takes no further commands until it is upgraded (by code reading). Gating new variants on the hello's capabilities would avoid that. It belongs to the [fleet contract](../../interfaces/control-host/fleet/).

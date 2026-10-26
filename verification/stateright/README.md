# Stateright pilot: FleetDO -> nestd command delivery

A [Stateright](https://github.com/stateright/stateright) (`=0.31.0`) model of the fleet reliable channel's command direction: `issueCommands`, `sendResolved`, `onHello` and ack in `control-plane/src/do/fleet.ts`; `ReliableChannels` in `control-plane/src/lib/reliable.ts`; the `commands` handling, executor and `CommandsDone` in `crates/nestd/src/fleet.rs` and `host.rs`. Report and model-to-code table: [docs/verification/reliable-channels/pilot/](../../docs/verification/reliable-channels/pilot/README.md).

This is a standalone crate with its own empty `[workspace]`. The root workspace lists its members explicitly, so `cargo test --workspace` at the repo root doesn't see it (checked with `cargo metadata`).

## Commands

Run from this directory. Use `--release`, because debug is about 10x slower. Times were measured on a shared WSL2 box and vary by up to 2x.

| Command | What | Time |
|---|---|---|
| `cargo test --release` | 12 tests: the expected outcome of each variant, fix piece and mutation | ~30 s |
| `cargo run --release` | variants a, b, c at full bounds, with shortest counterexamples | ~1.5 min |
| `cargo run --release -- all` | plus every diagnostic and mutation below | ~6 min |
| `cargo run --release -- <id> ...` | the named variants (`c-2drops` runs only when named) | |

## Expected results

Full bounds: 3 commands, each with or without a secret ref, 1 socket drop, 1 nestd restart, 1 FleetDO reset and 1 BrokerDO failure. Steps are the length of the shortest counterexample.

| id | Variant | Unique states | Time | Result |
|---|---|---|---|---|
| `a` | main as coded | 5,953,442 | 10-20 s | violates `no_ack_without_execution` (8 steps), `in_order_per_lineage` (7), `failed_never_executed` (12), `every_command_answered` (12) |
| `a-nofault` | main, no faults | 14,707 | 0.02 s | violates `no_ack` (8), `in_order` (7), liveness (10) |
| `a-hello` | main, no secrets, 1 drop | 3,293 | 0.004 s | violates `no_ack` (8), `in_order` (7), liveness (12) |
| `b` | receiver fix | 12,486,462 | 47 s | holds |
| `c` | sender fix | 7,366,370 | 13-33 s | holds |
| `b-firstbase` | b, baseline from the first batch after hello | 11,510,698 | 33 s | violates `no_ack` (8), `in_order` (7), liveness |
| `b-offline` | b, nestd's offline `last := seq` as coded | 14,086,442 | 45 s | violates `gap_closes_bounded` (39: a reconnect loop), liveness |
| `b-noclose` | b, BrokerDO failure doesn't close | 4,656,808 | 18 s | violates liveness (12) |
| `c-noclose` | c, BrokerDO failure doesn't close | 2,568,714 | 9 s | violates `no_ack` (10), `in_order` (9), liveness (12) |
| `bc-latecapture` | c, pending captured after the awaits | 18,782,632 | 81 s | violates `failed_never_executed` (13), liveness (16) |
| `mut-b` | mutation: a gap drops the batch silently | 6,501,907 | 24 s | violates liveness (17) |
| `mut-c` | mutation: the hello resend joins the chain after the awaits | 6,490,930 | 21 s | violates `no_ack` (9), `in_order` (8), liveness (16) |
| `c-2drops` | c with 2 drops | 46,012,076 | 262 s | holds |

**Properties:**

- `always`:
  - `no_ack_without_execution`
  - `in_order_per_lineage`
  - `failed_never_executed`
  - `gap_closes_bounded` (at most 4 closes caused by a gap or a BrokerDO failure; exploration stops at 5)
- `eventually`: `every_command_answered`.
- Two `sometimes` checks, so a pass isn't vacuous:
  - `recovers_after_broker_fail`
  - `recovers_after_restart`

A liveness counterexample reaches a state with no actions left, so it spends every unused fault budget first. That is why those traces include drops and restarts that don't matter to the failure.

## Layout

| File | What |
|---|---|
| `src/lib.rs` | the model (`Delivery`, `State`, `Action`), `Config` (variant flags, bounds), `check`, `find`, `counterexample`, `describe` |
| `src/main.rs` | variant table and printer |
| `tests/variants.rs` | expected outcomes |

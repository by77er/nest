//! The expected outcome of each check at CI bounds: the fixed system holds (and reaches the
//! recovery examples its faults allow, so a pass isn't vacuous); each fix, removed, fails the
//! property it is there for. `--include-ignored` adds the largest run. Times are on 4 threads.

use nestd_check::fleet::{Config, FleetModel, LIVENESS, SAFETY};
use nestd_check::{check, lease};

const RESTART: &str = "answered_after_a_restart";
const BROKER: &str = "answered_after_a_broker_failure";

fn spec(base: Config, cmds: u8, drops: u8, restarts: u8, resets: u8, broker: u8) -> FleetModel {
    FleetModel { cfg: Config { max_cmds: cmds, ..base.faults(drops, restarts, resets, broker) } }
}

/// No property violated, and every example in `examples` found.
fn holds(m: FleetModel, examples: &[&str]) {
    let o = check(m);
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
    for e in examples {
        assert!(o.examples.contains(e), "no example of {e}: the recovery path it names is never reached ({:?})", o.examples);
    }
}

fn violates(m: FleetModel, props: &[&str]) {
    let o = check(m);
    for p in props {
        assert!(o.violated(p), "expected {p} to fail; violated {:?}", o.violations);
    }
}

#[test]
fn fixed_holds_with_four_commands_and_no_fault() {
    holds(spec(Config::fixed(), 4, 0, 0, 0, 0), &[]);
}

#[test]
fn fixed_holds_with_three_commands_and_a_drop() {
    holds(spec(Config::fixed(), 3, 1, 0, 0, 0), &[]);
}

/// Two drops: a batch replayed at one reconnect finishes after a later one while the second
/// connection is down (what an offline `last_command_seq` that went backwards turns into a
/// re-forward of a finished batch).
#[test]
fn fixed_holds_with_two_commands_and_two_drops() {
    holds(spec(Config::fixed(), 2, 2, 0, 0, 0), &[]);
}

#[test]
fn fixed_holds_with_two_commands_a_drop_and_a_restart() {
    holds(spec(Config::fixed(), 2, 1, 1, 0, 0), &[RESTART]);
}

#[test]
fn fixed_holds_with_two_commands_a_restart_a_fleetdo_reset_and_a_broker_failure() {
    holds(spec(Config::fixed(), 2, 0, 1, 1, 1), &[RESTART, BROKER]);
}

/// Every fault at once (a minute or two).
#[test]
#[ignore]
fn fixed_holds_with_two_commands_and_every_fault() {
    holds(spec(Config::fixed(), 2, 1, 1, 1, 1), &[RESTART, BROKER]);
}

/// H1: without the per-host send chain, a batch issued during the hello's BrokerDO await (or a
/// plain batch behind a secret one) overtakes a lower one with no fault: a reconnect each time.
#[test]
fn without_the_send_chain_batches_overtake_with_no_fault() {
    violates(spec(Config { send_chain: false, ..Config::fixed() }, 2, 0, 0, 0, 0), &["never_a_gap", "reconnects_bounded"]);
}

/// A FleetDO that sends no baseline but sends in order is fine for this nestd.
#[test]
fn an_in_order_fleetdo_without_a_baseline_holds() {
    holds(spec(Config { send_baseline: false, ..Config::fixed() }, 2, 1, 1, 0, 0), &[RESTART]);
}

/// B1 against main's FleetDO: commands acked and never run, with no fault.
#[test]
fn main_fleetdo_loses_commands_with_no_fault() {
    violates(spec(Config::main(), 2, 0, 0, 0, 0), &["no_ack_without_execution", "in_order_per_lineage", LIVENESS]);
}

/// F2: capturing the old lineage after onHello's awaits fails a command the new process runs.
#[test]
fn a_late_capture_fails_a_command_the_new_process_runs() {
    violates(spec(Config { capture_at_reset: false, durable_capture: false, ..Config::fixed() }, 1, 0, 1, 0, 0), &["failed_never_executed"]);
}

/// F3: a capture kept only in memory is lost with a FleetDO restart mid-hello.
#[test]
fn a_volatile_capture_leaves_commands_unanswered() {
    violates(spec(Config { durable_capture: false, ..Config::fixed() }, 1, 0, 1, 1, 0), &[LIVENESS]);
}

/// F4: a quiet BrokerDO failure strands its batch, unless the alarm tick's run rescues it (both
/// are on in the fixed system: either alone suffices here).
#[test]
fn a_quiet_broker_failure_strands_a_batch() {
    violates(spec(Config { close_on_broker_fail: false, tick_flush: false, ..Config::fixed() }, 1, 0, 0, 0, 1), &[LIVENESS]);
    holds(spec(Config { close_on_broker_fail: false, ..Config::fixed() }, 1, 0, 0, 0, 1), &[BROKER]);
}

/// A hello that outlives its socket supersedes the live one, round after round.
#[test]
fn a_stale_hello_loops_reconnects() {
    violates(spec(Config { stale_hello_guard: false, ..Config::fixed() }, 1, 1, 0, 0, 0), &["reconnects_bounded", LIVENESS]);
}

/// B3: a dead process's event batch becomes the new lineage's baseline.
#[test]
fn a_stale_event_batch_loses_a_result() {
    violates(spec(Config { events_socket_guard: false, ..Config::fixed() }, 2, 0, 1, 0, 0), &[LIVENESS]);
}

#[test]
fn safety_names_are_checked() {
    let names: Vec<_> = <FleetModel as stateright::Model>::properties(&FleetModel { cfg: Config::fixed() }).iter().map(|p| p.name).collect();
    for p in SAFETY.iter().chain([&LIVENESS, &RESTART, &BROKER]) {
        assert!(names.contains(p), "{p}");
    }
}

#[test]
fn the_lease_never_outlives_fleetdos_view() {
    let o = check(lease::LeaseModel { cfg: lease::Config { unit_ms: 5_000, horizon: 14, max_drops: 1, max_suspends: 1, suspend_steps: 4, max_in_flight: 1 } });
    assert!(o.violations.is_empty(), "{:?}", o.violations);
    for e in ["expired_and_fenced", "renewed_after_a_suspend"] {
        assert!(o.examples.contains(&e), "no example of {e}: the property would be vacuous");
    }
}

/// The unchanged-disk short-circuit holds as `host.rs` drives the memo, and the reuse is reached
/// (not vacuous); a write that lands after a pause (an `Async` io_engine), or a shell that trusts
/// a running VM, breaks it.
#[test]
fn the_sentinel_holds_with_a_sync_engine_and_fails_without_its_assumptions() {
    use nestd_check::sentinel::{Config, REUSED, SAFETY, SentinelModel};
    let o = check(SentinelModel { cfg: Config::fixed() });
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
    assert!(o.examples.contains(&REUSED), "the reuse is never reached");
    for cfg in [Config { async_engine: true, ..Config::fixed() }, Config { trust_running: true, ..Config::fixed() }] {
        let o = check(SentinelModel { cfg });
        assert!(o.violated(SAFETY), "{cfg:?}: expected {SAFETY} to fail");
    }
}

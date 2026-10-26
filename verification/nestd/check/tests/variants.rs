//! The expected outcome of each check at CI bounds: the fixed system holds; each fix, removed,
//! fails the property it is there for (so a pass isn't vacuous). `--include-ignored` adds the
//! largest run. Bounds: see each spec; times are on 4 threads.

use nestd_check::fleet::{Config, FleetModel, LIVENESS, SAFETY};
use nestd_check::{check, lease};

fn spec(base: Config, cmds: u8, drops: u8, restarts: u8, resets: u8, broker: u8) -> FleetModel {
    FleetModel { cfg: Config { max_cmds: cmds, ..base.faults(drops, restarts, resets, broker) } }
}

fn holds(m: FleetModel) {
    let o = check(m);
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
}

fn violates(m: FleetModel, props: &[&str]) {
    let o = check(m);
    for p in props {
        assert!(o.violated(p), "expected {p} to fail; violated {:?}", o.violations);
    }
}

#[test]
fn fixed_holds_with_three_commands_and_a_drop() {
    holds(spec(Config::fixed(), 3, 1, 0, 0, 0));
}

#[test]
fn fixed_holds_with_two_commands_a_drop_and_a_restart() {
    holds(spec(Config::fixed(), 2, 1, 1, 0, 0));
}

#[test]
fn fixed_holds_with_two_commands_a_restart_a_fleetdo_reset_and_a_broker_failure() {
    holds(spec(Config::fixed(), 2, 0, 1, 1, 1));
}

/// Every fault at once (about 21M states; a minute or two).
#[test]
#[ignore]
fn fixed_holds_with_two_commands_and_every_fault() {
    holds(spec(Config::fixed(), 2, 1, 1, 1, 1));
}

/// B1: main's FleetDO sends out of order and main's nestd covered a lower batch with a higher
/// one's ack; with this branch's nestd and an older FleetDO (no baseline), the first batch after a
/// hello can still overtake: the fallback is no better than before.
#[test]
fn without_a_baseline_a_batch_can_still_be_overtaken() {
    violates(spec(Config { send_baseline: false, ..Config::fixed() }, 2, 0, 0, 0, 0), &["no_ack_without_execution", "in_order_per_lineage", LIVENESS]);
}

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

/// F4: a quiet BrokerDO failure strands its batch.
#[test]
fn a_quiet_broker_failure_strands_a_batch() {
    violates(spec(Config { close_on_broker_fail: false, ..Config::fixed() }, 1, 0, 0, 0, 1), &[LIVENESS]);
}

/// A hello that outlives its socket supersedes the live one, round after round.
#[test]
fn a_stale_hello_loops_reconnects() {
    violates(spec(Config { stale_hello_guard: false, ..Config::fixed() }, 1, 1, 0, 0, 0), &["reconnects_bounded"]);
}

/// B3: a dead process's event batch becomes the new lineage's baseline.
#[test]
fn a_stale_event_batch_loses_a_result() {
    violates(spec(Config { events_socket_guard: false, ..Config::fixed() }, 2, 0, 1, 0, 0), &[LIVENESS]);
}

#[test]
fn safety_names_are_checked() {
    let names: Vec<_> = <FleetModel as stateright::Model>::properties(&FleetModel { cfg: Config::fixed() }).iter().map(|p| p.name).collect();
    for p in SAFETY {
        assert!(names.contains(&p));
    }
}

#[test]
fn the_lease_never_outlives_fleetdos_view() {
    let o = check(lease::LeaseModel { cfg: lease::Config { unit_ms: 5_000, horizon: 14, max_drops: 1, max_suspends: 1, suspend_steps: 4, max_in_flight: 1 } });
    assert!(o.violations.is_empty(), "{:?}", o.violations);
    assert!(o.examples.contains(&"expired_and_fenced"), "the property is reachable, not vacuous");
}

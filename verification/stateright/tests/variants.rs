//! Expected outcome per variant. Violations are found with the shortest-counterexample search
//! (fast, stops at the first hit); "holds" needs the whole space, so those tests use bounds a
//! little smaller than `main` (`cargo run --release` checks the full bounds).

use nest_verify_stateright::{Config, LIVENESS, Receiver, SAFETY, State, check, counterexample, find};

const NO_ACK: &str = "no_ack_without_execution";
const IN_ORDER: &str = "in_order_per_lineage";
const FAILED_EXEC: &str = "failed_never_executed";
const LOOP: &str = "gap_closes_bounded";

/// Seqs that left FleetDO's outbox (acked) without being executed or failed.
fn lost(s: &State) -> Vec<u8> {
    (1..s.next_out).filter(|q| s.outbox & (1 << q) == 0 && (s.executed | s.failed) & (1 << q) == 0).collect()
}

fn violates(cfg: Config, prop: &'static str) -> usize {
    let path = find(cfg, prop).unwrap_or_else(|| panic!("{prop} should be violated"));
    path.len() - 1
}

/// Fixed variants are checked exhaustively with no FleetDO reset (it adds no new interleaving for
/// the ordering fixes; the full run in `main` covers it).
fn quick(cfg: Config) -> Config {
    Config { max_fleet_resets: 0, ..cfg }
}

#[test]
fn a_main_loses_an_acked_command() {
    let path = counterexample(Config::main(), NO_ACK).expect("bug reproduces");
    let last = &path.last().unwrap().0;
    assert!(!lost(last).is_empty(), "a seq is acked but never executed");
    assert!(path.len() - 1 <= 8, "shortest trace is the hello window: {} steps", path.len() - 1);
}

#[test]
fn a_main_violates_order_liveness_and_single_result() {
    violates(Config::main(), IN_ORDER);
    violates(Config::main(), LIVENESS);
    violates(Config::main(), FAILED_EXEC);
}

#[test]
fn a_main_loses_commands_without_any_fault_or_secret() {
    // Only the onHello window (helloed set before the BrokerDO await, resend after it).
    let cfg = Config { secrets: false, ..Config::main().with_faults(0, 0, 0, 0) };
    violates(cfg, NO_ACK);
}

#[test]
fn b_receiver_fix_holds() {
    let o = check(quick(Config::receiver_fix()));
    assert!(o.holds(), "violations: {:?}", o.violations);
    assert_eq!(o.examples.len(), 2, "recovery paths are reachable (not vacuous)");
}

#[test]
fn c_sender_fix_holds() {
    let o = check(quick(Config::sender_fix()));
    assert!(o.holds(), "violations: {:?}", o.violations);
    assert_eq!(o.examples.len(), 2, "recovery paths are reachable (not vacuous)");
}

#[test]
fn b_needs_the_hello_baseline() {
    // Baseline = first batch after hello: a fresh nestd process accepts N+1 first.
    violates(Config { receiver: Receiver::GapFirst, ..Config::receiver_fix() }, NO_ACK);
}

#[test]
fn b_needs_monotone_offline_last() {
    // fleet.rs:190 moves last backwards after a cached replay: a gap-close loop.
    violates(Config { offline_max: false, ..Config::receiver_fix() }, LOOP);
}

#[test]
fn b_and_c_need_a_resend_trigger_after_broker_failure() {
    violates(Config { close_on_broker_fail: false, ..Config::receiver_fix() }, LIVENESS);
    violates(Config { close_on_broker_fail: false, ..Config::sender_fix() }, NO_ACK);
}

#[test]
fn fixes_need_capture_at_reset() {
    let late = Config { capture_at_reset: false, ..Config::sender_fix() };
    // A command issued in the onHello window is failed, then run by the new process.
    violates(late, FAILED_EXEC);
    // A FleetDO reset between rel.reset and the capture: the old lineage is never failed.
    violates(late, LIVENESS);
    assert!(find(Config { max_fleet_resets: 0, ..late }, LIVENESS).is_none());
}

#[test]
fn mutation_gap_dropped_silently_is_caught() {
    violates(Config { mut_gap_silent: true, ..Config::receiver_fix() }, LIVENESS);
}

#[test]
fn mutation_late_hello_resend_is_caught() {
    violates(Config { mut_late_resend: true, ..Config::sender_fix() }, NO_ACK);
}

#[test]
fn safety_names_are_properties() {
    assert_eq!(SAFETY, [NO_ACK, IN_ORDER, FAILED_EXEC]);
}

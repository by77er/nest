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
/// a running VM, one that peeks at the memo instead of taking it before a pass that may fail, or
/// one that records an older cut under a newer cut's pass (M2) breaks it.
#[test]
fn the_sentinel_holds_with_a_sync_engine_and_fails_without_its_assumptions() {
    use nestd_check::sentinel::{Config, OVERLAPPED, REUSED, SAFETY, SentinelModel};
    let o = check(SentinelModel { cfg: Config::fixed() });
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
    assert!(o.examples.contains(&REUSED), "the reuse is never reached");
    assert!(o.examples.contains(&OVERLAPPED), "no cut is ever recorded behind a newer one");
    for cfg in [
        Config { async_engine: true, ..Config::fixed() },
        Config { trust_running: true, ..Config::fixed() },
        Config { keep_on_begin: true, ..Config::fixed() },
        Config { stale_records: true, ..Config::fixed() },
    ] {
        let o = check(SentinelModel { cfg });
        assert!(o.violated(SAFETY), "{cfg:?}: expected {SAFETY} to fail");
    }
}

// --- M3′ option 1: the shadow cut ---------------------------------------------------------------

#[test]
fn the_shadow_cut_leaves_the_shadow_equal_to_the_disk() {
    let o = check(nestd_check::shadow::ShadowModel { cfg: nestd_check::shadow::Config::fixed() });
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
    assert!(o.examples.contains(&"a_cut_cloned_what_a_write_changed_during_the_pre_copy"), "{:?}", o.examples);
}

#[test]
fn comparing_with_the_shadows_map_from_before_its_clones_misses_a_reused_block() {
    let cfg = nestd_check::shadow::Config { stale_shadow_map: true, ..nestd_check::shadow::Config::fixed() };
    let o = check(nestd_check::shadow::ShadowModel { cfg });
    assert!(o.violated("a_cut_leaves_the_shadow_equal_to_the_disk"), "{:?}", o.violations);
}

#[test]
fn a_shadow_a_queued_or_taken_cut_names_holds_that_cut() {
    let o = check(nestd_check::shadow_slots::SlotsModel { cfg: nestd_check::shadow_slots::Config::fixed() });
    assert!(o.violations.is_empty(), "violated {:?} ({} states)", o.violations, o.unique_states);
    for e in ["a_cut_dropped_the_queued_cut_for_room", "a_cut_failed_beside_a_queued_cut"] {
        assert!(o.examples.contains(&e), "no example of {e}: {:?}", o.examples);
    }
}

#[test]
fn a_queued_cuts_shadow_left_unheld_is_written_by_a_newer_cut() {
    let cfg = nestd_check::shadow_slots::Config { unheld_queue: true, ..nestd_check::shadow_slots::Config::fixed() };
    let o = check(nestd_check::shadow_slots::SlotsModel { cfg });
    assert!(o.violated("a_named_shadow_holds_its_cut"), "{:?}", o.violations);
}

#[test]
fn comparing_with_the_disks_map_from_the_pre_copy_also_holds() {
    let cfg = nestd_check::shadow::Config { live_base: true, ..nestd_check::shadow::Config::fixed() };
    let o = check(nestd_check::shadow::ShadowModel { cfg });
    assert!(o.violations.is_empty(), "{:?}", o.violations);
}

// --- The incarnation lifecycle: nestd_core::lifecycle beside a model of the shell ----------------

use nestd_check::incarnation::{self, AGREE, ARCHIVING, FENCED, IncarnationModel, LAPSED, OWN_EPOCH};

const LIFECYCLE_EXAMPLES: [&str; 3] = ["a_suspended_sandbox_ran_again", "an_archive_landed", "a_fence_landed_during_a_boot"];

/// With the three fixes the audit proposed, the shell and the table agree and every property
/// holds, whether a suspend keeps its VM paused or releases it.
#[test]
fn the_fixed_lifecycle_holds() {
    for disk_only in [false, true] {
        let o = check(IncarnationModel { cfg: incarnation::Config { disk_only, ..incarnation::Config::fixed() } });
        assert!(o.violations.is_empty(), "disk_only={disk_only}: violated {:?} ({} states)", o.violations, o.unique_states);
        for e in LIFECYCLE_EXAMPLES {
            assert!(o.examples.contains(&e), "disk_only={disk_only}: no example of {e}: {:?}", o.examples);
        }
    }
}

/// The shell as it is: one property fails per audit finding, and a fenced VM is still stopped.
#[test]
fn todays_lifecycle_has_the_audits_findings() {
    let o = check(IncarnationModel { cfg: incarnation::Config::today() });
    for p in [OWN_EPOCH, ARCHIVING, LAPSED, AGREE] {
        assert!(o.violated(p), "expected {p} to fail; violated {:?} ({} states)", o.violations, o.unique_states);
    }
    assert!(!o.violated(FENCED));
}

/// H-B2: a create at the epoch of a suspended row fences that epoch.
#[test]
fn a_same_epoch_create_fences_its_own_epoch() {
    let o = check(IncarnationModel { cfg: incarnation::Config { refuse_same_epoch: false, ..incarnation::Config::fixed() } });
    assert_eq!(o.violations, [OWN_EPOCH], "that property and no other");
}

/// H-B1: an archive whose commit fails stays `archiving`, and the steps that follow (a
/// checkpoint's pause of the VM the archive paused, another archive) are ones the table refuses.
#[test]
fn a_failed_archive_has_no_exit() {
    let o = check(IncarnationModel { cfg: incarnation::Config { archive_rolls_back: false, ..incarnation::Config::fixed() } });
    assert_eq!(o.violations, [ARCHIVING, AGREE]);
}

/// H-B3: a create executed after the lease lapsed starts a VM.
#[test]
fn a_create_after_a_lapse_starts_a_vm() {
    let o = check(IncarnationModel { cfg: incarnation::Config { admit_checks_lapse: false, ..incarnation::Config::fixed() } });
    assert_eq!(o.violations, [LAPSED]);
}

/// The property about fenced VMs can fail: a resume that didn't check the fence starts a fenced
/// incarnation's VM after the fence stopped it, and nothing stops it again.
#[test]
fn a_resume_that_ignores_the_fence_runs_a_fenced_vm() {
    for disk_only in [false, true] {
        let o = check(IncarnationModel { cfg: incarnation::Config { resume_checks_fence: false, disk_only, ..incarnation::Config::fixed() } });
        assert!(o.violated(FENCED), "disk_only={disk_only}: {:?}", o.violations);
    }
}

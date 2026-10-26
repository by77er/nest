//! Prints the result of each variant: states, time, violated properties, shortest counterexamples.
//! `cargo run --release` runs a, b, c; `-- all` adds the diagnostics and mutations (not c-2drops);
//! `-- <id> ...` runs the named ones.

use nest_verify_stateright::{Config, Receiver, check, counterexample, describe};

pub fn variants() -> Vec<(&'static str, &'static str, Config)> {
    let main = Config::main();
    vec![
        ("a", "main as coded", main),
        ("a-nofault", "main, no drops/restarts/resets/broker failures (pure await reorder)", main.with_faults(0, 0, 0, 0)),
        ("a-hello", "main, no secrets: only the onHello window can reorder", Config { secrets: false, ..main.with_faults(1, 0, 0, 0) }),
        ("b", "receiver fix (gap check + hello_ack baseline + close on broker fail + capture at reset)", Config::receiver_fix()),
        ("c", "sender fix (per-host send chain + close on broker fail + capture at reset)", Config::sender_fix()),
        ("b-firstbase", "b with the baseline taken from the first batch after hello", Config { receiver: Receiver::GapFirst, ..Config::receiver_fix() }),
        ("b-offline", "b with nestd's offline `last := seq` (no max) as coded", Config { offline_max: false, ..Config::receiver_fix() }),
        ("b-noclose", "b without closing on a BrokerDO failure", Config { close_on_broker_fail: false, ..Config::receiver_fix() }),
        ("c-noclose", "c without closing on a BrokerDO failure", Config { close_on_broker_fail: false, ..Config::sender_fix() }),
        ("bc-latecapture", "c without capture at reset (pending captured after the awaits, as main)", Config { capture_at_reset: false, ..Config::sender_fix() }),
        ("mut-b", "mutation of b: a gap drops the batch silently", Config { mut_gap_silent: true, ..Config::receiver_fix() }),
        ("mut-c", "mutation of c: hello resend joins the chain after the awaits", Config { mut_late_resend: true, ..Config::sender_fix() }),
        ("c-2drops", "c with 2 drops (46M states, ~4.5 min)", Config::sender_fix().with_faults(2, 1, 1, 1)),
    ]
}

fn main() {
    let mut only: Vec<String> = std::env::args().skip(1).collect();
    if only.is_empty() {
        only = vec!["a".into(), "b".into(), "c".into()];
    }
    let all = only.iter().any(|o| o == "all");
    for (id, what, cfg) in variants() {
        let named = only.iter().any(|o| o == id);
        if !named && !(all && id != "c-2drops") {
            continue;
        }
        let o = check(cfg);
        println!("== ({id}) {what}");
        println!("   unique states: {}   time: {:.2?}", o.unique_states, o.elapsed);
        if o.holds() {
            println!("   all safety and liveness properties hold; examples found: {:?}", o.examples);
        }
        for name in &o.violations {
            let path = counterexample(cfg, name).expect("violation reproduces");
            println!("   VIOLATED {name} ({} steps):", path.len() - 1);
            print!("{}", describe(&path));
        }
        println!();
    }
}

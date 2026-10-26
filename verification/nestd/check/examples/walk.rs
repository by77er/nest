//! A random walk through the fleet model (`cargo run --release --example walk -- <seed> <spec>`):
//! prints where a long walk ends up, to find paths that never stop changing the state.

use nestd_check::fleet::{Config, FleetModel};
use stateright::Model;

fn main() {
    let mut args = std::env::args().skip(1);
    let mut seed: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let cfg = Config { max_cmds: 2, max_drops: 1, max_restarts: 0, max_fleet_resets: 0, max_broker_fails: 0, ..Config::fixed() };
    let m = FleetModel { cfg };
    let mut s = m.init_states().remove(0);
    let mut trail = vec![];
    for _ in 0..3000 {
        let mut acts = vec![];
        m.actions(&s, &mut acts);
        if acts.is_empty() {
            break;
        }
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let a = acts[(seed >> 33) as usize % acts.len()].clone();
        trail.push(format!("{a:?}"));
        s = m.next_state(&s, a).expect("a next state");
    }
    println!("steps {} closes {} t {} wires {} next_wire {}", trail.len(), s.closes, s.nestd.t, s.wires.len(), s.next_wire);
    println!("{:?}", &trail[trail.len().saturating_sub(30)..]);
    println!("{:?}", s.fleet);
    println!("{:?}", s.wires);
    println!("{:?}", s.nestd.link);
}

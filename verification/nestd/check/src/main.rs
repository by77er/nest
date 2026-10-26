//! `cargo run --release -- <spec> ...` checks each spec and prints the shortest counterexample for
//! every violated property. A spec is a FleetDO variant with optional bounds:
//! `fixed`, `main`, `no-baseline`, `late-capture`, `volatile-capture`, `broker-quiet`, then any of
//! `,cmds=N`, `,drops=N`, `,restarts=N`, `,resets=N`, `,broker=N`, `,secrets=0`.
//! Example: `fixed,cmds=2,drops=1`.

use nestd_check::fleet::{Config, FleetModel, describe};
use nestd_check::{check, counterexample};

fn parse(spec: &str) -> Result<Config, String> {
    let mut parts = spec.split(',');
    let base = parts.next().unwrap_or_default();
    let fixed = Config::fixed();
    let mut cfg = match base {
        "fixed" => fixed,
        "main" => Config::main(),
        "no-baseline" => Config { send_baseline: false, ..fixed },
        "late-capture" => Config { capture_at_reset: false, durable_capture: false, ..fixed },
        "volatile-capture" => Config { durable_capture: false, ..fixed },
        "broker-quiet" => Config { close_on_broker_fail: false, ..fixed },
        other => return Err(format!("unknown variant {other}")),
    };
    for p in parts {
        let (k, v) = p.split_once('=').ok_or(format!("bad bound {p}"))?;
        let n: u8 = v.parse().map_err(|_| format!("bad number in {p}"))?;
        match k {
            "cmds" => cfg.max_cmds = n,
            "drops" => cfg.max_drops = n,
            "restarts" => cfg.max_restarts = n,
            "resets" => cfg.max_fleet_resets = n,
            "broker" => cfg.max_broker_fails = n,
            "secrets" => cfg.secrets = n != 0,
            _ => return Err(format!("unknown bound {k}")),
        }
    }
    Ok(cfg)
}

fn main() {
    let specs: Vec<String> = std::env::args().skip(1).collect();
    for spec in &specs {
        let cfg = match parse(spec) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(2);
            }
        };
        let o = check(FleetModel { cfg });
        println!("{spec}: {} states in {:.1?}; violated {:?}; examples {:?}", o.unique_states, o.elapsed, o.violations, o.examples);
        for v in &o.violations {
            if let Some(path) = counterexample(&|| FleetModel { cfg }, v) {
                println!("  {v} ({} steps):\n{}", path.len() - 1, describe(&path));
            }
        }
    }
}

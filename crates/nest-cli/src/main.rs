//! `nest`: one binary for
//! - `nest hook [--sync]` — every Claude Code hook (host side; see docs/interfaces/host-internal/runner-hooks/);
//! - `nest mcp` — the stdio MCP server Claude Code spawns (host side; runner-mcp/);
//! - `nest notify|emit|ask|expose|unexpose|whoami` — commands for programs inside a sandbox,
//!   relayed by the guest agent (docs/interfaces/host-guest/).

mod guest_cli;
mod hook;
mod mcp;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("hook") => hook::main(&args[1..]),
        Some("mcp") => mcp::main(),
        Some("expose" | "unexpose" | "whoami") => guest_cli::main(&args),
        Some("--version") => {
            println!("nest {}", env!("CARGO_PKG_VERSION"));
            0
        }
        _ => {
            eprintln!(
                "usage: nest hook [--sync] | nest mcp\n       nest expose|unexpose <port>\n       nest whoami"
            );
            2
        }
    };
    std::process::exit(code);
}

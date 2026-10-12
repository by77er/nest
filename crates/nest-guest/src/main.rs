use std::path::PathBuf;
use std::time::Duration;

use nest_guest::{Config, ListenSpec};

const USAGE: &str = "usage: nest-guest [--listen vsock|unix:<dir>] [--state-dir DIR] [--cgroup-root DIR|none] \
                     [--cli-socket PATH|none] [--port-poll-ms N] [--run-as UID:GID|none]";

fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_writer(std::io::stderr)
        .init();
    let mut args = std::env::args().skip(1);
    let mut config = Config::for_listen(ListenSpec::Vsock);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or_else(|| anyhow::anyhow!("{a} needs a value\n{USAGE}"));
        match a.as_str() {
            "--listen" => {
                let v = val()?;
                config.listen = ListenSpec::parse(&v).ok_or_else(|| anyhow::anyhow!("bad --listen {v}\n{USAGE}"))?;
            }
            "--state-dir" => config.state_dir = PathBuf::from(val()?),
            "--cgroup-root" => config.cgroup_root = none_or(val()?).map(PathBuf::from),
            "--cli-socket" => config.cli_socket = none_or(val()?).map(PathBuf::from),
            "--port-poll-ms" => config.port_poll = Duration::from_millis(val()?.parse()?),
            "--run-as" => {
                config.run_as = match none_or(val()?) {
                    None => None,
                    Some(v) => {
                        let (u, g) = v.split_once(':').ok_or_else(|| anyhow::anyhow!("--run-as UID:GID"))?;
                        Some((u.parse()?, g.parse()?))
                    }
                }
            }
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            other => anyhow::bail!("unknown argument {other}\n{USAGE}"),
        }
    }
    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        let running = nest_guest::start(config).await?;
        running.wait().await;
        anyhow::Ok(())
    })
}

fn none_or(v: String) -> Option<String> {
    (v != "none").then_some(v)
}

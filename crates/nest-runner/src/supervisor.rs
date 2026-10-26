//! The nestd connection: brain lifecycle commands in, lifecycle events out. Losing nestd or the
//! lease kills every brain (nestd re-issues `agent_start` after it reconnects).

use std::sync::Arc;
use std::time::Duration;

use nest_protocol::host::PROTOCOL_VERSION;
use nest_protocol::host::runner::{ExitReason, RunnerCommand, RunnerEvent, StopMode};
use tokio::net::UnixStream;

use crate::agent;
use crate::framing;
use crate::runtime::{AgentCmd, Runtime, now_ms};

/// Connect to nestd forever.
pub async fn run(rt: Arc<Runtime>) {
    loop {
        match UnixStream::connect(&rt.cfg.nestd_sock).await {
            Ok(s) => {
                tracing::info!("connected to nestd");
                connection(rt.clone(), s).await;
                tracing::warn!("nestd connection lost; killing every brain");
                *rt.lease.lock().unwrap() = None;
                rt.kill_all(ExitReason::Fenced);
            }
            Err(e) => tracing::debug!("nestd connect {}: {e}", rt.cfg.nestd_sock.display()),
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

async fn connection(rt: Arc<Runtime>, stream: UnixStream) {
    let generation = rt.conn_gen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let (mut rd, mut wr) = stream.into_split();
    let hello = RunnerEvent::Hello { protocol_version: PROTOCOL_VERSION, runner_version: env!("CARGO_PKG_VERSION").into(), pid: std::process::id() };
    if framing::write_host(&mut wr, &hello).await.is_err() {
        return;
    }
    let writer = {
        let rt = rt.clone();
        tokio::spawn(async move {
            let mut rx = rt.to_nestd_rx.lock().await;
            while let Some((g, ev)) = rx.recv().await {
                if g != generation {
                    // About a brain of an earlier connection (killed when it was lost); this
                    // connection's nestd re-issued what it wants running.
                    tracing::debug!(?ev, "dropping event from an earlier nestd connection");
                    continue;
                }
                if let Err(e) = framing::write_host(&mut wr, &ev).await {
                    tracing::warn!("write to nestd: {e}");
                    break;
                }
            }
        })
    };
    loop {
        let raw = match framing::read_host_raw(&mut rd).await {
            Ok(Some(b)) => b,
            Ok(None) => break,
            Err(e) => {
                tracing::warn!("read from nestd: {e}");
                break;
            }
        };
        match serde_json::from_slice::<RunnerCommand>(&raw) {
            Ok(cmd) => handle(&rt, cmd),
            Err(e) => {
                // Version skew: skip it rather than dropping the link (which kills every brain).
                tracing::warn!("undecodable command from nestd: {e}");
                rt.report(RunnerEvent::Error {
                    agent: None,
                    error: nest_protocol::model::ErrorBody { code: "invalid_message".into(), message: e.to_string(), retryable: false },
                });
            }
        }
    }
    writer.abort();
}

pub fn handle(rt: &Arc<Runtime>, cmd: RunnerCommand) {
    match cmd {
        RunnerCommand::HelloAck { host_id, host_role, .. } => {
            tracing::info!(%host_id, ?host_role, "nestd hello_ack");
            *rt.host_id.lock().unwrap() = Some(host_id);
        }
        RunnerCommand::HostToken { token, .. } => {
            rt.host_token.send_replace(Some(token));
        }
        RunnerCommand::LeaseUpdate { valid_until_ms } => *rt.lease.lock().unwrap() = Some(valid_until_ms),
        RunnerCommand::AgentStart(start) => agent::start(rt.clone(), *start),
        RunnerCommand::AgentStop { agent, mode: StopMode::Kill, reason, epoch: Some(epoch) } => {
            // A kill names the agent epoch it is for: it ends a brain at or below it, never a newer
            // one, and a start at or below it that hasn't registered yet never will.
            tracing::info!(%agent, %reason, epoch = epoch.0, "agent_stop (kill)");
            if let Some(a) = rt.tombstone(&agent, epoch) {
                a.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
                a.kill_now(ExitReason::Stopped);
            }
        }
        RunnerCommand::AgentStop { agent, mode, reason, .. } => {
            tracing::info!(%agent, ?mode, %reason, "agent_stop");
            if let Some(a) = rt.agent(&agent) {
                a.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
                match mode {
                    StopMode::Kill => a.kill_now(ExitReason::Stopped),
                    StopMode::Graceful if a.pid.load(std::sync::atomic::Ordering::SeqCst) == 0 => {
                        // Still starting: nothing to finish gracefully.
                        a.kill_now(ExitReason::Stopped)
                    }
                    StopMode::Graceful => a.command(AgentCmd::Stop(mode)),
                }
            }
        }
        RunnerCommand::Fence { agents, reason } => {
            tracing::warn!(?agents, %reason, "fence");
            if agents.is_empty() {
                rt.kill_all(ExitReason::Fenced);
            } else {
                for id in agents {
                    if let Some(a) = rt.agent(&id) {
                        a.kill_now(ExitReason::Fenced);
                    }
                }
            }
        }
        RunnerCommand::Ping { nonce } => rt.report(RunnerEvent::Pong { nonce, agents: rt.agents().len() as u32 }),
    }
}

/// Kill every brain as soon as the lease mirror lapses.
pub async fn lease_watchdog(rt: Arc<Runtime>) {
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    loop {
        tick.tick().await;
        let lapsed = {
            let mut l = rt.lease.lock().unwrap();
            match *l {
                Some(v) if now_ms() > v => {
                    *l = None;
                    true
                }
                _ => false,
            }
        };
        if lapsed {
            tracing::warn!("host lease lapsed; killing every brain");
            rt.kill_all(ExitReason::Fenced);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[tokio::test]
    async fn skips_undecodable_commands_and_drops_events_of_earlier_connections() {
        let rt = Runtime::new(Config::default());
        // An event queued under an earlier connection generation.
        rt.to_nestd.send((0, RunnerEvent::Pong { nonce: 1, agents: 0 })).unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        tokio::spawn(connection(rt.clone(), ours));
        let (mut rd, mut wr) = theirs.into_split();
        let hello: RunnerEvent = framing::read_host(&mut rd).await.unwrap().unwrap();
        assert!(matches!(hello, RunnerEvent::Hello { .. }));
        // Garbage, then a valid ping: the link survives and answers.
        framing::write_host(&mut wr, &serde_json::json!({"type": "from_the_future", "x": 1})).await.unwrap();
        framing::write_host(&mut wr, &RunnerCommand::Ping { nonce: 7 }).await.unwrap();
        let mut seen = Vec::new();
        for _ in 0..2 {
            let ev: RunnerEvent = tokio::time::timeout(Duration::from_secs(5), framing::read_host(&mut rd)).await.unwrap().unwrap().unwrap();
            seen.push(ev);
        }
        assert!(matches!(&seen[0], RunnerEvent::Error { error, .. } if error.code == "invalid_message"), "{seen:?}");
        assert!(matches!(seen[1], RunnerEvent::Pong { nonce: 7, .. }), "the stale pong (nonce 1) was dropped: {seen:?}");
    }
}

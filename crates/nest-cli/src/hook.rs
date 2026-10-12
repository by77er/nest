//! `nest hook [--sync]`: reads the Claude Code hook input on stdin. **Always exits 0.**
//!
//! - async (tracking): one non-blocking `HookDatagram` to `NEST_HOOK_DGRAM`; on failure, one line
//!   appended to `NEST_HOOK_SPOOL`.
//! - `--sync` (decisions): one `HookDecisionRequest` frame on `NEST_HOOK_SOCK`, print the
//!   response's `output`. If the runner is unreachable or slow (8 s), print the spec'd fallback
//!   (deny for `PreToolUse`/`PermissionRequest`, nothing for `SessionStart`/`Stop`).

use std::io::{Read, Write};
use std::os::unix::net::{UnixDatagram, UnixStream};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use nest_protocol::host::hook::{self, HookDatagram, HookDecisionRequest, HookDecisionResponse, HookOutput, MAX_DATAGRAM};
use nest_protocol::host::{env, frame, paths};
use nest_protocol::model::AgentId;
use serde_json::Value;

/// Total budget for a sync decision (the managed settings give these hooks 10 s).
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(8);
/// `SessionStart` reads the repo's CLAUDE.md through hands (runner budget 8 s); the managed
/// settings give it 20 s, so wait longer than the runner does.
pub const SESSION_START_TIMEOUT: Duration = Duration::from_secs(18);

pub fn main(args: &[String]) -> i32 {
    let sync = args.iter().any(|a| a == "--sync");
    let mut raw = String::new();
    let _ = std::io::stdin().read_to_string(&mut raw);
    let input: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let agent = AgentId(std::env::var(env::AGENT_ID).unwrap_or_else(|_| "agt_unknown".into()));
    if sync {
        let sock = std::env::var(env::HOOK_SOCK).unwrap_or_else(|_| paths::HOOK_SOCK.into());
        let event = input.get("hook_event_name").and_then(Value::as_str).unwrap_or_default().to_string();
        let timeout = if event == "SessionStart" { SESSION_START_TIMEOUT } else { SYNC_TIMEOUT };
        let output = decide(&sock, agent, input, timeout).unwrap_or_else(|e| {
            eprintln!("nest hook: runner unavailable ({e}); using fallback for {event}");
            hook::fallback_output(&event).unwrap_or_default()
        });
        if output != HookOutput::default() {
            let mut out = std::io::stdout().lock();
            let _ = serde_json::to_writer(&mut out, &output);
            let _ = out.write_all(b"\n");
        }
    } else {
        let dgram = std::env::var(env::HOOK_DGRAM).unwrap_or_else(|_| paths::HOOK_DGRAM.into());
        let spool = std::env::var(env::HOOK_SPOOL).ok();
        track(&dgram, spool.as_deref(), agent, input);
    }
    0
}

fn decide(sock: &str, agent: AgentId, input: Value, timeout: Duration) -> std::io::Result<HookOutput> {
    let mut s = UnixStream::connect(sock)?;
    s.set_write_timeout(Some(Duration::from_secs(2)))?;
    s.set_read_timeout(Some(timeout))?;
    frame::write(&mut s, &HookDecisionRequest { v: 1, agent, input })?;
    match frame::read::<_, HookDecisionResponse>(&mut s)? {
        Some(r) => Ok(r.output),
        None => Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "runner closed without answering")),
    }
}

fn track(dgram: &str, spool: Option<&str>, agent: AgentId, input: Value) {
    let ts_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let (input, truncated) = fit(input);
    let d = HookDatagram { v: 1, agent, ts_ms, input, truncated };
    let bytes = serde_json::to_vec(&d).unwrap_or_default();
    let sent = UnixDatagram::unbound()
        .and_then(|s| {
            s.set_nonblocking(true)?;
            s.send_to(&bytes, dgram)
        })
        .is_ok();
    if !sent && let Some(p) = spool {
        let _ = std::fs::OpenOptions::new().create(true).append(true).open(p).and_then(|mut f| {
            let mut line = bytes;
            line.push(b'\n');
            f.write_all(&line)
        });
    }
}

/// Shrink long strings until the datagram fits [`MAX_DATAGRAM`] (envelope included).
pub fn fit(mut input: Value) -> (Value, bool) {
    const ENVELOPE: usize = 512;
    let size = |v: &Value| serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX);
    if size(&input) + ENVELOPE <= MAX_DATAGRAM {
        return (input, false);
    }
    let mut limit = 16 * 1024;
    while limit >= 16 {
        truncate_strings(&mut input, limit);
        if size(&input) + ENVELOPE <= MAX_DATAGRAM {
            return (input, true);
        }
        limit /= 2;
    }
    // Pathological (huge arrays of short strings): keep only the event identity.
    let keep = ["hook_event_name", "session_id", "tool_name", "tool_use_id"];
    let slim: serde_json::Map<String, Value> =
        input.as_object().map(|m| m.iter().filter(|(k, _)| keep.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    (Value::Object(slim), true)
}

fn truncate_strings(v: &mut Value, limit: usize) {
    match v {
        Value::String(s) if s.len() > limit => {
            let mut cut = limit;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            s.truncate(cut);
            s.push_str("…[truncated]");
        }
        Value::Array(a) => a.iter_mut().for_each(|x| truncate_strings(x, limit)),
        Value::Object(m) => m.values_mut().for_each(|x| truncate_strings(x, limit)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn fit_truncates_large_fields() {
        let big = json!({"hook_event_name": "PostToolUse", "tool_response": {"stdout": "x".repeat(200_000)}});
        let (v, t) = fit(big);
        assert!(t);
        assert!(serde_json::to_vec(&v).unwrap().len() < MAX_DATAGRAM);
        assert_eq!(v["hook_event_name"], "PostToolUse");
        let (v, t) = fit(json!({"hook_event_name": "Stop"}));
        assert!(!t && v["hook_event_name"] == "Stop");
    }
}

//! `nest mcp`: the stdio MCP server Claude Code spawns. Newline-delimited JSON-RPC on stdio;
//! every `tools/list` / `tools/call` is forwarded to the runner (`NEST_MCP_SOCK`). No tool logic,
//! no credentials.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::host::mcp::{McpBridgeRequest, McpBridgeResponse, ToolCallResult};
use nest_protocol::host::{env, frame, paths};
use nest_protocol::model::AgentId;
use serde_json::{Value, json};

/// MCP protocol revision we answer with when the client doesn't ask for one.
pub const DEFAULT_PROTOCOL: &str = "2025-06-18";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    List,
    Call,
}

struct Pending {
    rpc_id: Value,
    kind: Kind,
}

/// The runner connection; (re)opened lazily on the next request after it drops.
struct Bridge {
    sock: String,
    agent: AgentId,
    stream: Option<UnixStream>,
}

impl Bridge {
    fn get(&mut self, shared: &Shared) -> Option<&mut UnixStream> {
        if !shared.connected.load(Ordering::SeqCst) {
            self.stream = None;
            match connect(&self.sock, &self.agent, shared) {
                Ok(s) => self.stream = Some(s),
                Err(e) => eprintln!("nest mcp: runner unavailable: {e}"),
            }
        }
        self.stream.as_mut()
    }
}

#[derive(Clone)]
struct Shared {
    out: Arc<Mutex<std::io::Stdout>>,
    pending: Arc<Mutex<HashMap<u64, Pending>>>,
    /// JSON-RPC id (as a string) → bridge id, for `notifications/cancelled`; removed on completion.
    by_rpc: Arc<Mutex<HashMap<String, u64>>>,
    connected: Arc<AtomicBool>,
}

impl Shared {
    fn send(&self, v: &Value) {
        let mut o = self.out.lock().unwrap();
        let _ = serde_json::to_writer(&mut *o, v);
        let _ = o.write_all(b"\n");
        let _ = o.flush();
    }

    fn result(&self, id: &Value, result: Value) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    fn error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }
}

pub fn main() -> i32 {
    let agent = AgentId(std::env::var(env::AGENT_ID).unwrap_or_else(|_| "agt_unknown".into()));
    let sock = std::env::var(env::MCP_SOCK).unwrap_or_else(|_| paths::MCP_SOCK.into());
    let shared = Shared {
        out: Arc::new(Mutex::new(std::io::stdout())),
        pending: Default::default(),
        by_rpc: Default::default(),
        connected: Default::default(),
    };
    let next = AtomicU64::new(1);
    let mut bridge = Bridge { sock, agent, stream: None };

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                shared.send(&json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": e.to_string()}}));
                continue;
            }
        };
        let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match (method, id) {
            ("initialize", Some(id)) => {
                let _ = bridge.get(&shared);
                let version = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(DEFAULT_PROTOCOL);
                shared.result(
                    &id,
                    json!({
                        "protocolVersion": version,
                        "capabilities": {"tools": {"listChanged": true}},
                        "serverInfo": {"name": "nest", "version": env!("CARGO_PKG_VERSION")},
                    }),
                );
            }
            ("ping", Some(id)) => shared.result(&id, json!({})),
            ("tools/list", Some(id)) => {
                let bid = next.fetch_add(1, Ordering::SeqCst);
                forward(&shared, &mut bridge, bid, id, Kind::List, &McpBridgeRequest::ToolsList { id: bid });
            }
            ("tools/call", Some(id)) => {
                let bid = next.fetch_add(1, Ordering::SeqCst);
                shared.by_rpc.lock().unwrap().insert(id.to_string(), bid);
                let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                let tool_use_id = tool_use_id_from_meta(params.get("_meta"));
                forward(&shared, &mut bridge, bid, id, Kind::Call, &McpBridgeRequest::ToolsCall { id: bid, name, arguments, tool_use_id });
            }
            ("notifications/cancelled", None) => {
                let rid = params.get("requestId").map(|v| v.to_string()).unwrap_or_default();
                let bid = shared.by_rpc.lock().unwrap().remove(&rid);
                if let (Some(bid), Some(s)) = (bid, bridge.stream.as_mut()) {
                    let _ = frame::write(s, &McpBridgeRequest::Cancel { id: bid });
                }
            }
            (_, None) => {} // other notifications
            (m, Some(id)) => shared.error(&id, -32601, &format!("method not found: {m}")),
        }
    }
    0
}

/// Connect, say hello, wait for `hello_ack`, start the response reader.
fn connect(sock: &str, agent: &AgentId, shared: &Shared) -> std::io::Result<UnixStream> {
    let mut s = UnixStream::connect(sock)?;
    frame::write(&mut s, &McpBridgeRequest::Hello { v: 1, agent: agent.clone() })?;
    let mut r = s.try_clone()?;
    r.set_read_timeout(Some(Duration::from_secs(10)))?;
    match frame::read::<_, McpBridgeResponse>(&mut r)? {
        Some(McpBridgeResponse::HelloAck { .. }) => {}
        Some(McpBridgeResponse::Error { error, .. }) => return Err(std::io::Error::other(format!("{}: {}", error.code, error.message))),
        other => return Err(std::io::Error::other(format!("unexpected {other:?}"))),
    }
    r.set_read_timeout(None)?;
    shared.connected.store(true, Ordering::SeqCst);
    let sh = shared.clone();
    std::thread::spawn(move || {
        while let Ok(Some(m)) = frame::read::<_, McpBridgeResponse>(&mut r) {
            deliver(&sh, m);
        }
        sh.connected.store(false, Ordering::SeqCst);
        // Fail everything still waiting.
        for (_, p) in sh.pending.lock().unwrap().drain() {
            fail(&sh, &p, "nest runner disconnected");
        }
    });
    Ok(s)
}

fn forward(shared: &Shared, bridge: &mut Bridge, bid: u64, rpc_id: Value, kind: Kind, req: &McpBridgeRequest) {
    let pending = Pending { rpc_id, kind };
    let Some(s) = bridge.get(shared) else {
        fail(shared, &pending, "nest runner unavailable");
        return;
    };
    shared.pending.lock().unwrap().insert(bid, pending);
    if let Err(e) = frame::write(s, req)
        && let Some(p) = shared.pending.lock().unwrap().remove(&bid)
    {
        fail(shared, &p, &format!("nest runner unavailable: {e}"));
    }
}

fn fail(shared: &Shared, p: &Pending, msg: &str) {
    shared.by_rpc.lock().unwrap().remove(&p.rpc_id.to_string());
    match p.kind {
        Kind::Call => shared.result(&p.rpc_id, serde_json::to_value(ToolCallResult::error(msg)).unwrap()),
        Kind::List => shared.error(&p.rpc_id, -32603, msg),
    }
}

fn deliver(shared: &Shared, m: McpBridgeResponse) {
    let take = |id: u64| shared.pending.lock().unwrap().remove(&id);
    match m {
        McpBridgeResponse::ToolsList { id, tools } => {
            if let Some(p) = take(id) {
                shared.result(&p.rpc_id, json!({"tools": tools}));
            }
        }
        McpBridgeResponse::ToolsCall { id, result } => {
            if let Some(p) = take(id) {
                shared.by_rpc.lock().unwrap().remove(&p.rpc_id.to_string());
                shared.result(&p.rpc_id, serde_json::to_value(result).unwrap());
            }
        }
        McpBridgeResponse::Error { id: Some(id), error } => {
            if let Some(p) = take(id) {
                fail(shared, &p, &format!("{}: {}", error.code, error.message));
            }
        }
        McpBridgeResponse::Error { id: None, error } => eprintln!("nest mcp: runner error {}: {}", error.code, error.message),
        McpBridgeResponse::ToolsChanged {} => shared.send(&json!({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})),
        McpBridgeResponse::HelloAck { .. } => {}
    }
}

/// Claude Code's originating `tool_use` id from a `tools/call` request's `_meta`, if present.
/// The key is UNVERIFIED; accept the plausible spellings.
fn tool_use_id_from_meta(meta: Option<&Value>) -> Option<String> {
    let meta = meta?.as_object()?;
    ["claudecode/toolUseId", "toolUseId", "tool_use_id"]
        .iter()
        .find_map(|k| meta.get(*k).and_then(Value::as_str))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    #[test]
    fn tool_use_id_from_meta_keys() {
        assert_eq!(tool_use_id_from_meta(Some(&json!({"claudecode/toolUseId": "toolu_1"}))).as_deref(), Some("toolu_1"));
        assert_eq!(tool_use_id_from_meta(Some(&json!({"toolUseId": "toolu_2"}))).as_deref(), Some("toolu_2"));
        assert_eq!(tool_use_id_from_meta(Some(&json!({"progressToken": 3}))), None);
        assert_eq!(tool_use_id_from_meta(None), None);
    }
}

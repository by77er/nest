//! `nest mcp`: the stdio MCP server Claude Code spawns. Newline-delimited JSON-RPC on stdio;
//! every `tools/list` / `tools/call` is forwarded to the runner (`NEST_MCP_SOCK`). No tool logic,
//! no credentials.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nest_protocol::host::mcp::{McpBridgeRequest, McpBridgeResponse, ToolCallResult};
use nest_protocol::host::{env, frame, paths};
use nest_protocol::model::AgentId;
use nest_protocol::model::error_codes::OUTCOME_UNKNOWN;
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
    /// The runner connection the request went out on.
    conn: u64,
}

/// Requests waiting for the runner, and which connection is live, under one lock: a reader that
/// sees its connection end fails only its own requests, never one sent on the next connection.
#[derive(Default)]
struct Link {
    /// The live connection's number; 0 when there is none.
    conn: u64,
    pending: HashMap<u64, Pending>,
}

/// The runner connection; (re)opened lazily on the next request after it drops.
struct Bridge {
    sock: String,
    agent: AgentId,
    /// Connection number `connects`, if that one is open.
    stream: Option<UnixStream>,
    connects: u64,
}

impl Bridge {
    /// The live connection and its number, opening one if the last one dropped.
    fn get(&mut self, shared: &Shared) -> Option<(u64, &mut UnixStream)> {
        if self.stream.is_none() || shared.link.lock().unwrap().conn != self.connects {
            self.connects += 1;
            self.stream = connect(&self.sock, &self.agent, shared, self.connects)
                .map_err(|e| eprintln!("nest mcp: runner unavailable: {e}"))
                .ok();
        }
        let n = self.connects;
        self.stream.as_mut().map(|s| (n, s))
    }
}

#[derive(Clone)]
struct Shared {
    out: Arc<Mutex<Box<dyn Write + Send>>>,
    link: Arc<Mutex<Link>>,
    /// JSON-RPC id (as a string) → bridge id, for `notifications/cancelled`; removed on completion.
    by_rpc: Arc<Mutex<HashMap<String, u64>>>,
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
    let shared = Shared { out: Arc::new(Mutex::new(Box::new(std::io::stdout()))), link: Default::default(), by_rpc: Default::default() };
    let next = AtomicU64::new(1);
    let mut bridge = Bridge { sock, agent, stream: None, connects: 0 };

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

/// Connect, say hello, wait for `hello_ack`, start the response reader for connection `conn`.
fn connect(sock: &str, agent: &AgentId, shared: &Shared, conn: u64) -> std::io::Result<UnixStream> {
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
    shared.link.lock().unwrap().conn = conn;
    let sh = shared.clone();
    std::thread::spawn(move || {
        while let Ok(Some(m)) = frame::read::<_, McpBridgeResponse>(&mut r) {
            deliver(&sh, m);
        }
        disconnected(&sh, conn);
    });
    Ok(s)
}

/// Connection `conn` ended: fail what was sent on it. A call may still run in the runner (a
/// platform call is not cancelled by the hangup), so it is reported as `outcome_unknown`.
fn disconnected(shared: &Shared, conn: u64) {
    let lost: Vec<Pending> = {
        let mut link = shared.link.lock().unwrap();
        if link.conn == conn {
            link.conn = 0;
        }
        link.pending.extract_if(|_, p| p.conn == conn).map(|(_, p)| p).collect()
    };
    for p in lost {
        let msg = match p.kind {
            Kind::Call => format!(
                "{OUTCOME_UNKNOWN}: the connection to the nest runner closed while the call ran; it may or may not have \
                 taken effect. Check before retrying anything with side effects."
            ),
            Kind::List => "nest runner disconnected".to_string(),
        };
        fail(shared, &p, &msg);
    }
}

fn forward(shared: &Shared, bridge: &mut Bridge, bid: u64, rpc_id: Value, kind: Kind, req: &McpBridgeRequest) {
    let Some((conn, s)) = bridge.get(shared) else { return fail(shared, &Pending { rpc_id, kind, conn: 0 }, "nest runner unavailable") };
    {
        let mut link = shared.link.lock().unwrap();
        if link.conn != conn {
            // Its reader saw it end after `get`: nothing was sent.
            drop(link);
            return fail(shared, &Pending { rpc_id, kind, conn }, "nest runner unavailable");
        }
        link.pending.insert(bid, Pending { rpc_id, kind, conn });
    }
    if let Err(e) = frame::write(s, req)
        && let Some(p) = shared.link.lock().unwrap().pending.remove(&bid)
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
    let take = |id: u64| shared.link.lock().unwrap().pending.remove(&id);
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

    /// Captures what `nest mcp` writes to Claude Code.
    #[derive(Clone, Default)]
    struct Out(Arc<Mutex<Vec<u8>>>);

    impl Write for Out {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(b)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// R9: when a connection ends, only the calls sent on it fail, as `outcome_unknown`; a call
    /// sent on the next connection (the main thread reconnected first) is left to its answer.
    #[test]
    fn a_dropped_connection_fails_only_its_own_calls_as_outcome_unknown() {
        let out = Out::default();
        let shared = Shared { out: Arc::new(Mutex::new(Box::new(out.clone()))), link: Default::default(), by_rpc: Default::default() };
        {
            let mut link = shared.link.lock().unwrap();
            link.conn = 2;
            link.pending.insert(1, Pending { rpc_id: json!(10), kind: Kind::Call, conn: 1 });
            link.pending.insert(2, Pending { rpc_id: json!(11), kind: Kind::Call, conn: 2 });
        }
        disconnected(&shared, 1);
        let link = shared.link.lock().unwrap();
        assert_eq!(link.conn, 2, "the live connection stays live");
        assert_eq!(link.pending.keys().collect::<Vec<_>>(), [&2], "the new connection's call still waits");
        let written = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let reply: Value = serde_json::from_str(written.trim()).unwrap();
        assert_eq!(reply["id"], 10);
        assert_eq!(reply["result"]["isError"], true);
        assert!(reply["result"]["content"][0]["text"].as_str().unwrap().starts_with(OUTCOME_UNKNOWN), "{reply}");
    }

    #[test]
    fn tool_use_id_from_meta_keys() {
        assert_eq!(tool_use_id_from_meta(Some(&json!({"claudecode/toolUseId": "toolu_1"}))).as_deref(), Some("toolu_1"));
        assert_eq!(tool_use_id_from_meta(Some(&json!({"toolUseId": "toolu_2"}))).as_deref(), Some("toolu_2"));
        assert_eq!(tool_use_id_from_meta(Some(&json!({"progressToken": 3}))), None);
        assert_eq!(tool_use_id_from_meta(None), None);
    }
}

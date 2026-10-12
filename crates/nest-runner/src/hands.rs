//! Hands RPC client: one vsock connection per tool call (`guest::PORT_HANDS`).
//!
//! The MCP arguments are forwarded verbatim (tagged with the tool name), the guest's
//! `HandsResult` content maps 1:1 to MCP content. Cancelling sends `cancel` and, if the guest
//! doesn't answer promptly, hangs up (which also cancels).

use std::time::Duration;

use nest_protocol::guest::{self, HandsCancel, HandsOp, HandsRequest, HandsResponse, HandsResult, ToolContent};
use nest_protocol::host::mcp::{McpContent, ToolCallResult};
use nest_protocol::model::{AgentId, Epoch, ErrorBody};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::framing;

/// How long to wait for the guest's final frame after sending `cancel`.
pub const CANCEL_GRACE: Duration = Duration::from_secs(5);
/// Connect attempts while the guest isn't listening yet (e.g. right after boot/restore).
const CONNECT_ATTEMPTS: u32 = 3;

/// Build the RPC op from an MCP `tools/call` (`name` is the bare tool name, e.g. `Bash`).
pub fn op_from_mcp(name: &str, arguments: &Value) -> Result<HandsOp, String> {
    let mut v = match arguments {
        Value::Object(m) => Value::Object(m.clone()),
        Value::Null => Value::Object(Default::default()),
        _ => return Err("arguments must be an object".into()),
    };
    v["tool"] = Value::String(name.to_string());
    serde_json::from_value(v).map_err(|e| format!("invalid arguments for {name}: {e}"))
}

/// Execute one hands call. Never fails at the Rust level: errors become MCP error results.
pub async fn call(
    vsock_uds_path: &str,
    agent: &AgentId,
    epoch: Epoch,
    call_id: String,
    op: HandsOp,
    mut cancel: oneshot::Receiver<()>,
) -> ToolCallResult {
    let req = HandsRequest { protocol_version: guest::PROTOCOL_VERSION, call_id: call_id.clone(), agent_id: agent.clone(), epoch, op };
    let stream = match connect(vsock_uds_path).await {
        Ok(s) => s,
        Err(e) => return ToolCallResult::error(format!("hands unavailable: {e}")),
    };
    let (mut rd, mut wr) = stream.into_split();
    if let Err(e) = framing::write_guest_json(&mut wr, &req).await {
        return ToolCallResult::error(format!("hands request failed: {e}"));
    }
    let mut cancelled = false;
    loop {
        let frame = if cancelled {
            match tokio::time::timeout(CANCEL_GRACE, framing::read_guest(&mut rd)).await {
                Ok(f) => f,
                Err(_) => return ToolCallResult::error("interrupted"),
            }
        } else {
            tokio::select! {
                f = framing::read_guest(&mut rd) => f,
                _ = &mut cancel => {
                    cancelled = true;
                    let _ = framing::write_guest_json(&mut wr, &HandsCancel::Cancel {}).await;
                    continue;
                }
            }
        };
        let frame = match frame {
            Ok(f) => f,
            Err(e) if cancelled => return ToolCallResult::error(format!("interrupted ({e})")),
            Err(e) => return ToolCallResult::error(format!("hands connection lost: {e}")),
        };
        match serde_json::from_slice::<HandsResponse>(&frame.payload) {
            Ok(HandsResponse::Started { .. }) => continue,
            Ok(HandsResponse::Result { result, .. }) => return to_mcp(result),
            Ok(HandsResponse::Error { error, .. }) => return error_result(&error),
            Err(e) => return ToolCallResult::error(format!("bad hands response: {e}")),
        }
    }
}

async fn connect(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    let mut last = None;
    for attempt in 0..CONNECT_ATTEMPTS {
        match framing::vsock_connect(path, guest::PORT_HANDS).await {
            Ok(s) => return Ok(s),
            Err(e) => {
                last = Some(e);
                tokio::time::sleep(Duration::from_millis(100 << attempt)).await;
            }
        }
    }
    Err(last.unwrap())
}

/// Guest result → MCP result (1:1 content).
pub fn to_mcp(r: HandsResult) -> ToolCallResult {
    ToolCallResult {
        content: r
            .content
            .into_iter()
            .map(|c| match c {
                ToolContent::Text { text } => McpContent::Text { text },
                ToolContent::Image { media_type, data_b64 } => McpContent::Image { data: data_b64, mime_type: media_type },
            })
            .collect(),
        is_error: r.is_error,
    }
}

pub fn error_result(e: &ErrorBody) -> ToolCallResult {
    ToolCallResult::error(format!("{}: {}", e.code, e.message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::FakeGuest;
    use serde_json::json;

    #[test]
    fn op_from_mcp_tags_tool() {
        match op_from_mcp("Bash", &json!({"command": "ls", "timeout": 5000})).unwrap() {
            HandsOp::Bash(b) => assert_eq!((b.command.as_str(), b.timeout), ("ls", Some(5000))),
            o => panic!("{o:?}"),
        }
        assert!(op_from_mcp("Read", &json!({})).is_err(), "file_path required");
        assert!(op_from_mcp("Nope", &json!({})).is_err());
    }

    #[tokio::test]
    async fn call_and_cancel_against_fake_guest() {
        let guest = FakeGuest::start().await;
        let agent = AgentId("agt_t".into());
        let (_tx, rx) = oneshot::channel();
        let op = op_from_mcp("Bash", &json!({"command": "echo hi"})).unwrap();
        let r = call(&guest.path, &agent, Epoch(4), "c1".into(), op, rx).await;
        assert!(!r.is_error);
        assert_eq!(r.content, vec![McpContent::Text { text: "ran: echo hi".into() }]);
        let seen = guest.requests().await;
        assert_eq!((seen[0].call_id.as_str(), seen[0].epoch), ("c1", Epoch(4)));

        // `sleep` blocks in the fake until cancelled.
        let (tx, rx) = oneshot::channel();
        let op = op_from_mcp("Bash", &json!({"command": "sleep 30"})).unwrap();
        let path = guest.path.clone();
        let h = tokio::spawn(async move { call(&path, &AgentId("agt_t".into()), Epoch(4), "c2".into(), op, rx).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        tx.send(()).unwrap();
        let r = h.await.unwrap();
        assert!(r.is_error);
        assert!(guest.cancelled().await.contains(&"c2".to_string()));
    }

    #[tokio::test]
    async fn unreachable_guest_is_an_error_result() {
        let (_tx, rx) = oneshot::channel();
        let op = op_from_mcp("Bash", &json!({"command": "x"})).unwrap();
        let r = call("/nonexistent/vsock.sock", &AgentId("agt_t".into()), Epoch(1), "c".into(), op, rx).await;
        assert!(r.is_error);
    }
}

//! The `nest mcp` bridge server: `tools/list` = hands tools (when bound) + AgentDO's platform
//! tools; `tools/call` routes hands → the sandbox's gateway, everything else → AgentDO relay.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use nest_protocol::guest::HANDS_TOOLS;
use nest_protocol::host::mcp::{McpBridgeRequest, McpBridgeResponse, McpToolDef, ToolCallResult};
use nest_protocol::model::{ErrorBody, error_codes};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

use crate::framing;
use crate::hands;
use crate::runtime::{Agent, Runtime};

const HANDS_TOOLS_JSON: &str = include_str!("../../../protocol/schemas/guest/hands-tools.json");

/// Hands tool definitions served verbatim (`protocol/schemas/guest/hands-tools.json`).
pub fn hands_tools() -> &'static [McpToolDef] {
    static TOOLS: OnceLock<Vec<McpToolDef>> = OnceLock::new();
    TOOLS.get_or_init(|| {
        let v: serde_json::Value = serde_json::from_str(HANDS_TOOLS_JSON).expect("hands-tools.json parses");
        serde_json::from_value(v["tools"].clone()).expect("hands tools are MCP tool defs")
    })
}

/// Whether the agent may list and call hands: any agent with a bound sandbox, whatever its
/// template (there are no roles in the platform; `docs/agents/`). The one check for both.
fn has_hands(agent: &Agent) -> bool {
    agent.inner.lock().unwrap().hands.is_some()
}

/// Tools for an agent right now.
pub async fn list(rt: &Runtime, agent: &Agent) -> Vec<McpToolDef> {
    let mut tools = Vec::new();
    if has_hands(agent) {
        tools.extend(hands_tools().iter().cloned());
    }
    let platform = agent.platform_tools(rt.cfg.tools_list_timeout).await;
    tools.extend(platform.iter().filter(|t| !HANDS_TOOLS.contains(&t.name.as_str())).map(McpToolDef::from));
    tools
}

pub async fn serve(rt: Arc<Runtime>, listener: UnixListener) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        tokio::spawn(connection(rt.clone(), stream));
    }
}

async fn connection(rt: Arc<Runtime>, stream: UnixStream) {
    let (mut rd, mut wr) = stream.into_split();
    let agent = match framing::read_host::<_, McpBridgeRequest>(&mut rd).await {
        Ok(Some(McpBridgeRequest::Hello { agent, .. })) => agent,
        _ => return,
    };
    let peer = rd.as_ref().peer_cred().ok().and_then(|c| c.pid());
    let found = rt.agent(&agent).filter(|_| true);
    let verified = match &found {
        Some(_) => crate::hooks::peer_matches(&rt, peer, &agent).await,
        None => false,
    };
    let Some(agent) = found.filter(|_| verified) else {
        tracing::warn!(%agent, ?peer, "nest mcp hello from a process that isn't that agent's brain");
        let e = ErrorBody { code: error_codes::UNKNOWN_AGENT.into(), message: format!("{agent} is not running here"), retryable: false };
        let _ = framing::write_host(&mut wr, &McpBridgeResponse::Error { id: None, error: e }).await;
        return;
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<McpBridgeResponse>();
    let _ = tx.send(McpBridgeResponse::HelloAck { v: 1 });
    let mut changed = agent.tools_changed.subscribe();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if framing::write_host(&mut wr, &m).await.is_err() {
                break;
            }
        }
    });
    let inflight: Arc<Mutex<HashMap<u64, oneshot::Sender<()>>>> = Default::default();
    loop {
        tokio::select! {
            r = framing::read_host::<_, McpBridgeRequest>(&mut rd) => {
                let req = match r { Ok(Some(r)) => r, _ => break };
                match req {
                    McpBridgeRequest::Hello { .. } => {}
                    McpBridgeRequest::ToolsList { id } => {
                        let (rt, agent, tx) = (rt.clone(), agent.clone(), tx.clone());
                        tokio::spawn(async move {
                            let tools = list(&rt, &agent).await;
                            let _ = tx.send(McpBridgeResponse::ToolsList { id, tools });
                        });
                    }
                    McpBridgeRequest::ToolsCall { id, name, arguments, tool_use_id } => {
                        let (cancel_tx, cancel_rx) = oneshot::channel();
                        inflight.lock().unwrap().insert(id, cancel_tx);
                        let (rt, agent, tx, inflight) = (rt.clone(), agent.clone(), tx.clone(), inflight.clone());
                        tokio::spawn(async move {
                            let resp = call(&rt, &agent, id, &name, arguments, tool_use_id, cancel_rx).await;
                            inflight.lock().unwrap().remove(&id);
                            let _ = tx.send(resp);
                        });
                    }
                    McpBridgeRequest::Cancel { id } => {
                        if let Some(c) = inflight.lock().unwrap().remove(&id) {
                            let _ = c.send(());
                        }
                    }
                }
            }
            c = changed.recv() => {
                if c.is_ok() {
                    let _ = tx.send(McpBridgeResponse::ToolsChanged {});
                }
            }
        }
    }
    for (_, c) in inflight.lock().unwrap().drain() {
        let _ = c.send(());
    }
    drop(tx);
    let _ = writer.await;
}

#[allow(clippy::too_many_arguments)]
async fn call(
    rt: &Runtime,
    agent: &Arc<Agent>,
    id: u64,
    name: &str,
    arguments: serde_json::Value,
    tool_use_id: Option<String>,
    cancel: oneshot::Receiver<()>,
) -> McpBridgeResponse {
    if HANDS_TOOLS.contains(&name) {
        if !has_hands(agent) {
            let e = ErrorBody { code: error_codes::NOT_BOUND.into(), message: "this agent has no sandbox bound (no hands)".into(), retryable: false };
            return McpBridgeResponse::Error { id: Some(id), error: e };
        }
        let op = match hands::op_from_mcp(name, &arguments) {
            Ok(op) => op,
            Err(msg) => return McpBridgeResponse::ToolsCall { id, result: ToolCallResult::error(msg) },
        };
        // Hard interrupts cancel through the agent too.
        let key = format!("{}-{id}", uuid::Uuid::new_v4().simple());
        let (agent_cancel_tx, agent_cancel_rx) = oneshot::channel::<()>();
        agent.hands_inflight.lock().unwrap().insert(key.clone(), agent_cancel_tx);
        let (merged_tx, merged_rx) = oneshot::channel();
        tokio::spawn(async move {
            tokio::select! {
                r = cancel => if r.is_ok() { let _ = merged_tx.send(()); },
                r = agent_cancel_rx => if r.is_ok() { let _ = merged_tx.send(()); },
            }
        });
        // The guest call id is Claude Code's tool_use id when `nest mcp` found one in the
        // request's `_meta` (UNVERIFIED that Claude Code sends it); otherwise a generated id.
        let call_id = tool_use_id.unwrap_or_else(|| format!("hc_{}", &key[..12]));
        let result = hands::call(agent, call_id, op, merged_rx).await;
        agent.hands_inflight.lock().unwrap().remove(&key);
        McpBridgeResponse::ToolsCall { id, result }
    } else {
        let result = agent.platform_call(name, arguments, rt.cfg.tool_call_timeout).await;
        McpBridgeResponse::ToolsCall { id, result }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_hands_when_bound_and_exactly_agentdos_platform_tools() {
        use nest_protocol::control::{HandsBinding, ToolDef};
        use nest_protocol::model::{AgentId, Epoch, SandboxId};
        let rt = Runtime::new(crate::Config { tools_list_timeout: std::time::Duration::from_millis(20), ..Default::default() });
        let def = |name: &str| ToolDef {
            name: name.into(),
            description: String::new(),
            input_schema: serde_json::json!({"type": "object"}),
            roles: None,
            requires_approval: false,
        };
        let agent = |hands: Option<HandsBinding>, platform: &[&str]| {
            let (ctx, _) = mpsc::unbounded_channel();
            let (otx, _) = mpsc::unbounded_channel();
            let a = Agent::new(AgentId("agt_m".into()), Epoch(1), std::env::temp_dir(), hands, None, vec![], 0, ctx, otx);
            // What AgentDO last listed (no AgentDO here: the list request times out to it).
            a.inner.lock().unwrap().tools = platform.iter().map(|n| def(n)).collect();
            a
        };
        let bound = Some(HandsBinding { sandbox: SandboxId("sbx_m".into()), epoch: None });
        let names = |tools: Vec<McpToolDef>| tools.into_iter().map(|t| t.name).collect::<Vec<_>>();
        let hands: Vec<String> = HANDS_TOOLS.iter().map(|s| s.to_string()).collect();
        // Hands come with a bound sandbox (the spec's hands), whatever else the agent is.
        assert_eq!(names(list(&rt, &agent(bound.clone(), &[])).await), hands);
        assert!(list(&rt, &agent(None, &[])).await.is_empty());
        // Platform tools: exactly what AgentDO lists, in its order (a hands name in it isn't listed twice).
        let mut want = hands.clone();
        want.extend(["spawn_agent".to_string(), "notify".to_string()]);
        assert_eq!(names(list(&rt, &agent(bound, &["spawn_agent", "Bash", "notify"])).await), want);
        assert_eq!(names(list(&rt, &agent(None, &["emit"])).await), vec!["emit".to_string()]);
    }

    #[test]
    fn hands_tools_parse() {
        let names: Vec<_> = hands_tools().iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, HANDS_TOOLS);
        assert!(hands_tools().iter().all(|t| t.input_schema["type"] == "object"));
    }
}

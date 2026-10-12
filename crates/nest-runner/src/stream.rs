//! Claude Code stream-json stdout → canonical [`AgentEventBody`]s.
//!
//! Pure functions; the agent actor stamps agent/epoch/seq/turn and handles side effects
//! (auth checks, interrupts, idle timers).

use nest_protocol::host::claude::{ResultMessage, StreamOut, SystemMessage};
use nest_protocol::model::{AgentEventBody, AgentState, ErrorBody, Usage};
use serde_json::Value;

/// Longest tool-result summary carried in an event (the full content lives in the session file).
pub const SUMMARY_CHARS: usize = 200;

/// Map one parsed stdout line to events.
pub fn events_for(out: &StreamOut) -> Vec<AgentEventBody> {
    match out {
        StreamOut::System(SystemMessage::Init { .. }) => {
            vec![AgentEventBody::StateChanged { state: AgentState::Ready, detail: None }]
        }
        StreamOut::System(SystemMessage::ApiRetry { error, retry_delay_ms, attempt, max_retries, error_status, .. }) => {
            if error == "rate_limit" {
                vec![
                    AgentEventBody::RateLimited {
                        retry_after_ms: Some(*retry_delay_ms),
                        detail: format!("api_retry attempt {attempt}/{max_retries} (status {error_status:?})"),
                    },
                    AgentEventBody::StateChanged { state: AgentState::QuotaParked, detail: Some(error.clone()) },
                ]
            } else {
                Vec::new()
            }
        }
        StreamOut::Assistant { message, .. } => assistant_events(message),
        StreamOut::User { message, .. } => tool_result_events(message),
        StreamOut::Result(r) => result_events(r),
        _ => Vec::new(),
    }
}

fn assistant_events(message: &Value) -> Vec<AgentEventBody> {
    let mut out = Vec::new();
    for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(AgentEventBody::AssistantText { text: t.to_string() });
                }
            }
            Some("tool_use") => out.push(AgentEventBody::ToolCall {
                call_id: str_field(block, "id"),
                name: str_field(block, "name"),
                input: block.get("input").cloned().unwrap_or(Value::Null),
            }),
            _ => {}
        }
    }
    out
}

fn tool_result_events(message: &Value) -> Vec<AgentEventBody> {
    let mut out = Vec::new();
    for block in message.get("content").and_then(Value::as_array).into_iter().flatten() {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            out.push(AgentEventBody::ToolResult {
                call_id: str_field(block, "tool_use_id"),
                is_error: block.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                summary: summarize(block.get("content")),
            });
        }
    }
    out
}

fn result_events(r: &ResultMessage) -> Vec<AgentEventBody> {
    let usage = usage_from(&r.usage, Some(r.total_cost_usd));
    let stop_reason = r.stop_reason.clone().unwrap_or_else(|| r.subtype.clone());
    let mut out = vec![AgentEventBody::TurnCompleted { stop_reason, usage: Some(usage) }];
    if r.is_error {
        out.push(AgentEventBody::Error {
            error: ErrorBody { code: r.subtype.clone(), message: r.result.clone().unwrap_or_default(), retryable: true },
        });
    }
    out.push(AgentEventBody::StateChanged { state: AgentState::Idle, detail: None });
    out
}

/// Parse a Messages-API-style usage object.
pub fn usage_from(v: &Value, cost: Option<f64>) -> Usage {
    let n = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: n("input_tokens"),
        output_tokens: n("output_tokens"),
        cache_read_input_tokens: n("cache_read_input_tokens"),
        cache_creation_input_tokens: n("cache_creation_input_tokens"),
        cost_usd_estimate: cost,
    }
}

fn str_field(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// First `SUMMARY_CHARS` characters of a tool result's text content.
pub fn summarize(content: Option<&Value>) -> Option<String> {
    let text = match content? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(SUMMARY_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reference_lines() -> Vec<StreamOut> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../protocol/claude-code/stream-out.jsonl");
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l}: {e}")))
            .collect()
    }

    #[test]
    fn maps_reference_stream() {
        let all: Vec<AgentEventBody> = reference_lines().iter().flat_map(events_for).collect();
        let kinds: Vec<&str> = all
            .iter()
            .map(|e| match e {
                AgentEventBody::StateChanged { .. } => "state",
                AgentEventBody::ToolCall { .. } => "tool_call",
                AgentEventBody::ToolResult { .. } => "tool_result",
                AgentEventBody::RateLimited { .. } => "rate_limited",
                AgentEventBody::TurnCompleted { .. } => "turn_completed",
                AgentEventBody::AssistantText { .. } => "text",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            ["state", "tool_call", "tool_result", "rate_limited", "state", "turn_completed", "state"]
        );
        match &all[1] {
            AgentEventBody::ToolCall { call_id, name, input } => {
                assert_eq!((call_id.as_str(), name.as_str()), ("toolu_01ABC", "mcp__nest__Bash"));
                assert_eq!(input["command"], "cargo test");
            }
            e => panic!("{e:?}"),
        }
        match &all[2] {
            AgentEventBody::ToolResult { summary, is_error, .. } => {
                assert_eq!(summary.as_deref(), Some("test result: ok"));
                assert!(!is_error);
            }
            e => panic!("{e:?}"),
        }
        match &all[5] {
            AgentEventBody::TurnCompleted { stop_reason, usage } => {
                assert_eq!(stop_reason, "end_turn");
                let u = usage.unwrap();
                assert_eq!((u.input_tokens, u.cache_read_input_tokens), (2048, 40000));
            }
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn summary_truncates() {
        let long = Value::String("x".repeat(500));
        assert_eq!(summarize(Some(&long)).unwrap().len(), SUMMARY_CHARS);
        assert_eq!(summarize(Some(&Value::String(String::new()))), None);
    }
}

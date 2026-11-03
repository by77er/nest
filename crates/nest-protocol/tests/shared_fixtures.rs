//! Checks that span the protocol's modules: the shared code and enum lists both mirrors assert
//! against (`protocol/fixtures/codes.json`, `protocol/fixtures/enums.json`), id validation at
//! the parse boundary, open enums, and "absent, never null".

use std::collections::BTreeSet;
use std::fmt::Debug;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use strum::IntoEnumIterator;

use nest_protocol::control::{AgentExitReason, EgressVerdict, EgressVia, HostEvent, RuleDecision, TunnelState};
use nest_protocol::gateway::BindingScope;
use nest_protocol::guest::{CliRequest, ControlFrame, TaskStatus, Urgency};
use nest_protocol::host::{proxy::AlertKind, runner::ExitReason};
use nest_protocol::model::*;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn fixture(name: &str) -> Value {
    let p = root().join("protocol/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().expect("array").iter().map(|s| s.as_str().expect("string").to_owned()).collect()
}

fn wire<T: Serialize>(t: T) -> String {
    serde_json::to_value(t).unwrap().as_str().expect("a unit member serializes as a string").to_owned()
}

#[test]
fn error_code_lists_match_codes_json() {
    let codes = fixture("codes.json");
    for (key, list) in [("error_codes", error_codes::ALL), ("gateway_error_codes", nest_protocol::gateway::error_code::ALL)] {
        let listed = strings(&codes[key]);
        let ours: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        assert_eq!(listed.iter().collect::<BTreeSet<_>>().len(), listed.len(), "{key}: duplicate in codes.json");
        assert_eq!(listed.into_iter().collect::<BTreeSet<_>>(), ours.into_iter().collect(), "{key}: codes.json and the crate differ");
    }
    assert!(error_codes::is_unsupported_version("unsupported_version"));
    assert!(error_codes::is_unsupported_version("unsupported_protocol_version"), "the legacy name is still read");
    assert!(!error_codes::ALL.contains(&error_codes::LEGACY_UNSUPPORTED_VERSION), "the legacy name is never sent");
}

/// Every member of `E` is listed under `name` in enums.json and nothing else is; each listed
/// string parses and serializes back unchanged.
fn check_enum<E>(enums: &Value, name: &str, seen: &mut BTreeSet<String>)
where
    E: IntoEnumIterator + Serialize + DeserializeOwned + PartialEq + Debug,
{
    let listed = strings(enums.get(name).unwrap_or_else(|| panic!("enums.json has no {name}")));
    let ours: BTreeSet<String> = E::iter().map(wire).collect();
    assert_eq!(listed.iter().cloned().collect::<BTreeSet<_>>(), ours, "{name}: enums.json and the Rust enum differ");
    for s in &listed {
        let e: E = serde_json::from_value(json!(s)).unwrap_or_else(|e| panic!("{name}::{s}: {e}"));
        assert_eq!(&wire(e), s, "{name}::{s} does not round-trip");
    }
    seen.insert(name.to_owned());
}

#[test]
fn enum_members_match_enums_json() {
    let enums = fixture("enums.json");
    let mut seen = BTreeSet::new();
    let s = &mut seen;
    check_enum::<AgentExitReason>(&enums, "AgentExitReason", s);
    check_enum::<AgentRole>(&enums, "AgentRole", s);
    check_enum::<AgentState>(&enums, "AgentState", s);
    check_enum::<BindingScope>(&enums, "BindingScope", s);
    check_enum::<CommitReason>(&enums, "CommitReason", s);
    check_enum::<EgressAlertReason>(&enums, "EgressAlertReason", s);
    check_enum::<EgressVerdict>(&enums, "EgressVerdict", s);
    check_enum::<EgressVia>(&enums, "EgressVia", s);
    check_enum::<ForkMode>(&enums, "ForkMode", s);
    check_enum::<nest_protocol::gateway::RefusalReason>(&enums, "GatewayRefusalReason", s);
    check_enum::<GenerationKind>(&enums, "GenerationKind", s);
    check_enum::<HostRole>(&enums, "HostRole", s);
    check_enum::<ManifestKind>(&enums, "ManifestKind", s);
    check_enum::<PolicyLayer>(&enums, "PolicyLayer", s);
    check_enum::<RuleDecision>(&enums, "RuleDecision", s);
    check_enum::<SandboxState>(&enums, "SandboxState", s);
    check_enum::<SuspendMode>(&enums, "SuspendMode", s);
    check_enum::<TaskStatus>(&enums, "TaskStatus", s);
    check_enum::<TunnelState>(&enums, "TunnelState", s);
    check_enum::<TurnInputKind>(&enums, "TurnInputKind", s);
    check_enum::<Urgency>(&enums, "Urgency", s);
    let listed: BTreeSet<String> = enums.as_object().unwrap().keys().cloned().collect();
    assert_eq!(listed, seen, "enums.json lists an enum this test doesn't check");
}

/// Host roles, expand/contract: the next release's names (`sandbox`, `brain`) parse now, and this
/// release still writes the previous release's (`burst`, `controller`), which its control plane reads.
#[test]
fn host_role_reads_both_names_and_writes_the_previous_ones() {
    for (old, new, kind) in [("burst", "sandbox", HostRole::Sandbox), ("controller", "brain", HostRole::Brain)] {
        assert_eq!(serde_json::from_value::<HostRole>(json!(old)).unwrap(), kind);
        assert_eq!(serde_json::from_value::<HostRole>(json!(new)).unwrap(), kind);
        assert_eq!(wire(kind), old);
    }
    assert!(serde_json::from_value::<HostRole>(json!("worker")).is_err());
}

#[test]
fn ids_check_their_prefix_when_parsed() {
    fn rejects<T: DeserializeOwned + Debug>(bad: &str) {
        assert!(serde_json::from_value::<T>(json!(bad)).is_err(), "{} accepted {bad:?}", std::any::type_name::<T>());
    }
    let a: AgentId = serde_json::from_value(json!("agt_01")).unwrap();
    assert!(a.is_valid());
    assert!(!AgentId("x".into()).is_valid());
    rejects::<HostId>("sbx_1");
    rejects::<SandboxId>("agt_1");
    rejects::<AgentId>("x");
    rejects::<AgentId>("");
    rejects::<WorkstreamId>("w_1");
    rejects::<GenerationId>("1");
    rejects::<SessionId>("2f1c6a9e-0000-4000-8000-000000000000");
    rejects::<TurnId>("t_1");
    rejects::<CallId>("toolu_1");
    rejects::<CommandId>("c_1");
    rejects::<RequestId>("r_1");
    rejects::<AskId>("a_1");
    rejects::<MessageId>("m_1");
    // Map keys go through the same check.
    assert!(serde_json::from_value::<std::collections::BTreeMap<AgentId, u32>>(json!({"x": 1})).is_err());
}

/// The guest-controlled `NEST_AGENT_ID` is refused where the guest's message is parsed, so it can
/// never reach a host event batch (where the control plane would reject it).
#[test]
fn a_bad_agent_id_from_a_sandbox_fails_at_the_guest_boundary() {
    let cli = json!({"agent_id": "x", "command": {"command": "notify", "to": "captain", "message": "hi"}});
    assert!(serde_json::from_value::<CliRequest>(cli).is_err(), "guest CLI socket");
    let frame = json!({"id": 5, "type": "cli", "agent_id": "x", "command": {"command": "whoami"}});
    assert!(serde_json::from_value::<ControlFrame>(frame).is_err(), "guest control channel");
    let event = json!({
        "ts_ms": 1, "type": "guest_cli", "request": "req_1", "sandbox": "sbx_1", "epoch": 1, "agent": "x",
        "command": {"command": "whoami"}
    });
    assert!(serde_json::from_value::<HostEvent>(event).is_err(), "fleet host event");
}

#[test]
fn agent_exit_reasons_are_an_open_enum() {
    // Free text from an older sender, or a member a newer one added, parses as `unknown`.
    for old in ["idle grace elapsed", "not running after host reconnect", "stale", "some_future_reason"] {
        assert_eq!(serde_json::from_value::<AgentExitReason>(json!(old)).unwrap(), AgentExitReason::Unknown, "{old}");
    }
    let ev: HostEvent = serde_json::from_value(json!({"ts_ms": 1, "type": "agent_exited", "agent": "agt_1", "reason": "stale"})).unwrap();
    assert!(matches!(ev.body, nest_protocol::control::HostEventBody::AgentExited { reason: AgentExitReason::Unknown, .. }));
    // The runner's reasons reach the wire under their own names, and `as_str` is that name.
    for r in ExitReason::iter() {
        assert_eq!(wire(AgentExitReason::from(r)), wire(r), "{r:?}");
        assert_eq!(r.as_str(), wire(r), "{r:?}");
    }
    assert_eq!(serde_json::from_value::<EgressAlertReason>(json!("placeholder sent outside binding hosts")).unwrap(), EgressAlertReason::Unknown);
    for k in AlertKind::iter() {
        assert_eq!(wire(EgressAlertReason::from(k)), wire(k), "{k:?}");
    }
}

/// "Absent, never null": every optional field of a nest wire type is left out when unset, so
/// nothing a Rust side sends can hit zod's `.optional()` (which rejects `null`). Checked on the
/// source, so a new `Option` field without the attribute fails here, fixture or not.
#[test]
fn optional_fields_are_never_serialized_as_null() {
    // Claude Code's own stream-json types (`host::claude`), not nest's wire: its format decides.
    const CLAUDE_FORMAT: &[&str] = &["parent_tool_use_id", "error_status", "stop_reason", "result", "response"];
    let mut offenders = vec![];
    for file in ["control.rs", "gateway.rs", "guest.rs", "host.rs", "model.rs"] {
        let path = root().join("crates/nest-protocol/src").join(file);
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        let mut in_claude = false;
        for (i, line) in lines.iter().enumerate() {
            if line.contains("#[cfg(test)]") {
                break;
            }
            if line.starts_with("pub mod claude") {
                in_claude = true;
            } else if line.starts_with("pub mod ") || line.starts_with("// ----") {
                in_claude = false;
            }
            let Some(at) = line.find(": Option<") else { continue };
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("fn ") || trimmed.starts_with("pub fn ") || line.contains("let ") {
                continue;
            }
            let field = line[..at].rsplit(|c: char| !(c.is_alphanumeric() || c == '_')).next().unwrap_or("");
            let mut attrs = line[..at].to_owned();
            let mut j = i;
            while j > 0 && (lines[j - 1].trim_start().starts_with("#[") || lines[j - 1].trim_start().starts_with("///")) {
                j -= 1;
                attrs.push_str(lines[j]);
            }
            if attrs.contains("skip_serializing_if") || (in_claude && CLAUDE_FORMAT.contains(&field)) {
                continue;
            }
            offenders.push(format!("{file}:{}: {}", i + 1, trimmed));
        }
    }
    assert!(offenders.is_empty(), "Option fields serialized as null when unset (add skip_serializing_if):\n{}", offenders.join("\n"));
}

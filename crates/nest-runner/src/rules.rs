//! Local answers for synchronous permission hooks: Claude Code permission-rule syntax matched
//! against `AgentCache.rules` (first match wins; no match ⇒ `ask`).
//!
//! Supported syntax (the subset AgentDO emits):
//! - `Tool` — any call to `Tool`;
//! - `Tool(specifier)` — `specifier` is a glob (`*` = any run of characters) matched against the
//!   call's subject (Bash `command`, file tools' `file_path`, Glob/Grep `pattern`, WebFetch `url`);
//! - `*` in the tool part globs tool names (`mcp__nest__*`).
//!
//! MCP tools arrive in hooks as `mcp__nest__<Name>`; a rule may name a platform tool with or
//! without that prefix (`brokered` ≡ `mcp__nest__brokered`).

use nest_protocol::control::{RuleDecision, ToolRule};
use serde_json::Value;

const MCP_PREFIX: &str = "mcp__nest__";

/// Outcome of matching a tool call against the rules.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub decision: RuleDecision,
    pub reason: Option<String>,
    /// The pattern that matched (`None` = no match ⇒ default `ask`).
    pub pattern: Option<String>,
}

/// First matching rule wins; no match ⇒ `ask`.
pub fn evaluate(rules: &[ToolRule], tool_name: &str, tool_input: &Value) -> Verdict {
    let subject = subject(tool_input);
    for r in rules {
        if matches(&r.pattern, tool_name, subject.as_deref()) {
            return Verdict { decision: r.decision, reason: r.reason.clone(), pattern: Some(r.pattern.clone()) };
        }
    }
    Verdict { decision: RuleDecision::Ask, reason: None, pattern: None }
}

/// The string a `Tool(specifier)` rule is matched against.
pub fn subject(input: &Value) -> Option<String> {
    for key in ["command", "file_path", "url", "pattern", "path", "action"] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return Some(s.to_string());
        }
    }
    None
}

/// Does `pattern` match this call?
pub fn matches(pattern: &str, tool_name: &str, subject: Option<&str>) -> bool {
    let (tool_pat, spec) = match pattern.find('(') {
        Some(i) if pattern.ends_with(')') => (&pattern[..i], Some(&pattern[i + 1..pattern.len() - 1])),
        _ => (pattern, None),
    };
    let bare = tool_name.strip_prefix(MCP_PREFIX);
    let tool_ok = glob(tool_pat, tool_name) || bare.is_some_and(|b| glob(tool_pat, b));
    if !tool_ok {
        return false;
    }
    match spec {
        None => true,
        Some(spec) => subject.is_some_and(|s| glob(spec, s)),
    }
}

/// Whole-string glob where `*` matches any (possibly empty) run of characters.
pub fn glob(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] != '*' && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(p: &str, d: RuleDecision) -> ToolRule {
        ToolRule { pattern: p.into(), decision: d, reason: Some(format!("r:{p}")) }
    }

    #[test]
    fn glob_basics() {
        assert!(glob("*", ""));
        assert!(glob("mcp__nest__*", "mcp__nest__Bash"));
        assert!(glob("git push *", "git push origin main"));
        assert!(!glob("git push *", "git pull"));
        assert!(glob("a*b*c", "aXXbYYc"));
        assert!(!glob("a*b*c", "aXXbYY"));
    }

    #[test]
    fn first_match_wins_and_specifiers() {
        // Mirrors protocol/fixtures/control/agent_to_runner/cache_update.json.
        let rules = vec![
            rule("mcp__nest__Bash(git push --force*)", RuleDecision::Deny),
            rule("mcp__nest__*", RuleDecision::Allow),
            rule("brokered", RuleDecision::Ask),
        ];
        let v = evaluate(&rules, "mcp__nest__Bash", &json!({"command": "git push --force origin"}));
        assert_eq!(v.decision, RuleDecision::Deny);
        let v = evaluate(&rules, "mcp__nest__Bash", &json!({"command": "cargo test"}));
        assert_eq!(v.decision, RuleDecision::Allow);
        // Built-ins don't match the MCP wildcard → default ask.
        let v = evaluate(&rules, "WebFetch", &json!({"url": "https://x"}));
        assert_eq!((v.decision, v.pattern), (RuleDecision::Ask, None));
    }

    #[test]
    fn bare_platform_names_match_prefixed_tools() {
        let rules = vec![rule("brokered", RuleDecision::Deny)];
        assert_eq!(evaluate(&rules, "mcp__nest__brokered", &json!({})).decision, RuleDecision::Deny);
    }

    #[test]
    fn specifier_without_subject_does_not_match() {
        assert!(!matches("mcp__nest__Bash(ls*)", "mcp__nest__Bash", None));
        assert!(matches("WebFetch(https://docs.*)", "WebFetch", Some("https://docs.rs/x")));
    }
}

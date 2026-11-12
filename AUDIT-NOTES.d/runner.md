## No drift: runner-claude, runner-hooks, runner-mcp
- runner-claude: argv and env match `nest_protocol::host::claude` (crates/nest-protocol/src/host.rs:993-1062), EMPTY_CWD (host.rs:45), HOST_SAFE_BUILTINS (crates/nest-runner/src/agent.rs:48-51), seeded worker built-ins (control-plane/src/lib/spec.ts:317), managed settings (protocol/claude-code/managed-settings.json), StreamIn interrupt `cancel_queued` (host.rs:1106).
- runner-hooks: hook wiring, timeouts and `onFailure` = protocol/claude-code/managed-settings.json; 8 s sync timeout (crates/nest-cli/src/hook.rs:22); 60 KiB datagram (host.rs `hook::MAX_DATAGRAM`); spool (hook.rs:50-89); approval_check 5 s (crates/nest-runner/src/config.rs:68).
- runner-mcp: MCP config `timeout: 900000`, `alwaysLoad`, env (protocol/claude-code/mcp-config.json, host.rs:1056-1078); `_meta` keys (crates/nest-cli/src/mcp.rs:253); `hc_<random>` (crates/nest-runner/src/mcp.rs:138); 150 s / outcome_unknown / cancel_call (crates/nest-runner/src/runtime.rs:508-530).
## Unconfirmed
- runner-claude "Sources" table: the linked code.claude.com pages resolve (fetched cli-reference, env-vars); `CLAUDE_CODE_MCP_ALLOWLIST_ENV` confirmed on env-vars; the page text was too long for the fetch tool to confirm each flag and variable one by one.
- runner-mcp "Hands, designed" (retry of `executed: false`, silence timers, rejected fields): no runner code found for them (crates/nest-runner/src/hands.rs); stays designed.
## Style (not code drift)
- runner-hooks/README.md "Input it can't parse" bullet ends with a history sentence ("Before `--event` (2026-11-11) it sent `null`…"): a tombstone by AGENTS.md's rule; left for the owner.
STATUS: DONE

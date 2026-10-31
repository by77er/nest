# Agent runner

A Rust component on every [brain host](../../compute/brain-hosts/) that runs brains, with or without hands. It never runs on a sandbox host. Hands reach the sandbox through the runner's **hands client**: one WebSocket per call to the sandbox's [gateway](../../sandbox/gateway/) over that host's tunnel, with the binding as the first frame ([gateway contract](../../interfaces/gateway/)).

## Invocation (agent with hands)

The canonical command line, environment and managed settings are in [../../interfaces/host-internal/runner-claude/](../../interfaces/host-internal/runner-claude/) (built by `nest_protocol::host::claude`). In short (the flags under [pending contract changes](../../interfaces/README.md#pending-contract-changes) aren't built yet):

```bash
cd /var/lib/nest/empty && CLAUDE_CONFIG_DIR=/var/lib/nest/agents/<id> \
claude -p --input-format stream-json --output-format stream-json --verbose \
  --restricted --tools "<built-ins that don't touch the local machine>" \
  --strict-mcp-config --mcp-config <config_dir>/nest-mcp.json \
  --permission-mode dontAsk --permission-prompts none --allowedTools "mcp__nest__*,<built-ins>" \
  --disable-slash-commands \
  --append-system-prompt-file <config_dir>/nest-system-prompt.md \
  [--model <m>] [--effort <e>] \
  (--session-id <uuid> | --resume <session file> [--fork-session])
```

The system prompt text comes from the control plane (`LaunchConfig.system_prompt`) and is written into the agent's config dir; nothing template-specific lives on the host.

- **`--tools`** keeps only the built-ins that don't touch the host's files or run commands there: the task tools and WebSearch/WebFetch (which send traffic from the host through its egress allowlist). `TodoWrite` is left out (it's inert next to the task tools), and so is `Agent`: in `-p` mode subagent results arrive in a later turn ([docs](https://code.claude.com/docs/en/sub-agents)), which turn tracking doesn't model yet. Every file and shell operation goes through [hands](../hands/).
- **`--restricted`** (Claude Code 2.1.248+) removes command and code tools and WebFetch unless `--tools` names them, confines file tools to the working directories, loads only managed settings and `--settings`, and refuses `bypassPermissions` ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- **`--system-prompt-snapshot off`:** a resumed session otherwise keeps its first request's system prompt until compaction, so template edits wouldn't reach it ([sessions](https://code.claude.com/docs/en/sessions)).
- **Budget backstop:** the spawn spec's budget also becomes `--max-turns` and `--max-budget-usd` (a client-side estimate). The control plane's budget is the real limit.
- **Pinned baseline:** each host release pins one Claude Code version, by version number and the binary's SHA-256, as the supported baseline. The runner checks both at start and refuses anything else, and updates are off (`DISABLE_UPDATES=1`).
- **Upgrades are gated:** a new baseline is adopted only when the `e2e/claude-verify` probes, the [hands fidelity eval](../../README.md#first-spike) (first-spike item 10) and resuming sessions written by the previous baseline all pass. The session JSONL is an internal format that "changes between versions" ([sessions](https://code.claude.com/docs/en/sessions)).
- **The working directory is an empty host directory,** so a repo's `.claude/settings.json` hooks and `.mcp.json` can never load. If they did, they would run *on the host*. The repo's CLAUDE.md is passed in as text by our `SessionStart` hook, read through hands.
- **System prompt:** `--append-system-prompt-file` keeps Claude Code's coding prompt and adds the spawn spec's text, which explains that the hands tools work like the built-ins. A spec with `system_prompt.mode: replace` and no built-ins (the `captain` template, for example) gets `--system-prompt-file` and `--tools ""` instead.
- **Built-ins are an allowlist:** only those that leave the host alone (`Agent`/`Task`, the task and todo tools, `WebSearch`, `WebFetch`, the MCP resource tools) may appear. A launch naming anything else is refused at start, and a brain whose `system/init` reports anything else (besides `mcp__*` tools) is killed, so a built-in Claude Code adds later stays out until it is reviewed.
- **Never use `--bare`** (it ignores OAuth) or **`--safe-mode`** (it stops MCP servers from loading).

## Hands

- **The target comes from AgentDO, lazily.** `agent_start` names the sandbox only. Before its first hands call after a brain start, the runner sends `hands_resolve` on its session channel (10 s per round trip) and caches the `HandsTarget` (gateway URL, binding, guest version) AgentDO obtained from SandboxDO's `resolve`, until 60 s before the binding's `exp_ms` (read from its claims), when it resolves again before the next call. `sandbox_not_ready` is waited out per `retry_after_ms` (2 s by default) for up to 60 s; `not_bound` is the MCP `not_bound` error. The runner never talks to SandboxDO, and never to nestd about hands.
- **One WebSocket per call** (`crates/nest-hands-client`) to `<url>/hands`: `bind` first, then the host-guest hands frames verbatim, `op` being the MCP tool input plus `tool`, every `HandsRequest` stamped with the guest version `bound` reported and the sandbox epoch from the binding's claims (the copy the gateway checks; the target's own `sandbox` and `epoch` fields are unsigned leftovers, ignored). Cancel sends `cancel`, waits 5 s for the final frame, then hangs up. `call_status` uses the same kind of connection.
- **Refusals and moves** (one classification, `nest_hands_client::Next`): `stale_epoch`, `moved`, `unknown_key`, `unauthorized` (an expired or revoked binding), `unsupported_version` (a target minted before SandboxDO heard of a guest upgrade) or an unreachable gateway drops the cached target, resolves again once and retries the call once; a second refusal is the error. `busy`, from the gateway or from the guest (filesystems frozen for a snapshot, refused before anything runs), is retried per `retry_after_ms` (500 ms by default) within one 30 s budget. A 4409 close mid-call (the sandbox left the host) makes the call `outcome_unknown` and drops the target, so the next call resolves afresh. A brain survives its sandbox moving: AgentDO tells it what the restore lost (mid-turn as an inbox message, otherwise ahead of its next turn, or in the recovery turn if it died mid-turn). A superseded brain is killed (and confirmed gone) before AgentDO starts its agent elsewhere; its resolve is refused by AgentDO.
- **The SessionStart read** of the repo's CLAUDE.md goes through the same path.
- **Tests** run a real `nest-gateway` on loopback behind the fake guest (the crate's `test-support` feature, a dev-dependency only, so no production build carries the gateway).

**Not built:** the guest's heartbeat on a call silent for 10 s and the runner's 30 s no-frame rule (a wedged guest holds a call until the tool's own deadline), `executed` on guest errors (v2), and `call_status` lookups at start.

## Auth

- **Token:** `claude setup-token` is the same browser OAuth as `/login` and produces a one-year token that can only make model requests. I run it once; the token is stored in BrokerDO and handed to each process as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Clean environment:** the runner builds the process environment explicitly (the token, `CLAUDE_CONFIG_DIR`, and nothing inherited). That stops any `ANTHROPIC_*` variable from taking over: `CLAUDE_CODE_OAUTH_TOKEN` ranks below `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `apiKeyHelper` ([authentication](https://code.claude.com/docs/en/authentication)). The subprocess environment scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) keeps `NEST_*` and strips the token from hooks and MCP servers; on Linux it needs bubblewrap, so hosts install it (see [runner-claude](../../interfaces/host-internal/runner-claude/)).
- **Managed settings** set `forceLoginMethod: "claudeai"` and `allowedProviders: ["anthropic"]`, so Claude Code refuses to start with an API key or a custom endpoint. A setup token passed as `CLAUDE_CODE_OAUTH_TOKEN` is accepted under it (checked on 2.1.301 with `e2e/claude-verify`).
- **Startup check:** the runner confirms `claude auth status` reports `authMethod: "oauth_token"`. This also catches `--bare` becoming the default for `-p`.
- **Compliance:**
  - The binary is unmodified.
  - It's my own subscription, for personal use. `setup-token` is documented for scripts and CI ([authentication](https://code.claude.com/docs/en/authentication)). Products built for others should use API keys ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)), so anything multi-user needs written clearance first ([legal](https://code.claude.com/docs/en/legal-and-compliance)).
  - Only documented flags are used.
  - No proxy decrypts or injects the OAuth token.

## Lifecycle

- **Start registers first,** then runs the slow steps (session rebuild, `auth status`, the baseline check, the [lookup of in-flight hands calls](../hands/#journal)) with timeouts; a fence, stop or lease lapse during startup cancels it. AgentDO never re-issues a start for a brain it hasn't released, so a start that finds a brain of the agent still registered (one on its way out) ends it and registers once it is gone, never adopting it or running beside it. Starting needs a valid lease; a fence of every brain (lease lapse, nestd gone) also drops starts not yet registered.
- **Running:** one long-lived process per active agent; stdin has its own writer task, so a kill never waits on it.
- **Turns** (decided by a sans-IO core, `brain.rs`, that the actor feeds and obeys): AgentDO is the only source of turns, and a turn is exactly one user message on stdin, its `run_turn` text. Inbox messages never go to stdin: the [inbox mirror](../state-tracking/#synchronous-hooks-answered-locally-1-ms) hands them to the model through hooks, and AgentDO queues any the turn never took once it completes. A `result` ends the running turn with `turn_completed` and `idle`, with the turn's id, except a `result` while the turn's last `Stop` hook answered `block` (taken for intermediate, unverified that Claude Code emits one there) unless it failed or the turn is being interrupted; a `result` with no turn running ends nothing. A second turn while one runs is never written (`turn_overlap`).
- **Interrupt** (of the turn it names): the stream-json control message (check for `interrupt_receipt_v1`). Fallback: SIGINT to the Claude Code pid only, then SIGKILL of its process group.
- **Idle:** after 120 s idle (configurable), counted from the brain's start or its last turn's end, close stdin so the process exits; a brain that never gets a turn exits too, so its host can retire. A turn arriving while it exits restarts Claude Code with `--resume` and runs there, unless a stop or kill came meanwhile (the exit then takes that reason and the turn gets an `agent_stopping` error); after that, the next turn starts a new brain as AgentDO's `agent_start` says (resumed or fresh).
- **Exit:** the last stdout lines are processed before the exit is handled; the session channel keeps flushing (and reconnecting) for up to 30 s until AgentDO has acked every event and the session bytes are durable.
- **Unattended runs:** `--permission-prompts none` makes Claude Code deny without prompting and tell the model not to retry ([headless](https://code.claude.com/docs/en/headless)). Escalation comes from our own `PreToolUse` hook: a call no rule allows is held with `defer`, which ends the process; once approved, the brain resumes and the same call runs ([hooks](https://code.claude.com/docs/en/hooks)). `defer` handles one tool call per turn and works only under `-p` (verified with stream-json, [runner-claude](../../interfaces/host-internal/runner-claude/)).
- **Hands tools** are listed and callable for any agent with a bound sandbox, whatever its template.
- **Default rules** come from the template's capabilities: `nest` allows `mcp__nest__*`, and `subagents` (in the seeded `worker`, whose launch names `Task`) allows `Agent` (`Task` before Claude Code 2.1). Everything else escalates.
- **Stream parsing:** `system/init` arrives only after the first user message, with `SessionStart` hook lines before it, so the runner writes the first turn without waiting for it.

## Process hygiene

- **Planned, not built:** each agent as a systemd unit (`DynamicUser`, `ProtectSystem=strict`, a private `/tmp`, write access only to its `CLAUDE_CONFIG_DIR`). Today every brain runs as the runner's user in its own process group, so brains on one host can read each other's environment (and OAuth token) through `/proc`; only host code execution could exploit that.
- **Hook and MCP peers are bound to brains:** the sync hook socket and the `nest mcp` bridge accept an agent id only from a process descending from that agent's Claude Code (`SO_PEERCRED` + `/proc` ancestry). The tailer only follows session files under the agent's `<config_dir>/projects/`.
- **WebFetch and instance metadata:** WebFetch runs on the brain's host, but it only issues GETs, and hosts require IMDSv2 tokens (a PUT with a header) with a hop limit of 1, so it cannot read the host role's credentials.
- A brain host's egress: see [brain hosts](../../compute/brain-hosts/). Nothing is decrypted.
- When the brain host's lease lapses (20 s), nestd stops every runner process on the host. FleetDO expires the host at 30 s, AgentDO releases the brain record, and the brain starts again on another brain host with `--resume`.

**Epochs:** AgentDO issues an agent epoch per brain start (`agent_start.epoch`) and keeps one brain record; a session is current only at that record's epoch, and not once AgentDO condemned it. The session hello presents it, `agent_started` and every `agent_exited` name it (an exit releases the record only at its epoch or later), and every event carries it. A brain's epoch is fixed at its start: a later start for the agent ends it, never adopts it. A kill names its epoch: the runner keeps it as the agent's tombstone, kills a brain at or below it, spares a newer one, never registers a start at or below it, and reports such a start's exit only once any older brain of the agent is gone. A start refused before it registers (a kill's tombstone, no lease, a forbidden built-in) ends any older brain of the agent and reports its exit only once that brain is gone. The sandbox epoch travels inside the binding on every hands call. Where a brain runs and where its sandbox runs are unrelated: the brain host's lease fences the brain, and the sandbox host's lease and epoch fence the sandbox; a sandbox move changes neither the brain nor its epoch ([AgentDO](../../control-plane/durable-objects/agent/)). Not built: the agent epoch on brokered actions. A command from the previous release's control plane carries no `epoch`; the runner then uses its `hands.epoch` (`0` without hands), as that release did.

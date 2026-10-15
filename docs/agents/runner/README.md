# Agent runner

A Rust component on every host that runs brains:
- **On burst hosts,** for agents whose sandboxes live there. RPC to their hands is local vsock.
- **On the controller host,** for agents without hands.

## Invocation (agent with hands)

The canonical command line, environment and managed settings are in [../../interfaces/host-internal/runner-claude/](../../interfaces/host-internal/runner-claude/) (built by `nest_protocol::host::claude`). In short:

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
- **Version pinned:** a minimum version checked with `claude --version` at start, and updates off (`DISABLE_UPDATES=1`). The session JSONL is an internal format that "changes between versions" ([sessions](https://code.claude.com/docs/en/sessions)), so resume is tested on every upgrade.
- **The working directory is an empty host directory,** so a repo's `.claude/settings.json` hooks and `.mcp.json` can never load. If they did, they would run *on the host*. The repo's CLAUDE.md is passed in as text by our `SessionStart` hook, read through hands.
- **System prompt:** `--append-system-prompt-file` keeps Claude Code's coding prompt and adds the spawn spec's text, which explains that the hands tools work like the built-ins. A spec with `system_prompt.mode: replace` and no built-ins (the `captain` template, for example) gets `--system-prompt-file` and `--tools ""` instead.
- **Host-side built-ins are refused** (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, …) at start, and a brain whose `system/init` reports one is killed.
- **Never use `--bare`** (it ignores OAuth) or **`--safe-mode`** (it stops MCP servers from loading).

## Auth

- **Token:** `claude setup-token` is the same browser OAuth as `/login` and produces a one-year token that can only make model requests. I run it once; the token is stored in BrokerDO and handed to each process as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Clean environment:** the runner builds the process environment explicitly (the token, `CLAUDE_CONFIG_DIR`, and nothing inherited). That stops any `ANTHROPIC_*` variable from taking over: `CLAUDE_CODE_OAUTH_TOKEN` ranks below `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY` and `apiKeyHelper` ([authentication](https://code.claude.com/docs/en/authentication)). `NEST_*` values for `nest mcp` go in the MCP config's `env` block, since whether the subprocess environment scrub keeps them is undocumented.
- **Managed settings** set `forceLoginMethod: "claudeai"` and `allowedProviders: ["anthropic"]`, so Claude Code refuses to start with an API key or a custom endpoint. (To verify in the spike: that `CLAUDE_CODE_OAUTH_TOKEN` is accepted under `forceLoginMethod`.)
- **Startup check:** the runner confirms `claude auth status` reports `authMethod: "oauth_token"`. This also catches `--bare` becoming the default for `-p`.
- **Compliance:**
  - The binary is unmodified.
  - It's my own subscription, for personal use. `setup-token` is documented for scripts and CI ([authentication](https://code.claude.com/docs/en/authentication)). Products built for others should use API keys ([Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)), so anything multi-user needs written clearance first ([legal](https://code.claude.com/docs/en/legal-and-compliance)).
  - Only documented flags are used.
  - No proxy decrypts or injects the OAuth token.

## Lifecycle

- **Start registers first,** then runs the slow steps (session rebuild, `auth status`, `--version`) with timeouts; a fence, stop or lease lapse during startup cancels it. A duplicate `agent_start` never touches the live brain. Starting needs a valid lease.
- **Running:** one long-lived process per active agent. Messages written to stdin during a turn are queued; stdin has its own writer task, so a kill never waits on it.
- **Turn tracking:** each user message (turn or inbox) is counted against `result`s; if a `result` leaves messages outstanding and Claude Code shows no further activity for 10 s, they were merged into that turn.
- **Interrupt:** the stream-json control message (check for `interrupt_receipt_v1`). Fallback: SIGINT to the Claude Code pid only, then SIGKILL of its process group.
- **Idle:** after a grace period, close stdin so the process exits. A turn or inbox message arriving while it exits restarts Claude Code with `--resume` and is replayed; after that, the next turn starts a new brain with `--resume`.
- **Exit:** the last stdout lines are processed before the exit is handled; the session channel keeps flushing (and reconnecting) for up to 30 s until AgentDO has acked every event and the session bytes are durable.
- **Unattended runs:** `--permission-prompts none` makes Claude Code deny without prompting and tell the model not to retry ([headless](https://code.claude.com/docs/en/headless)). Escalation comes from our own `PreToolUse` hook: a call no rule allows is held with `defer`, which ends the process; once approved, the brain resumes and the same call runs ([hooks](https://code.claude.com/docs/en/hooks)). `defer` handles one tool call per turn and works only under `-p`; to verify with stream-json in the spike.
- **Stream parsing:** hook events can precede `system/init`, so the parser accepts them.

## Process hygiene

- **Planned, not built:** each agent as a systemd unit (`DynamicUser`, `ProtectSystem=strict`, a private `/tmp`, write access only to its `CLAUDE_CONFIG_DIR`). Today every brain runs as the runner's user in its own process group, so brains on one host can read each other's environment (and OAuth token) through `/proc`; only host code execution could exploit that.
- **Hook and MCP peers are bound to brains:** the sync hook socket and the `nest mcp` bridge accept an agent id only from a process descending from that agent's Claude Code (`SO_PEERCRED` + `/proc` ancestry). The tailer only follows session files under the agent's `<config_dir>/projects/`.
- Egress is limited to Anthropic's hosts (every host Claude Code contacts, per its network config docs), the control plane, and WebFetch through the host allowlist. Nothing is decrypted.
- On self-fence, nestd stops every runner process on the host.

**Placement:** a brain runs on the host of its sandbox, so the host's lease and epoch cover both. If the two are ever split across hosts, agents will need their own epoch.

# Agent runner

A Rust component on every host that runs brains:
- **On burst hosts,** for the workers whose sandboxes live there. RPC to their hands is local vsock.
- **On the controller host,** for captains, which have no hands.

## Invocation (worker)

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

The system prompt text comes from the control plane (`LaunchConfig.system_prompt`) and is written into the agent's config dir; nothing captain- or worker-specific lives on the host.

- **`--tools`** keeps only the built-ins that don't touch the host's files or run commands there: the task list, subagents, and WebSearch/WebFetch (which send traffic from the host through its egress allowlist). The exact list is checked against Claude Code's tools reference. Every file and shell operation goes through [hands](../hands/).
- **`--restricted`** loads only managed settings and `--settings`, and refuses `bypassPermissions`.
- **The working directory is an empty host directory,** so a repo's `.claude/settings.json` hooks and `.mcp.json` can never load. If they did, they would run *on the host*. The repo's CLAUDE.md is passed in as text by our `SessionStart` hook, read through hands.
- **System prompt:** `--append-system-prompt-file` keeps Claude Code's coding prompt and adds the control plane's worker text, which explains that the hands tools work like the built-ins. Captains use `--system-prompt-file` and `--tools ""` instead.
- **Host-side built-ins are refused** (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, …) at start, and a brain whose `system/init` reports one is killed.
- **Never use `--bare`** (it ignores OAuth) or **`--safe-mode`** (it stops MCP servers from loading).

## Auth

- **Token:** `claude setup-token` is the same browser OAuth as `/login` and produces a one-year token that can only make model requests. I run it once; the token is stored in BrokerDO and handed to each process as `CLAUDE_CODE_OAUTH_TOKEN`.
- **Clean environment:** the runner builds the process environment explicitly (the token, `CLAUDE_CONFIG_DIR`, and nothing inherited). That stops any `ANTHROPIC_*` variable from taking over, since those come first in credential precedence.
- **Managed settings** set `forceLoginMethod: "claudeai"` and `allowedProviders: ["anthropic"]`, so Claude Code refuses to start with an API key or a custom endpoint. (To verify in the spike: that `CLAUDE_CODE_OAUTH_TOKEN` is accepted under `forceLoginMethod`.)
- **Startup check:** the runner confirms `claude auth status` reports `authMethod: "oauth_token"`. This also catches `--bare` becoming the default for `-p`.
- **Compliance:**
  - The binary is unmodified.
  - It's my own subscription, for personal use.
  - Only documented flags are used.
  - No proxy decrypts or injects the OAuth token.

## Lifecycle

- **Start registers first,** then runs the slow steps (session rebuild, `auth status`, `--version`) with timeouts; a fence, stop or lease lapse during startup cancels it. A duplicate `agent_start` never touches the live brain. Starting needs a valid lease.
- **Running:** one long-lived process per active agent. Messages written to stdin during a turn are queued; stdin has its own writer task, so a kill never waits on it.
- **Turn tracking:** each user message (turn or inbox) is counted against `result`s; if a `result` leaves messages outstanding and Claude Code shows no further activity for 10 s, they were merged into that turn.
- **Interrupt:** the stream-json control message (check for `interrupt_receipt_v1`). Fallback: SIGINT to the Claude Code pid only, then SIGKILL of its process group.
- **Idle:** after a grace period, close stdin so the process exits. A turn or inbox message arriving while it exits restarts Claude Code with `--resume` and is replayed; after that, the next turn starts a new brain with `--resume`.
- **Exit:** the last stdout lines are processed before the exit is handled; the session channel keeps flushing (and reconnecting) for up to 30 s until AgentDO has acked every event and the session bytes are durable.
- **Unattended runs:** `--permission-prompts none`. Anything denied is turned into an `ask()`.

## Process hygiene

- **Planned, not built:** each agent as a systemd unit (`DynamicUser`, `ProtectSystem=strict`, a private `/tmp`, write access only to its `CLAUDE_CONFIG_DIR`). Today every brain runs as the runner's user in its own process group, so brains on one host can read each other's environment (and OAuth token) through `/proc`; only host code execution could exploit that.
- **Hook and MCP peers are bound to brains:** the sync hook socket and the `nest mcp` bridge accept an agent id only from a process descending from that agent's Claude Code (`SO_PEERCRED` + `/proc` ancestry). The tailer only follows session files under the agent's `<config_dir>/projects/`.
- Egress is limited to Anthropic's hosts (every host Claude Code contacts, per its network config docs), the control plane, and WebFetch through the host allowlist. Nothing is decrypted.
- On self-fence, nestd stops every runner process on the host.

**Placement:** a brain runs on the host of its sandbox, so the host's lease and epoch cover both. If the two are ever split across hosts, agents will need their own epoch.

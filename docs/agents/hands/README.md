# Hands

MCP tools that act on the agent's bound sandbox. `nest mcp` (a stdio shim Claude Code spawns on the host) forwards them to the agent runner, which calls the [guest agent](../../sandbox/guest-agent/) over vsock RPC. The exact schemas are in `protocol/schemas/guest/hands-tools.json`; the wire semantics are in [../../interfaces/host-guest/](../../interfaces/host-guest/).

| Tool | Modeled on | Semantics |
|---|---|---|
| `Bash` | Bash | Per-agent **cwd persists** across calls (exported variables don't: each call is a fresh `bash -c`). Timeouts (default 2 min, max 10), `run_in_background`, output truncation like the built-in. If the cwd disappeared, the command runs in the slot's cwd (or `/`) and the output starts with a `nest:` warning. |
| `TaskOutput` / `TaskStop` | Background shell tools | Poll (optionally blocking) or kill background jobs |
| `Read` | Read | Line-numbered output, `offset`/`limit`, images as MCP image content, PDFs (`pages`), notebooks. **Regular files only** (FIFOs, sockets and devices are refused; use Bash). Whole-file reads are capped at 256 KB; `offset`/`limit` reads stream and stop counting lines after 1 GiB. |
| `Write` | Write | **Must read before overwriting**, and **rejected if the file changed since the read** (size or content; an mtime-only change such as `touch` is fine). |
| `Edit` | Edit | Exact-string replace, `replace_all`, must read first. If the file changed since the read, a **unique** match still applies and the result is flagged `changed_since_read` with a note. Files over 16 MB go through Bash. |
| `Glob` / `Grep` | Glob / Grep | Glob: newest 100 matches, at most 500k entries walked. Grep: ripgrep in the guest with the same output modes and limits, output capped at 16 MB, 2 min timeout. |

- **Writes go through symlinks and keep hard links** (in-place write, like Claude Code's own Write; not atomic). Missing parent directories are created.
- **Everything runs as the sandbox user.** Bash, Grep and helpers (pdftotext, vips, convert) are spawned as that uid with the agent's environment (`HOME`, `USER`, `LOGNAME`, `SHELL` from passwd, plus `NEST_AGENT_ID` and `HTTP(S)_PROXY`). Read/Write/Edit/Glob run inside the guest agent with the user's **filesystem identity** (per-thread `setfsuid`/`setfsgid`), so permission checks and new files' ownership are the user's, not root's.
- **Per-agent exec context:** every call carries the agent ID. The guest runs processes in that agent's cgroup (for accounting and `cgroup.kill` on interrupt).
- **Cancellation:** an MCP cancel or a hard interrupt kills the call's process tree; in-process file tools return `[Interrupted]` and are abandoned after 2 minutes at most.
- **Unbound agents** (captains, or agents that are detached) get a clear error.
- **Schemas and descriptions are copied closely** from Claude Code's built-ins to keep them familiar to the model. Tools appear as `mcp__nest__<Name>`.
- **Fidelity risk:** the built-ins are heavily tuned. **Spike:** run the same tasks with native tools (Claude Code inside a VM) and with hands over RPC, and compare success rate, number of turns and token use.
- **Rejected alternative:** native tools redirected with `CLAUDE_CODE_SHELL_PREFIX` plus a filesystem mount. The prefix also wraps hooks and MCP server startup, the command it receives includes setup that refers to local files, Firecracker has no virtiofs, and pointing the working directory at the repo would let the repo's config load on the host.

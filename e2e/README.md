# End-to-end harness

`./run.sh` runs the **real** components together on one machine, without root or KVM, and checks a scenario end to end. A full run takes about 35 s once binaries are built. One machine plays both host kinds: the runner here reaches the guest over the vsock emulator directly. **Not built:** the [gateway](../docs/sandbox/gateway/) and the hands client, after which the harness runs the fake brain against a gateway on localhost and the brain and the sandbox can be on different machines.

```
wrangler dev --local (control plane, :18787)          ← outside any namespace
unshare --user --map-root-user --mount  (inner.sh)    ← host network shared
  ├─ nest-proxy   (unprivileged; listeners handed over by nestd)
  ├─ nestd        (enrolls with a one-time token; `process` driver; creates one netns per sandbox)
  │    └─ nest-guest   (in the sandbox netns, behind the unix-socket vsock emulator)
  └─ nest-runner  (brains = e2e/fake_claude.py, or real `claude`; hands through the real `nest mcp` bridge)
```

**By default the real `claude` binary is never invoked.** `fake_claude.py`, adapted from `crates/nest-cli/tests/fake_claude.py`, speaks stream-json, runs hooks through `nest hook`, and drives `nest mcp`. A turn whose text is `E2E <scenario.json>` runs scripted tool calls and appends each result to a JSONL file immediately. The real binary is used only by [real-Claude mode](#real-claude-code) and `claude-verify/`.

## What it checks

1. **Startup:** enrollment and fleet connection; a sandbox is placed on the host; a worker agent is created and its brain starts.
2. **Hands, through MCP → runner → vsock emulator → nest-guest:**
   - `Bash`: `pwd`; cwd persists across calls; exported variables don't (Claude Code's semantics); the exec env carries `NEST_AGENT_ID` and `HTTPS_PROXY`
   - `Write`, `Read`, `Edit`, `Read`
3. **Egress, through the real nest-proxy:**
   - an allowed host (`registry.npmjs.org`, base layer) returns **200**, trusting the control plane's dev root CA
   - a denied host (`example.com`): the CONNECT is accepted, then an **HTTP 403 with a JSON reason** (`egress_denied`) is served inside the tunnel over the dev CA's TLS
   - **credential injection:** the sandbox policy (set through `POST /v1/sandboxes {policy}`) binds a placeholder to `httpbin.org`, and the secret is stored with `PUT /v1/admin/secrets/inject:httpbin`. `curl -H 'Authorization: Bearer <placeholder>' https://httpbin.org/headers` returns 200. The echoed header is masked to the **secret's** length (not the placeholder's), so the upstream got the real secret and the proxy scrubbed it on the way back.
   - a direct connection with no proxy fails (no route)
   - from inside the sandbox netns: no route out, and the proxy listener on `172.16.0.1:443` is reachable
4. **Platform tool:** `notify` reaches the workstream's user-notification queue.
5. **Control plane state:**
   - the session transcript is in R2 (read through `GET /v1/agents/<id>/transcript`)
   - the turn is `done`; workstream events are visible
   - the egress audit (allowed and denied records) is in R2 under `audit/…`
6. **Fencing:** the control plane is stopped. nestd self-fences within about 20 s; runner brains are killed; the guest is paused (SIGSTOP); proxy listeners are dropped.

**Skipped, with the reason printed:**
- **Transparent `:443` interception.** The process driver runs the guest in the netns itself, with no tap0 peer, so nft's tap0 redirect can't apply. nestd's `netns_redirect_reaches_listener` test covers it.

## Running

```bash
e2e/run.sh            # builds with CARGO_TARGET_DIR=target/e2e (release), runs, cleans up
```

- **Requirements:** cargo, node/npm (`control-plane/node_modules` is installed if missing), `unshare`/`nsenter` with unprivileged user namespaces, curl, and internet access for `registry.npmjs.org` and `httpbin.org`.
- **Outputs:** each run starts from a fresh `e2e/.work/` (git-ignored). It holds logs in `logs/`, `summary.json`, the wrangler state, and the scenario files.
- **Env:**
  - `NEST_E2E_PORT` (default 18787)
  - `NEST_E2E_WORK` (work dir)
  - `NEST_E2E_FENCE_BUDGET_S` (default 30)
  - `NEST_E2E_CLAUDE` (`fake`, the default, or `real`; see below)
- **Exit code:** non-zero if any check fails; 2 if real mode is skipped.

## Real Claude Code

Both tools below need the owner's token (from `claude setup-token`) in **`NEST_CLAUDE_OAUTH_TOKEN`**. Without it they print why and exit **2** (skipped). They need no KVM, so they run in the cloud dev environment.

```bash
e2e/claude-verify/run.py                  # probe the binary: e2e/.work/claude-verify/report.{md,json}
e2e/claude-verify/run.py --only 6,9       # some items only (--list names them)
NEST_E2E_CLAUDE=real e2e/run.sh           # the harness above with a real brain
python3 -m unittest discover -s e2e/claude-verify   # probe-harness tests, no token needed
```

### `claude-verify/`: the verification probes

`run.py` drives `claude` directly with nest's argv, env and managed settings (mirrors of `nest_protocol::host::claude` and `protocol/claude-code/managed-settings.json`), with every hook pointed at `hook_logger.py` and the `nest` MCP server replaced by `mcp_logger.py`, which log their full input and a summary of their environment (names, `NEST_*` values, value hashes). One probe per item of the verify list in [docs/README.md](../docs/README.md); each reports `pass` (nest's assumption holds), `fail` (it doesn't), `inconclusive` or `skipped`, with evidence.

| # | Item | How |
|---|---|---|
| 1 | Token under `forceLoginMethod: "claudeai"`; `auth status` JSON | `claude auth status` (`authMethod`, `configDirectory`), `init.apiKeySource`, a one-word turn succeeds |
| 2 | `system/init` before the first user message | wait 10 s with nothing on stdin; hook log and stdout timestamps around `init`; a run with `--include-hook-events` |
| 3 | User message without `session_id` | the baseline turn uses the runner's exact stdin line |
| 4 | `_meta` key carrying the tool-use id | the full MCP `tools/call` request vs `PreToolUse.tool_use_id` and the stream's `tool_use.id` |
| 5 | `--restricted` honors `--tools` | `init.tools` vs the worker list; a captain run with `--tools ""` |
| 6 | `notifications/cancelled` on interrupt | the stream-json interrupt during a 120 s `mcp__nest__sleep` |
| 7 | The env scrub keeps `NEST_*` | hook and MCP-server environments (names, `NEST_*` values, value hashes to spot the token); a run without `CLAUDE_CODE_MCP_ALLOWLIST_ENV` |
| 8 | Transcript path encoding | `SessionStart.transcript_path` for a cwd with `.` and `_`, and for one over 200 characters (the hash suffix is identified when it can be) |
| 9 | `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `PreToolUse` `defer` | SIGKILL mid tool call, then `--resume` with no input; a `defer` answer, then `--resume` (does the same `tool_use_id` re-run?) |
| 10 | `SessionStart` after compaction | `/compact` over stdin (again without `--disable-slash-commands` if needed); inconclusive if compaction can't be triggered |

- **Quota:** about eight one-line turns plus a compaction on `haiku`: roughly a dozen small requests, each carrying Claude Code's system prompt (mostly cached). The report records the client-side cost estimate.
- **Outputs:** `report.md`, `report.json`, and per probe `probes/<name>/` (stdin, stdout, stderr, hook and MCP logs, the config dir). `e2e/run.sh` wipes `e2e/.work/`, reports included.
- **Exit code:** 0 no `fail`; 1 a `fail`; 2 skipped.
- **Tests:** `stub_claude.py` stands in for the binary so every probe runs end to end without a token.

### `NEST_E2E_CLAUDE=real`: the harness with a real brain

The runner starts the real `claude`; the token becomes the control plane's `claude_oauth_token` secret instead of the fake value, and the worker gets the default launch config with `NEST_CLAUDE_MODEL`. The turn is a short natural-language request to run `pwd`, write a file, read it, edit it and read it again, then write a Python program that computes F(90) and run it, all with the `mcp__nest__` tools: the sandbox has to do real work, not only move bytes. Checks that tolerate model variation replace the scripted ones:
- the turn finishes (`done`)
- the file in the sandbox has the expected content
- the Python program it wrote runs and prints F(90)
- the transcript has `mcp__nest__` tool uses and no host-side built-ins

Startup, netns, control-plane state and fencing checks run as in fake mode; the scripted hands, egress, `notify` and audit checks are skipped. Quota: one turn with about six tool calls.

### Safety

- **Nothing global is touched.** Everything runs in a private mount namespace (`unshare --user --map-root-user --mount`). There, managed settings are bind-mounted at `/etc/claude-code` (over an overlay of `/etc` when the directory doesn't exist), and the invoking user's `~/.claude` and `~/.claude.json` are masked with empty read-only mounts. Each probe has its own `CLAUDE_CONFIG_DIR` (also `HOME`); working directories are under `/tmp`, so no repo `CLAUDE.md` is loaded. The global binary is never updated (`DISABLE_AUTOUPDATER=1`).
- **The token goes only to the child,** as `CLAUDE_CODE_OAUTH_TOKEN` in an explicitly built environment (no inherited `ANTHROPIC_*`), never on a command line. Logs and reports are redacted, and afterwards every file under the work dir is scrubbed with a same-length mask (the control plane stores the secret in its SQLite state).
- **Bubblewrap:** Claude Code (2.1.300) refuses `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on Linux without it. If `bwrap` isn't on `PATH`, the tools extract it from the distro package into `e2e/.work/tools/` (`apt-get download`; nothing is installed) and set `sandbox.bwrapPath` in the namespace's managed settings. The probes record this as a deviation.

### Env

- `NEST_CLAUDE_OAUTH_TOKEN` (required), `NEST_CLAUDE_BIN` (default: `claude` on `PATH`), `NEST_CLAUDE_MODEL` (default `haiku`), `NEST_CLAUDE_BWRAP` (a bwrap binary)
- Probes: `NEST_CLAUDE_TURN_TIMEOUT_S` (120), `NEST_CLAUDE_INIT_WAIT_S` (10), `NEST_CLAUDE_VERIFY_WORK` (work dir)
- Real mode: `NEST_E2E_REAL_TURN_TIMEOUT_S` (300)

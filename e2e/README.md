# End-to-end harness

`./run.sh` runs the **real** components together on one machine, without root or KVM, and checks a scenario end to end. A full run takes about 35 s once binaries are built. One machine runs two hosts: a sandbox host (nestd, nest-proxy, the gateway, the guest) and a brain host (a second nestd with the brain role, the runner), each enrolled with its own token, with its own run and state directories, and each self-fencing on its own. The brain starts on the brain host, never the sandbox's, and the runner reaches the guest only the way a brain on another machine would: through the sandbox [gateway](../docs/sandbox/gateway/) on a loopback port, with a binding the control plane minted. What the harness cannot show is the tunnel, Cloudflare Access, and the two hosts on different machines.

```
wrangler dev --local (control plane, :18787)          ← outside any namespace
unshare --user --map-root-user --mount  (inner.sh)    ← host network shared
  ├─ sandbox host (run/, state/)
  │    ├─ nest-proxy    (unprivileged; listeners handed over by nestd)
  │    ├─ nestd         (role `burst`, a sandbox host; enrolls with a one-time token; `process` driver; one netns per sandbox; advertises gateway_url)
  │    │    └─ nest-guest   (in the sandbox netns, behind the unix-socket vsock emulator)
  │    └─ nest-gateway  (ws://127.0.0.1:18790; its own uid (1001 in the namespace), no capabilities; fed by nestd over gateway.sock; forwards hands calls to the guest's vsock port)
  └─ brain host (brun/, bstate/)
       ├─ nestd         (role `controller`, a brain host; its own token; no driver, proxy, gateway or netns)
       └─ nest-runner   (brains = the fake Claude Code, or real `claude`; hands through the real `nest mcp` bridge and the hands client)
```

**By default the real `claude` binary is never invoked.** `crates/nest-cli/tests/fake_claude.py`, the runner's own end-to-end fake, speaks stream-json, runs hooks through `nest hook` as the managed settings wire them, and drives `nest mcp`. A turn whose text is `E2E <scenario.json>` runs scripted tool calls and appends each result to a JSONL file immediately. The real binary is used only by [real-Claude mode](#real-claude-code) and `claude-verify/`.

## What it checks

1. **Startup:** both hosts enroll and connect; a sandbox is placed on the sandbox host; a worker agent is created and its brain starts on the brain host (the fleet view names each host's role).
2. **Hands, through MCP → runner → hands client → gateway → vsock emulator → nest-guest:**
   - `Bash`: `pwd`; cwd persists across calls; exported variables don't (Claude Code's semantics); the exec env carries `NEST_AGENT_ID` and `HTTPS_PROXY`
   - `Write`, `Read`, `Edit`, `Read`
3. **Egress, through the real nest-proxy:**
   - an allowed host (`registry.npmjs.org`, base layer) returns **200**, trusting the control plane's dev root CA
   - a denied host (`example.com`): the CONNECT is accepted, then an **HTTP 403 with a JSON reason** (`egress_denied`) is served inside the tunnel over the dev CA's TLS
   - **credential injection:** the sandbox policy (set through `POST /v1/sandboxes {policy}`) binds a placeholder to `httpbin.org`, and the secret is stored with `PUT /v1/admin/secrets/inject:httpbin`. `curl -H 'Authorization: Bearer <placeholder>' https://httpbin.org/headers` returns 200. The echoed header is masked to the **secret's** length (not the placeholder's), so the upstream got the real secret and the proxy scrubbed it on the way back.
   - a direct connection with no proxy fails (no route)
   - from inside the sandbox netns: no route out, and the proxy listener on `172.16.0.1:443` is reachable
4. **The seam:** the gateway's log shows at least as many bound connections as the scripted hands calls (the SessionStart CLAUDE.md read adds one), counted before the probes below run; the gateway was listening and had synced with nestd before the scenario, as its own uid with no capabilities (`/proc/<pid>/status`), so every call reached the guest through the sockets nestd gave its group; `POST /v1/sandboxes/<sbx>/resolve` returns a target whose URL is the advertised `gateway_url` and whose binding the gateway admits (`bound`, probed by `gateway_probe.mjs` with Node's WebSocket client); the same binding with one character of its signature flipped is refused `unauthorized` with `executed: false`; after the self-fence the still-valid binding is refused `moved`, and the log shows nestd removed the sandbox rather than the gateway losing its nestd link.
5. **Platform tool:** `egress_policy` (no arguments) answers the effective policy.
6. **Control plane state:**
   - the session transcript is in R2 (read through `GET /v1/agents/<id>/transcript`)
   - the turn is `done`; the agent's open asks are listable (`GET /v1/agents/<id>/asks`)
   - the egress audit (allowed and denied records) is in R2 under `audit/…`
7. **Remote MCP** (fake mode; needs the MCP test server, `mcp-test/`, run with `wrangler dev --local` on its own port): an mcp capability names the local server (a loopback URL, which only `ALLOW_LOOPBACK_MCP=1` admits) with its token in BrokerDO; an agent of a template listing it calls `echo`, `note_put`/`note_get` (and a missing note, a tool error) and `counter_add` as `mcp__nest__notes_<tool>`. The server's `GET /calls` shows each call once with nest's `_meta` (`nest/agent`, `nest/epoch`, a unique `nest/call`, and `nest/taint` true: the untrusted server's tool list tainted the session). Then the control plane is restarted while a `slow` call (made non-idempotent by the capability's `idempotent` override) is out at the server: the runner redelivers it to the new AgentDO incarnation, which answers `outcome_unknown`, and the server saw it once. Then `list_changed`: a second capability on the same server and credential (one connector) with no allowlist; the server gains a tool (`POST /tools?name=extra_live`), the brain's next call carries the server's `list_changed`, and without a restart the fake brain's tool list gets `live_extra_live` (it lists again on `nest mcp`'s `list_changed`, as Claude Code 2.1.316 does under `-p`: `claude-verify` item 13) and calls it; removing the tool takes it off the list.
   - **Over OAuth** (the server runs in its OAuth mode, `MCP_TEST_OAUTH=1`): a capability with `auth: {oauth: cap:onotes}`; the operator's `POST /v1/admin/capabilities/onotes/oauth` discovers the server's metadata and picks nest's client ID metadata document; the harness plays the browser (it follows the authorize URL with the server's static token as the user's login) and lands on nest's callback, whose state then works only once. A call carries the access token; after the server expires every token the next call is refused, refreshed once and runs once; after it revokes them the call is a platform error naming re-authorization, and the next one doesn't ask the authorization server again; a second authorization recovers. The broker's audit records are in R2.
8. **Agent lifetimes** (fake mode; [lifetimes](../docs/agents/#lifetimes)): a parent agent (no hands) spawns a child with `agent_spawn {sandbox: new}`, whose task (an agent's message, `E2E <scenario>`) runs a hands call and `exit {destroy_sandbox: true}`; once its brain exits, its sandbox is `destroyed` and the cell's GC registry counts one live sandbox fewer, and a turn for it is refused (404). A second child the parent stops with `agent_stop {destroy_sandbox: true}`: killed, its sandbox destroyed, both in the parent's `children` as ended. Then the operator ends the parent (`POST /v1/agents/<id>/stop {end: true}`), freeing its brain slot.
9. **Fencing:** the control plane is stopped. Each host's nestd self-fences within about 20 s; the brain host's runner brains are killed; the guest is paused (SIGSTOP); proxy listeners are dropped; the gateway refuses the sandbox's still-valid binding as `moved`.

**Skipped, with the reason printed:**
- **Transparent `:443` interception.** The process driver runs the guest in the netns itself, with no tap0 peer, so nft's tap0 redirect can't apply. nestd's `netns_redirect_reaches_listener` test covers it.

## Running

```bash
e2e/run.sh            # builds with CARGO_TARGET_DIR=target/e2e (release), runs, cleans up
```

- **Requirements:** cargo, Node 22 or newer with npm (the gateway probe uses Node's global WebSocket client; `control-plane/node_modules` is installed if missing), `unshare`/`nsenter` with unprivileged user namespaces, curl, and internet access for `registry.npmjs.org` and `httpbin.org`. The gateway runs as its own uid, as on a host, so the harness also needs `newuidmap`/`newgidmap` (package `uidmap`) and a subordinate uid and gid range of at least 1001 for your user in `/etc/subuid` and `/etc/subgid`, and a work directory that other users can reach: a repo under a `0700` home needs `NEST_E2E_WORK=/var/tmp/nest-e2e-<tag>` (the harness says so and stops). It runs a copy of `nest-gateway` from the work directory for the same reason.
- **Outputs:** each run starts from a fresh `e2e/.work/` (git-ignored). It holds logs in `logs/`, `summary.json`, the wrangler state, and the scenario files.
- **Env:**
  - `NEST_E2E_PORT` (default 18787)
  - `NEST_E2E_GATEWAY_PORT` (default 18790)
  - `NEST_E2E_WORK` (work dir)
  - `NEST_E2E_FENCE_BUDGET_S` (default 30)
  - `NEST_E2E_MCP_DIR` (the MCP test server's directory; default `mcp-test/`, skipped when absent), `NEST_E2E_MCP_PORT` (default 18788)
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
| 11 | `PostToolUse` `additionalContext` reaches the model mid-turn | the context after a tool call orders an `mcp__nest__echo` call with a random token; three turns (after `mcp__nest__echo`, after the built-in `TaskList`, inside an `Agent` subagent) and a control turn with no context. Seen = the token is produced, or (subagent) its reply mentions the instruction |
| 12 | `Stop` `block` | the first `Stop` blocks with a reason ordering an echo with a token: `result` lines before and after the continuation's `Stop`, `stop_hook_active`, whether the model acted on the reason; then a plain second turn |
| 13 | `tools/list_changed` from a stdio server | `mcp_logger.py --grow-after-call late_echo` adds a tool and sends `list_changed` after the first `tools/call`: when `tools/list` comes again, whether the next turn's `system/init` names it, whether the model calls it by name in that second turn; then a one-turn session where the list grows between two calls |

- **Quota:** about eight one-line turns plus a compaction on `haiku`, items 11 and 12 add six short turns in three sessions, and item 13 three in two: roughly twenty small requests, each carrying Claude Code's system prompt (mostly cached). The report records the client-side cost estimate.
- **Observed evidence** worth keeping is committed under `claude-verify/observed/` (named by Claude Code version), redacted like the report.
- **Outputs:** `report.md`, `report.json`, and per probe `probes/<name>/` (stdin, stdout, stderr, hook and MCP logs, the config dir). `e2e/run.sh` wipes `e2e/.work/`, reports included.
- **Exit code:** 0 no `fail`; 1 a `fail`; 2 skipped.
- **Tests:** `stub_claude.py` stands in for the binary so every probe runs end to end without a token.

### `NEST_E2E_CLAUDE=real`: the harness with a real brain

The runner starts the real `claude`; the token becomes the control plane's `claude_oauth_token` secret instead of the fake value, and the worker gets the default launch config with `NEST_CLAUDE_MODEL`. The turn is a short natural-language request to run `pwd`, write a file, read it, edit it and read it again, then write a Python program that computes F(90) and run it, all with the `mcp__nest__` tools: the sandbox has to do real work, not only move bytes. Checks that tolerate model variation replace the scripted ones:
- the turn finishes (`done`)
- the file in the sandbox has the expected content
- the Python program it wrote runs and prints F(90)
- the transcript has `mcp__nest__` tool uses and no host-side built-ins
- the OAuth token is in neither the guest's nor the gateway's environment or command line

Startup, netns, control-plane state and fencing checks run as in fake mode; the scripted hands, egress, platform tool and audit checks are skipped. Quota: one turn with about six tool calls.

### Safety

- **Nothing global is touched.** Everything runs in a private mount namespace (`unshare --user --map-root-user --mount`). There, managed settings are bind-mounted at `/etc/claude-code` (over an overlay of `/etc` when the directory doesn't exist), and the invoking user's `~/.claude` and `~/.claude.json` are masked with empty read-only mounts. Each probe has its own `CLAUDE_CONFIG_DIR` (also `HOME`); working directories are under `/tmp`, so no repo `CLAUDE.md` is loaded. The global binary is never updated (`DISABLE_AUTOUPDATER=1`).
- **The token goes only to the child,** as `CLAUDE_CODE_OAUTH_TOKEN` in an explicitly built environment (no inherited `ANTHROPIC_*`), never on a command line. Logs and reports are redacted, and afterwards every file under the work dir is scrubbed with a same-length mask (the control plane stores the secret in its SQLite state).
- **Bubblewrap:** Claude Code (2.1.300) refuses `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` on Linux without it. If `bwrap` isn't on `PATH`, the tools extract it from the distro package into `e2e/.work/tools/` (`apt-get download`; nothing is installed) and set `sandbox.bwrapPath` in the namespace's managed settings. The probes record this as a deviation.

### Env

- `NEST_CLAUDE_OAUTH_TOKEN` (required), `NEST_CLAUDE_BIN` (default: `claude` on `PATH`), `NEST_CLAUDE_MODEL` (default `haiku`), `NEST_CLAUDE_BWRAP` (a bwrap binary)
- Probes: `NEST_CLAUDE_TURN_TIMEOUT_S` (120), `NEST_CLAUDE_INIT_WAIT_S` (10), `NEST_CLAUDE_VERIFY_WORK` (work dir)
- Real mode: `NEST_E2E_REAL_TURN_TIMEOUT_S` (300)

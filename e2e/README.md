# End-to-end harness

`./run.sh` runs the **real** components together on one machine, without root or KVM, and checks a scenario end to end. A full run takes about 35 s once binaries are built.

```
wrangler dev --local (control plane, :18787)          ← outside any namespace
unshare --user --map-root-user --mount  (inner.sh)    ← host network shared
  ├─ nest-proxy   (unprivileged; listeners handed over by nestd)
  ├─ nestd        (enrolls with a one-time token; `process` driver; creates one netns per sandbox)
  │    └─ nest-guest   (in the sandbox netns, behind the unix-socket vsock emulator)
  └─ nest-runner  (brains = e2e/fake_claude.py; hands through the real `nest mcp` bridge)
```

**The real `claude` binary is never invoked.** `fake_claude.py`, adapted from `crates/nest-cli/tests/fake_claude.py`, speaks stream-json, runs hooks through `nest hook`, and drives `nest mcp`. A turn whose text is `E2E <scenario.json>` runs scripted tool calls and appends each result to a JSONL file immediately.

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
- **Exit code:** non-zero if any check fails.

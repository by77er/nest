# Host ↔ guest (vsock)

How the host side (nestd and the [gateway](../../sandbox/gateway/)) talks to the **guest agent** inside a sandbox VM. Clients elsewhere (brains, terminals, browsers) reach these ports only through the gateway ([gateway contract](../gateway/)). Rust types: `nest_protocol::guest`. Fixtures: `protocol/fixtures/guest/`. MCP tool schemas: `protocol/schemas/guest/hands-tools.json`.

> **Implemented contract (version 1), plus version 2 (designed).** Items marked **v2** aren't built; they're listed under [pending contract changes](../README.md#pending-contract-changes) until they land. Design: [guest agent](../../sandbox/guest-agent/), [hands](../../agents/hands/).

## Transport

Firecracker virtio-vsock in **hybrid mode**. The guest has CID **3** and the host CID 2. Every connection is **host-initiated**:

1. Connect to the VM's vsock unix socket, which is configured per VM (e.g. `/run/nest/vm/<sbx>/vsock.sock`).
2. Write `CONNECT <port>\n`.
3. Read `OK <host_port>\n`. Firecracker closes the socket if nothing listens on `<port>`, which means "guest not ready" and is retried with backoff.

The guest agent listens on `AF_VSOCK` ports and **accepts only peer CID 2 (the host)**: with vsock loopback in the guest kernel, a process inside the sandbox could otherwise connect to control, hands or ingress. **Guest-initiated connections are not used**: the guest sends everything over the control connection the host keeps open.

| Port | Channel | Lifetime | Opened by |
|---|---|---|---|
| **1024** | Control: `ControlFrame` both ways | one persistent connection | nestd |
| **1025** | Hands RPC: `HandsRequest` → `HandsResponse`s | **one connection per tool call** | the gateway, for each client call (the runner's hands client, AgentDO, a `call_status` lookup) |
| **10000** | Ingress: `IngressRequest` → `IngressResponse`, then raw TCP or framed PTY | one connection per stream | the gateway (previews, terminals, port-forwards) |

**Test transport (no KVM):** an emulator that accepts on one unix socket, speaks the same handshake, and dispatches each connection to the guest agent's handler for that port. The guest agent takes a `--listen unix:<dir>` option to listen on `<dir>/<port>.sock` instead of vsock, and the emulator bridges `CONNECT <port>` to it. Host code is identical in both modes, because it always talks to "a unix socket that speaks CONNECT". The helpers in `guest::handshake` implement both sides.

### Why one connection per call, not multiplexing

- **Cancellation is a hangup.** Closing a hands connection (or sending `cancel`) kills exactly that call's cgroup. No call IDs to route and no half-cancelled state.
- **No head-of-line blocking or custom flow control.** Concurrent tool calls (parallel tool use, several agents), streaming PTYs and large previews each get their own vsock stream with kernel flow control.
- **Raw byte streams stay raw.** Ingress switches to plain bytes after one header. A multiplexed channel would need framing and window management for every byte of HTTP.
- **Failures stay isolated:** a stuck call can't wedge the control channel.
- **Connections are cheap:** a local vsock or unix connect plus a one-line handshake costs tens of microseconds, small next to any tool call.

The one persistent connection is **control**, because the guest needs a channel to push events (ports, CLI relay, task exits) and the host needs to know the agent is alive.

## Framing

```
frame := len:u32be  kind:u8  payload[len-1]        len ≤ 16 MiB (counts kind + payload)
kind  := 0x00 JSON (one UTF-8 JSON object)  |  0x01 DATA (opaque bytes)
```

- **Control and hands** use JSON frames only.
- **Ingress TCP:** one JSON frame each way (request, then `accepted`/`rejected`). After `accepted`, **both directions are raw bytes** until EOF. Half-close is propagated (shutdown of write on one side → shutdown on the other). Any bytes the decoder had already buffered past the header are the start of the raw stream (`Decoder::into_remainder`).
- **Ingress PTY** stays framed: `DATA` frames carry terminal bytes both ways, and JSON frames carry `PtyControl`.
- **Errors:** an oversized, empty or unknown-kind frame is a protocol error. The receiver closes the connection; on control it logs and reconnects.

## Control channel (port 1024)

`ControlFrame = {id?, reply_to?, type, ...}`. Requests carry a fresh `id` from the sender. Replies carry `reply_to` and are `ok`, `resume_done`, `health_report`, `cli_result` or `error`. Events carry neither.

| Type | Direction | Kind | Meaning |
|---|---|---|---|
| `hello` | guest → host | first frame | `protocol_version`, `agent_version`, `boot_id`, `instance_id`, `since_boot_ms`, `capabilities` |
| `configure` | host → guest | request | `sandbox_id`, `epoch`, `hostname`, complete `agents[]` set. Sent after every hello and on change. |
| `agent_attach` / `agent_detach` | host → guest | request | Add or remove one `AgentSlot`. `kill_processes` → `cgroup.kill` the agent subtree. |
| `resume` | host → guest | request | After a memory restore: `wall_clock_ms`, `entropy_b64` (64 bytes), optional `fork` identity. Reply `resume_done{clock_step_ms}`. |
| `flush` (v2) | host → guest | request | `syncfs` every filesystem. Reply `ok`, or `error{sync_failed}` on a writeback error. Precedes every commit, pause and suspend ([flush before commit](../../sandbox/state/disk/#flush-before-commit)). |
| `prepare_snapshot` | host → guest | request | `sync` (v2: the `flush` above, stopping on `sync_failed`); `drop_caches` → `echo 3 > /proc/sys/vm/drop_caches`; `fsfreeze` listed mounts. Reply `ok`. |
| `thaw` | host → guest | request | `fsfreeze -u` everything frozen. Idempotent. |
| `health` | host → guest | request | Reply `health_report` (load, memory, disks, per-agent cgroup usage). v2 (`diagnostics`): `drain_log_sites: true` adds `log_sites[{level, site, count}]` and `log_sites_dropped`, the guest agent's WARN/ERROR counts since the last drain, by site (module and line), never text. Only nestd's periodic probe drains. |
| `ports` | guest → host | event | **Full** set of listening TCP sockets. Sent after `configure` and on change (polled every 1 s, debounced). |
| `task_exited` | guest → host | event | A background task ended (exit, kill, time limit). |
| `cli` | guest → host | request | A `nest` CLI command from inside the sandbox. Host replies `cli_result`. |
| `error` | either | reply | `ErrorBody` |

**Rules:**
- **Startup order:** the guest must send `hello` before anything else. The host must send `configure` before any hands call is accepted. Until then, hands and ingress-PTY return `error{code: "busy", retryable: true}`.
- **Versions:** a v1 host requires an equal `protocol_version`; v2 accepts a [range](#versions-v2). Outside it, the host replies `error{unsupported_version}` and closes.
- **Fencing:** the guest stores `epoch` from the last `configure` and **rejects hands calls with a different epoch** (`stale_epoch`). nestd only ever raises the epoch, and the guest enforces it: a `configure` with a **lower** epoch is rejected with `error{stale_epoch}` and changes nothing.
- **Reconnects:** if the control connection drops (vsock resets on every snapshot restore), the host reconnects. The guest sends a new `hello`. `boot_id` is the kernel boot id (`/proc/sys/kernel/random/boot_id`; it survives a memory restore and changes on reboot) and `instance_id` is random per guest-agent process:

  | vs. previous hello | Meaning | Host sends |
  |---|---|---|
  | same `boot_id`, same `instance_id` | memory-snapshot restore | `configure`, then `resume` |
  | same `boot_id`, new `instance_id` | the guest agent restarted | `configure` |
  | new `boot_id` | reboot (cold boot) | `configure` |
- **Guest-side buffering:** `ports` and `task_exited` events produced while disconnected are buffered: latest `ports` only, and up to 1000 `task_exited`. They're flushed after the next `configure`.

### Versions (v2)

A memory snapshot keeps the guest agent it was taken with ([guest agent](../../sandbox/guest-agent/#versions)), so the host serves a range of guest versions.

- **Range:** nestd accepts a hello whose `protocol_version` is in `[MIN_SUPPORTED_PROTOCOL_VERSION, PROTOCOL_VERSION]` (`nest_protocol::guest`; 1 and 2). Outside it, nestd replies `error{unsupported_version}`, closes, and fails the sandbox's start or resume with that code at once, never by a readiness timeout.
- **Paused restores:** the check runs on `hello`, which a paused VM doesn't send. nestd never resumes a VM only to read it.
- **The host speaks the guest's version.** nestd passes the guest's `protocol_version` and `capabilities` to the gateway, and SandboxDO's `resolve` reports them to each client ([gateway](../gateway/)). Every `HandsRequest` carries the guest's version, and a guest refuses any other (`unsupported_version`).
- **Capabilities gate features,** not version numbers. The host sends a request only if the guest advertised it, and otherwise answers its own caller `unsupported`. A v2 guest answers a request `type`, `tool` or ingress `mode` it doesn't know with `error{unsupported, executed: false}` (on control, with `reply_to`), never a close or silence. A v1 guest replies `bad_request` without `reply_to`, so the host never relies on it.

| Capability | Since | Feature |
|---|---|---|
| `pty`, `cgroup_v2`, `pdf`, `fsfreeze` | 1 | PTYs, cgroup kills, PDF pages, `fsfreeze` |
| `flush` | 2 | the `flush` request |
| `call_status` | 2 | [call lookup](#refusals-and-call-records-v2) |
| `modified_files` | 2 | the change ledger in `call_status` |
| `heartbeat` | 2 | [heartbeats](#admission-and-liveness-v2) on hands calls |
| `pty_reattach` | 2 | [terminal reattach](#ingress-port-10000) |
| `diagnostics` | 2 | log-site counts in `health_report` |

**Legacy stays until `min_supported` passes it.** Each compatibility path is marked in code with the version that retires it:

| Kept for v1 guests | Host behavior | Retired when `min_supported` reaches |
|---|---|---|
| Hands `error` frames without `executed` | Treated as possibly executed: never retried | 2 |
| `HandsDetail::Bash` without `exit` | `exit` derived from `exit_code` and `signal` | 2 |
| No `flush` | `prepare_snapshot{}` (a plain `sync`, which reports no writeback error) stands in for it | 2 |
| CLI `notify`, `emit`, `ask` | Relayed to the control plane as `guest_cli` events | 2 |

**Release gate:** each release resumes a retained memory snapshot taken with the previous release's guest on the new host and runs every hands tool once (needs KVM). Without KVM, the host's decoders keep passing the fixtures of every version from `min_supported` up.

### Resume and fork

| Step | Action |
|---|---|
| Clock | `clock_settime(CLOCK_REALTIME, wall_clock_ms)`, then `chronyc makestep` if chrony is present. Reply with the step applied. |
| Randomness | Mix `entropy_b64` into the RNG with `RNDADDENTROPY` (Firecracker's VMGenID also triggers a kernel reseed on 6.x guests; we do both). |
| Fork (when `fork` is set) | Write `machine_id` to `/etc/machine-id`, set `hostname`, store `new_sandbox_id` for `nest whoami`. Old-identity caches (e.g. ssh host keys, if any) are the image's business. |
| Clients | Network connections are already dead: the netns listeners are new, and resetting is the clients' job. |

## Agent slots and exec context

`AgentSlot = {agent_id, proxy_port, cwd, env?, memory_max_bytes?}`. For every process the guest starts on an agent's behalf (hands exec, background task, agent PTY):

| Aspect | Value |
|---|---|
| User | The sandbox's normal user (uid 1000). Never root, unless `agent_root: shared` is baked into the image. Processes (Bash, tasks, PTYs, Grep, PDF/image helpers) `setuid` to it; Read/Write/Edit/Glob run in the guest agent with its **filesystem identity** (per-thread `setfsuid`/`setfsgid`/groups), so permission checks and ownership of created files and directories are the user's. |
| cgroup | `/sys/fs/cgroup/nest/agents/<agent_id>/` (unified hierarchy, with `memory.max` from the slot), containing `calls/<call_id>/` for each foreground call, `tasks/<task_id>/` for each background task, `pty/<n>/` for each terminal. Children join their leaf before exec; v2: a failed placement refuses the call. |
| OOM (v2) | The guest agent runs at `oom_score_adj` −1000; each child is reset to 0 before exec, and a failure refuses the call. |
| Environment | Image base env, then the user's `HOME`/`USER`/`LOGNAME`/`SHELL` (from passwd), then slot `env`, then `NEST_AGENT_ID=<agent_id>`, `HTTP_PROXY`/`HTTPS_PROXY`/`http_proxy`/`https_proxy=http://172.16.0.1:<proxy_port>`, `NO_PROXY=localhost,127.0.0.1,::1` |
| Files | `/run/nest/agents/<agent_id>/` (tmpfs), holding `calls/<call_id>.out` and `tasks/<task_id>.out` (combined output), `cwd` (persisted Bash working directory) and, v2, `calls/<call_id>.json` ([call records](#refusals-and-call-records-v2)). **Retention:** the newest 64 call outputs (≤256 MB) and the newest 32 finished tasks are kept per agent; older ones are deleted (finished tasks are also forgotten, so their IDs become `unknown_task`). |

**Interrupt:**
- A cancelled call → `cgroup.kill` on `calls/<call_id>`. **Background tasks survive** interrupts, matching Claude Code.
- **A hangup is a cancel,** whatever caused it, a runner restart included: hands calls get no detach grace (v2 terminals do).
- `agent_detach{kill_processes: true}` → `cgroup.kill` on the whole agent subtree, and the agent's output directory is deleted.

## Hands RPC (port 1025)

```
host → guest   HandsRequest {protocol_version, call_id, agent_id, epoch, op: {tool, ...input}}
               v2, read-only instead:  {"type":"call_status", ...}
guest → host   [started]  then  result{call_id, result{is_error, content[], detail}}  |  error{call_id?, error, executed?, retry_after_ms?}
               v2: heartbeat{call_id} after each 10 s without another frame
host → guest   (optional, any time)  {"type":"cancel"}   — or just close the connection
```

- **Input format:** `op` is the **MCP tool input, verbatim**, plus `"tool": "<Name>"`. The runner never translates fields. The guest ignores fields it doesn't know; a field `hands-tools.json` lists as rejected for its tool (one that would change the call's meaning) is refused by the runner with `unsupported` before any connection (v2).
- **`content`** maps 1:1 to MCP `CallToolResult.content` (`text`; `image` → `{"type":"image","data":…,"mimeType":…}`). `is_error` maps to MCP `isError`.
- **`detail`** is structured data for the runner, state tracking and the UI. It's **never shown to the model**.
- **`error`** frames mean the call wasn't executed (bad request, stale epoch, unknown agent). The runner returns them to the model as an MCP tool error whose text includes the code. v2: they carry `executed`, and the runner retries proven non-executions (below).
- **On cancel,** the guest kills the call's cgroup and, if the connection is still open, sends `result` with `detail.interrupted = true` and the partial output.

### Refusals and call records (v2)

- **`executed: false`** proves the call never reached its point of no return, so nothing ran and it's safe to retry. Every refusal before that point carries it: `duplicate_call`, `unsupported_version`, `unsupported`, `stale_epoch`, `unknown_agent`, `bad_request`, `busy`, and a failed cgroup or OOM-score setup. `retry_after_ms` hints when a retryable refusal may succeed. `call_id` is absent when the request frame was never read (frame memory).
- **Order of checks:** a `call_id` that already has a record or a live reservation for this agent is refused first (`duplicate_call`), so the answer can't depend on state that changed since. Then version, epoch, agent, admission, input, and preparation (cgroup, output file, read records). Only then is the record written and the effect started.
- **Runner retries:** a retryable `executed: false` refusal is retried on a new connection with the same `call_id` for up to 30 s, waiting `retry_after_ms` (default 1 s) between tries. A frame without `executed` (v1) is never retried.
- **Call records:** `calls/<call_id>.json` = `{call_id, epoch, tool, started_ms, ledger_pos?, outcome?: {is_error, exit?, interrupted?: cancel|hangup, output_path?, output_bytes?}}`, written at the point of no return and again at the end. The newest 1,024 per agent are kept, beyond output retention. They survive epoch changes and guest-agent restarts, not reboots. A restarted guest agent kills the cgroups of calls without an outcome; those stay unknown.
- **`call_status`** (capability `call_status`), on a port-1025 connection instead of a `HandsRequest`:

  ```
  host → guest   {"type":"call_status", protocol_version, agent_id, epoch, calls: [{epoch, call_id}]}
  guest → host   call_status{calls: [{epoch, call_id, state, record?, modified?}]}
  ```
  `epoch` must be current; the calls may be from any epoch. `state` is `finished`, `running`, `not_started` (no record, and the records cover that epoch: they start at the first epoch configured since boot) or `unknown` (a record without an outcome, or an epoch the records don't cover). `modified` (capability `modified_files`) is `{paths[], overflowed}`: what the [change ledger](../../sandbox/guest-agent/#change-ledger) saw modified since the call's `ledger_pos`.

### Admission and liveness (v2)

Design: [guest agent](../../sandbox/guest-agent/#admission).
- **First frame within 5 s** of `CONNECT`, or the guest closes the connection.
- **Frame memory:** the receiver reads a frame's length, then charges it to a budget of 1/16 of guest memory (16–64 MiB) before reading the payload. A frame that doesn't fit waits up to 2 s, then gets `error{busy, executed: false}` without a `call_id`.
- **Caps:** once the request is read, 16 hands calls per agent and 64 in total; 256 connections on the CLI socket. Over a cap, a call waits up to 2 s (64 waiters at most), then gets `error{busy, executed: false, retry_after_ms: 1000}`.
- **Reserved:** the control connection is separate, and `TaskStop` and `call_status` skip the caps. After its request, a hands connection accepts only `cancel` frames, so a cancel never waits for admission or memory.
- **Heartbeats** (capability `heartbeat`): `heartbeat{call_id}` after each 10 s without another frame. With them, the runner fails a call after 30 s without a frame; with any guest, at the tool's own deadline (Bash and TaskOutput `timeout`, 120 s for the rest) plus 15 s, SPACE's stall grace ([ecw_process.rs](https://github.com/perplexityai/space/blob/main/crates/libs/data/plane/server/src/ecw_process.rs)). It closes the connection, which cancels the call, and returns `outcome_unknown`.

### Tools

Field names, defaults and limits mirror Claude Code's built-in tools ([tools reference](https://code.claude.com/docs/en/tools-reference)). The MCP definitions are in `protocol/schemas/guest/hands-tools.json` and are exposed as `mcp__nest__<Name>`.

**`Bash {command, timeout?, description?, run_in_background?}`**
- **Execution:**
  - Runs `bash -c` in a **new process per call**, in the agent's persisted cwd.
  - A trailing `cd` **persists**: the guest captures `$PWD` at exit through an extra fd and stores it in `/run/nest/agents/<id>/cwd`. Exported variables don't persist.
  - stdin is `/dev/null`. stdout and stderr are combined, in order, into `calls/<call_id>.out`.
  - v2: the call ends when the main process exits, seen through a pidfd. Output drains for up to 1 s (`POLLHUP` on a duplicate of the pipe's read end tells a descendant holding it from a reader that's behind), then the call's cgroup is killed, so `cmd &` can't hang the call.
  - If the persisted cwd no longer exists, the command runs in the slot's `cwd` (or `/` if that's gone too) and the output starts with a `nest: working directory … does not exist; running in …` line.
- **Timeout** in ms: default 120 000, max 600 000 (larger values are clamped).
  - On timeout the command is **moved to the background**, not killed (unless it starts with `sleep`, in which case it's killed). From then on it runs under the background default time limit (1 800 000 ms), like a `run_in_background` task without a `timeout`, and its output moves to `tasks/<task_id>.out`, under task retention (its cgroup leaf stays `calls/<call_id>`). The result text is `Command did not complete within its <N>s timeout and was moved to the background` plus the task ID and output path. Any cwd change made by a moved command doesn't persist, and the result says `Session cwd remains <dir>…`.
- **`run_in_background`:**
  - Starts a task in `tasks/<task_id>/` and returns at once with the task ID and output path.
  - Time limit: `timeout`, default 1 800 000, max 7 200 000. When it's reached, the task is killed and `task_exited{status: timed_out}` is sent.
- **Inline output:**
  - **Success:** up to 30 000 characters. Beyond that, the output file path plus a preview of the first 2 000 characters.
  - **Empty successful output** is returned as the text `(no output)`, so MCP never gets an empty text block.
  - **Failure:** a head-and-tail excerpt of up to 10 000 characters, with no path.
  - **What counts as success:** exit code 0, or exit code 1 from `grep`, `rg`, `egrep`, `fgrep`, `find`, `diff`, `test`, `[`, `git diff` and `git grep`. Anything else is `is_error: true`, and the text ends with `Exit code <n>`.
  - v2: `detail.exit` is `exited{code}`, `signaled{signal}`, `timed_out` or `unknown`, and `<n>` is the code, 128+signal, or 124 for a timeout.
  - Output files are capped at 64 MiB (truncated beyond that). A command whose output passes 5 GB is killed. For the inline text the guest reads at most the first and last 512 KiB of the file; a larger output is reported by its byte size.

**`TaskOutput {task_id, block?, timeout?}`**
- Returns the status line plus the last 30 000 characters of output.
- `block` waits for the task to exit, up to `timeout` (default 30 000, max 600 000).
- An unknown ID gets an **`error` frame** `unknown_task` (listing the agent's running tasks), not an `is_error` result: `HandsDetail::TaskOutput` requires a `TaskInfo`. The same applies to `TaskStop`.

**`TaskStop {task_id}`**
- `cgroup.kill` on `tasks/<task_id>`. Returns the final `TaskInfo`; the output file is kept.

**`Read {file_path, offset?, limit?, pages?}`**
- **Regular files only:** FIFOs, sockets and devices → `is_error` (`not a regular file … use Bash`), since reading them could block forever.
- **Text:**
  - `cat -n` format: the line number right-aligned to width 6, a tab, then the line.
  - Default: 2 000 lines from `offset` (1-based, default 1). Lines over 2 000 characters are cut, with `... [truncated]`.
  - A **whole-file read of a file over 256 KiB** → `is_error`, asking for `offset`/`limit` or a Grep.
  - A range whose output exceeds ~100 000 characters (roughly the 25 000-token limit) → `is_error`.
  - When the 2 000-line default doesn't cover the file, a `PARTIAL view` notice says how to page.
  - `offset`/`limit` reads stream the file (one line keeps at most 64 KiB in memory) and stop counting after scanning 1 GiB; the notice then says `at least N` lines. Cancellation is checked while scanning.
- **Notices:**
  - **Empty file:** a notice that the file exists but is empty.
  - **`offset` past the end:** a notice giving the line count.
- **Images** (png, jpeg, gif, webp, by magic bytes): an `image` content block. Files over 3.75 MiB are re-encoded as JPEG with `vips`/`convert` if available, otherwise `is_error` asking to crop or resize with Bash.
- **PDFs:** `pages` (max 20) are rendered with `pdftotext -layout` (capability `pdf`). Without `pages`, PDFs of 10 pages or fewer are read whole. Otherwise `is_error` asking for `pages`.
- **Helpers** (`pdftotext`, `pdfinfo`, `vips`, `convert`) run as the sandbox user in the agent's environment and a `calls/` cgroup, with a 30 s deadline and an output cap (8 MiB for text).
- **Notebooks** (`.ipynb`): cells and outputs rendered as text. Over 256 KiB → `is_error`.
- **Errors:** directories → `is_directory`; missing files → `is_error` text `File does not exist.`
- **Read tracking:** a read that **wasn't partial** records `{mtime_ns, size, sha256}` per (agent, path).

**`Write {file_path, content}`**
- Creates parent directories and writes the file **in place** (truncate + write, following symlinks and keeping hard links, owner, mode, ACLs and xattrs), like Claude Code's own Write. Not atomic.
- v2: **atomic when safe.** If the target (after following symlinks) is new, or a regular file the writing user owns with one link and no ACL, the content goes to a temporary file in the same directory, which gets the target's mode, group and xattrs and is renamed over it: readers see the old or the new content, never a partial file. A directory that refuses the temporary file, or a failed rename (e.g. a bind mount), falls back to in place.
- Neither path fsyncs. Durability comes from the commit's `flush` ([flush before commit](../../sandbox/state/disk/#flush-before-commit)).
- If the file **exists and this agent hasn't fully read it** → `is_error`: `File has not been read yet. Read it first before writing to it.`
- If it **changed since that read** (size differs, or same size with a different mtime and different content; an mtime-only change such as `touch` doesn't count) → `is_error`: `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.`
- Non-regular files → `is_error`.
- Content containing U+FFFD over a non-UTF-8 original → `is_error` (matches Claude Code).
- On success, the file counts as read again.

**`Edit {file_path, old_string, new_string, replace_all?}`**
- **Requires a prior full Read** by this agent (`not_read` text, as for Write).
- **Matching:**
  - `old_string` must match exactly. **0** matches → `is_error` (`String to replace not found in file.`).
  - **More than 1** match without `replace_all` → `is_error` (the message in the fixture).
  - `old_string == new_string` → `is_error`.
- **Staleness:** if the file changed since the agent read it (mtime, size or hash differ), the edit **still applies** when `old_string` matches the *current* content exactly once (or `replace_all`). The text then adds `Note: the file had changed since you last read it; re-read before edits that depend on surrounding content.` and `detail.changed_since_read = true`.
- **Encoding:** non-UTF-8 files (except UTF-16LE with a BOM) → `is_error` suggesting a shell edit.
- **Size:** files over 16 MiB → `is_error` suggesting a shell edit.
- **Write and result:** written as for Write. The record is updated, and the result text is a short confirmation plus a ±4-line snippet with line numbers.

**`Glob {pattern, path?}`**
- `path` defaults to the agent's cwd. Doesn't respect `.gitignore`.
- Returns absolute paths, newest-modified first, **capped at 100**, with a truncation note if the cap is hit. `No files found` if none.
- Walks at most 500 000 entries (the note then says the search stopped early) and keeps only the newest 100 matches in memory; cancellation is checked while walking.

**`Grep {pattern, path?, glob?, type?, output_mode?, -i, -n, -A, -B, -C, multiline?, head_limit?, offset?}`**
- Searches **hidden files** (`rg --hidden`, excluding `.git/`) while still respecting `.gitignore`, matching Claude Code's built-in Grep.
- Runs `rg` (the image ships ripgrep). It respects `.gitignore`.
- **Output modes** (default `files_with_matches`):
  - `files_with_matches`: paths only.
  - `content`: `path:line:text` (line numbers when `-n`), plus context lines when `-A`/`-B`/`-C` are set.
  - `count`: per-file counts plus a `Total: N` line covering **all** matches.
- **Paging:** `head_limit` (default **250**) and `offset` apply to entries. An `offset` past the end → `No entries at this offset`.
- **Errors:** an rg error → `is_error` with rg's diagnostic. Exit code 1 (no matches) → `No matches found` (`No files found` in `files_with_matches` mode).
- **Bounds:** runs as the sandbox user in the agent's environment and a `calls/` cgroup; lines are cut at 2 000 columns (`--max-columns-preview`); output over 16 MiB stops the search (results marked incomplete); 120 s timeout.

### Path rules

- **Absolute paths are required** for Read, Write and Edit (relative → `bad_request`). Glob and Grep resolve a relative `path` against the cwd.
- **No path restrictions inside the sandbox.** The sandbox is the trust boundary, and file permissions apply as the sandbox user (the file tools carry its filesystem identity, not root's).
- **In-process file tools** (Read, Write, Edit, Glob) return `[Interrupted]` on cancel and are abandoned after 120 s.

## Ingress (port 10000)

**`{"mode":"tcp","port":P}`**
- The guest connects to `127.0.0.1:P`, then `172.16.0.2:P`, then `[::1]:P` (2 s timeout each).
- **Success:** replies `accepted{connected}`, then splices bytes until both sides close.
- **Failure:** `rejected{connect_refused, retryable: true}`.
- **No HTTP awareness.** The gateway does the `Host` rewrite before bytes enter the stream.

**`{"mode":"pty", agent_id?, cols, rows, command?, cwd?, env?}`**
- Spawns a PTY, in `pty/<n>` under the agent's cgroup if `agent_id` is set, with the agent's env.
- Replies `accepted{pid}` (v2 with `pty_reattach`: `accepted{pid, terminal_id, attach_token}`). Then `DATA` frames carry terminal bytes both ways.
- Host → guest JSON: `resize{cols, rows}`, `signal{signal}` (names such as `INT`, `TERM`, `HUP`).
- Guest → host: `exit{code|signal}`, then the guest closes.
- **A dropped connection SIGHUPs the PTY session.** v2: it detaches instead. The terminal runs on for 60 s with its output in scrollback (at most 4 MiB per terminal; 1/32 of guest memory, clamped to 16–64 MiB, for all), then gets SIGHUP. An exited terminal's scrollback and exit status are kept 60 s.

**`{"mode":"pty_attach", terminal_id, attach_token, offset, observe?}`** (v2, `pty_reattach`)
- Replies `accepted{pid, terminal_id, attach_token, offset}` with a new token and the offset of the first byte replayed, which is later than requested if those bytes were dropped. Then scrollback from there, then live output, as above.
- `offset` counts terminal output bytes since the terminal started.
- **One attached reader:** a new attach replaces the previous connection, and only it applies backpressure. `observe: true` attaches read-only: an observer that falls behind skips ahead instead of stalling the process.
- An unknown or expired terminal, or a wrong token → `rejected{unknown_terminal}`.
- `attach_token` is 128 random bits, rotated on every attach. It travels only in frames and message bodies, never in a URL ([ingress](../../sandbox/networking/ingress/)).

### Ports and exposure

- **Port watcher:** the guest parses `/proc/net/tcp{,6}` for `LISTEN` sockets, mapping inodes to pid and comm when visible, and sends the **full** `ports` set on change.
- **Exposure is not a guest concern.** `nest expose <port>` is relayed as a CLI command; the control plane records exposure, and the Worker enforces it.

## CLI relay

> **Implemented contract.** The design replaces `notify`/`emit`/`ask` with `nest post`/`nest read`; see [pending contract changes](../README.md#pending-contract-changes).

Programs in the sandbox run the `nest` binary, which connects to `/run/nest/guest.sock` (same framing) and sends one `CliRequest{agent_id?, command}`.
- `agent_id` comes from `NEST_AGENT_ID` when set (**attribution only**).
- The guest answers `whoami` locally. Everything else is relayed as a control `cli` request.
- The host's `cli_result` is returned as `CliResponse`.

| Command | Fields | Result |
|---|---|---|
| `notify` | `to` (`captain`, `user`, `agt_…`), `message`, `urgency` (`low`, `normal`, `high`) | `ok` |
| `emit` | `event`, `payload` (JSON) | `ok` |
| `ask` | `question`, `options[]`, `wait_s` (≤ 120, default 120) | `answered{answer}` within the wait, else `pending{question_id}` (the answer arrives as the agent's next turn input) |
| `expose` | `port`, `exposed` | `ok`, or `error` (policy refusal) |
| `whoami` | — | `ok{data: {sandbox_id, agent_id?, epoch}}`. After a fork `resume` it reports `new_sandbox_id` until the next `configure` |

nestd relays `notify`, `emit`, `ask` and `expose` to the control plane as a fleet `guest_cli` event, and the control plane runs them as the platform tools of the same name (`expose` → `expose_port`; `emit` takes `payload.summary`, `payload.url`, `payload.title`). See [fleet](../control-host/fleet/).

## Error codes

| Code | Where |
|---|---|
| `bad_request` | Malformed frame or message, relative path, invalid parameter |
| `unsupported_version` | Hello outside the host's range (v1: not equal); a hands `protocol_version` other than the guest's |
| `unsupported` (v2) | A request type, tool, ingress mode or rejected input field the receiver doesn't support; the host gives it for a capability the guest didn't advertise |
| `duplicate_call` (v2) | A `call_id` with a record or a live reservation for this agent; checked first |
| `stale_epoch` | Hands epoch ≠ configured epoch |
| `unknown_agent` | Agent not in the slot set |
| `unknown_task` | TaskOutput / TaskStop |
| `busy` (retryable) | Before `configure`, during `prepare_snapshot` freeze, or (v2) over an admission cap or the frame-memory budget |
| `sync_failed` (v2) | `flush` or `prepare_snapshot` hit a writeback error |
| `not_found`, `is_directory`, `not_read`, `not_utf8`, `old_string_not_found`, `old_string_ambiguous`, `too_large` | Code names for tool-level failures. The model sees them as `is_error` text, and `error` frames use them only when the call couldn't run at all. |
| `connect_refused` (retryable) | Ingress TCP |
| `unknown_terminal` (v2) | Ingress `pty_attach` |
| `internal` | Anything else |

## Sequences

**Hands call with cancel** (the client's frames, piped by the gateway)
```
runner                              guest
  │ CONNECT 1025 / OK                 │
  │ HandsRequest{Bash "npm test"} ──► │ check epoch+agent; mkdir cgroup calls/toolu_01A; spawn
  │ ◄── started                       │
  │ (user interrupts the turn)        │
  │ {"type":"cancel"} ─────────────►  │ cgroup.kill calls/toolu_01A
  │ ◄── result{is_error, interrupted} │ close
```

**Brain restart with a call in flight (v2)**
```
runner (new brain for agt_a, through the gateway)   guest
  │ CONNECT 1025 / OK                 │
  │ call_status{epoch: 8, calls: [{epoch: 7, call_id: toolu_01A}]} ──► │ read calls/toolu_01A.json
  │ ◄── call_status{state: finished, record{exit: exited{0}, output_path}, modified{paths, overflowed: false}}
  runner ─► AgentDO: the outcome, as a canonical event; the recovery context says "exited 0, output at …"
```

**Background task**
```
runner: Bash{run_in_background}  ──►  guest: spawn in tasks/bg_7f3a; ◄── result{task_id, output_path}
… later, task exits …                 guest ──control──► nestd: task_exited{task}
runner: TaskOutput{block:false} ──►   guest: ◄── result{status line + tail}
```

**Ingress connect (preview)**
```
gateway: CONNECT 10000 / OK; {"mode":"tcp","port":5173} ─► guest: dial 127.0.0.1:5173 ✓
gateway ◄─ accepted{connected:"127.0.0.1:5173"}            both switch to raw bytes ⇄
```

**Resume after a memory restore (with fork)**
```
nestd restores VM (vsock reset) → reconnect CONNECT 1024
guest ─► hello{boot_id: same, instance_id: same} ⇒ resumed, not rebooted
nestd ─► configure{sandbox_id: new, epoch: 1, agents}  ◄─ ok
nestd ─► resume{wall_clock_ms, entropy, fork{new_sandbox_id, hostname, machine_id}}
guest: settime, RNDADDENTROPY, write machine-id, sethostname  ─► resume_done{clock_step_ms}
guest ─► ports{…}   (re-announced)
```

## What other boundaries must adopt

- **Runner (hands client, [gateway](../gateway/)):** serve `hands-tools.json` verbatim as the `nest` MCP server's hands tools.
  - `tools/call` → one WebSocket to the sandbox gateway's `/hands` route with the agent's binding, which the gateway turns into a port-1025 connection, then send `HandsRequest{op: input + tool}`.
  - MCP cancellation, or an interrupted turn → `cancel` or close.
  - `call_id` = the MCP request ID or tool-use ID, which must be unique per agent.
  - v2: stamp the guest's version (from `resolve`); retry `executed: false` refusals; fail silent calls; look up in-flight calls with `call_status` at brain start.
- **nestd:** owns the port-1024 connection, `configure`, `resume`, `prepare_snapshot` and `thaw`. It relays `cli` requests and `ports`/`task_exited` events to the control plane. Epoch and slots come from SandboxDO.
  - v2: checks the version range, passes the guest's version and capabilities to the gateway (and, through SandboxDO, to `resolve`), sends `flush` before every commit, and drains log-site counts into its metrics.
- **Gateway:** owns every port-1025 and port-10000 connection, one per client call or stream, and does the `Host` rewrite for previews.
- **Control plane:**
  - `ports` → nestd emits a `port_opened` workstream event for each newly listening port (closed ports aren't reported).
  - CLI `notify`/`emit`/`ask`/`expose` map onto the platform tools of the same names.
  - `ask` follows the 120 s rule.

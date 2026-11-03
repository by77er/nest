# Guest agent

The daemon inside each sandbox VM. It is the **hands server**. It holds no credentials and runs no harness. Wire contract: [../../interfaces/host-guest/](../../interfaces/host-guest/).

- **vsock, host-initiated:** nestd opens the control connection (1024); the [gateway](../gateway/) opens one connection per hands call (1025) and per ingress stream (10000), on behalf of clients anywhere. The guest **accepts only the host (CID 2)**, so a process inside the sandbox can't reach these ports even if the guest kernel has vsock loopback.
- **Post-resume fixes** (nestd's `resume`): resync the clock, mix host entropy into the kernel RNG on every resume, and on a fork set a new machine-id and hostname.
- **Hands RPC:** Bash (per-agent cwd, background tasks, PTY), Read/Write/Edit with per-agent read records and staleness checks, Glob/Grep. Everything runs as the sandbox user: processes via `setuid`, in-process file tools via a per-thread filesystem identity. Inputs that could block forever (FIFOs, devices) are refused, file tools have a deadline, and Grep and helper output is capped. v2: each call leaves a record on tmpfs for the [hands journal](../../agents/hands/#journal). See [../../agents/hands/](../../agents/hands/).
- **Per-agent context:** each process runs in its own leaf of the agent's **cgroup** (accounting, and `cgroup.kill` on interrupt) with the user's `HOME`/`USER`/`LOGNAME`/`SHELL`, `NEST_AGENT_ID` (attribution only) and `HTTP(S)_PROXY` pointing at the agent's explicit proxy port.
- **Output retention:** call outputs live on tmpfs (`/run/nest`, i.e. guest RAM). The newest 64 foreground outputs per agent (at most 256 MB) and the newest 32 finished background tasks are kept; `agent_detach` with `kill_processes` deletes the agent's outputs.
- **`nest` CLI endpoint** for programs inside the sandbox (`nest expose`, `nest unexpose`, `nest whoami`; `nest hold` is designed), relayed to nestd on the control connection. What it sends is always tainted ([tools](../../agents/tools/#the-nest-cli-inside-sandboxes)). For compatibility the wire still parses `notify`, `emit` and `ask`, which the control plane answers `unknown_tool` ([pending contract changes](../../interfaces/README.md#pending-contract-changes)).
- **Before a commit, pause or suspend** (v2; built: `sync` before a snapshot): `syncfs` on every filesystem, which must succeed ([flush before commit](../state/disk/#flush-before-commit)). `syncfs` reports writeback errors (Linux 5.8+, [syncfs(2)](https://man7.org/linux/man-pages/man2/syncfs.2.html)); `sync` doesn't. Before a snapshot, also `drop_caches`. No filesystem freeze.
- **Ingress endpoint** (vsock `:10000`): takes a `{port}` header and connects to `127.0.0.1:<port>`, then `172.16.0.2`, then `::1`. Used by previews, `nest port-forward` and terminal attach (PTY), all arriving through the gateway. See [../networking/ingress/](../networking/ingress/).
- **Ready:** the guest agent is ready once `configure` (and, after a restore, `resume`) is done. v2: it reports that, and nestd passes it to SandboxDO as the evidence a placement needs to complete ([placement](../../control-plane/durable-objects/sandbox/#placement)).
- **Port watcher:** reports listening ports (`/proc/net/tcp{,6}`) as `ports` events, which nestd turns into `port_opened` sandbox events; whether a port is exposed is the control plane's business (`nest expose` is relayed there).
- **Packages:** with `agent_root: none`, installs go through an allowlisted helper (**not built yet**).

## Versions

**v2, designed.** Built: the host requires the guest's exact `protocol_version`.

A memory snapshot keeps the guest agent it was taken with. Requiring the host's exact protocol version would strand every suspended sandbox at each protocol bump.

- **A range:** the host accepts a guest whose `protocol_version` is in `[min_supported, current]`, and speaks that guest's version to it.
- **Features follow `capabilities`** in `hello`, not version numbers. The host uses only what the guest advertised, and a guest answers a request it doesn't know with an explicit `unsupported` error, never silence.
- **Old messages and fields stay** until `min_supported` passes every version that needs them. The [host-guest spec](../../interfaces/host-guest/#versions-v2) lists each with the version that retires it.
- **An unsupported guest fails admission explicitly:** nestd fails the start or resume with `unsupported_version` instead of letting readiness time out.
- **Raising `min_supported` is deliberate:** a suspended sandbox with an older guest loses its memory snapshot and boots from the same generation's disk, like a checkpoint no host can load ([restore rule](../state/#restore-rule)).
- **Paused restores aren't thawed to check:** the version arrives in the guest's `hello`, at resume.
- **Release gate:** a memory snapshot taken with the previous release's guest is kept as a fixture. Each release resumes it on the new host and runs every hands tool once (needs KVM).
- **Open: upgrading in place by re-exec.** The host already treats the same `boot_id` with a new `instance_id` as a restart. It needs the task registry (pids, output capture, PTYs) rebuildable from tmpfs; a restart today loses running background tasks' output capture.

## Processes

**v2, designed.** Built: a child joins its cgroup leaf between fork and exec, but a failed placement still runs the call; the call ends when its main process exits, after up to 200 ms of output drain; `detail` carries `exit_code` and `signal`.

- **Placed before exec:** a child joins its cgroup leaf (`calls/<call_id>`, `tasks/<task_id>`, `pty/<n>`) between fork and exec. If that fails, the call is refused rather than run where `cgroup.kill` can't reach it.
- **OOM:** the guest agent runs at `oom_score_adj` −1000 and resets each child to 0 before exec (a failure refuses the call), so the kernel kills a workload, never the hands server.
- **Exit from a pidfd:** a call's main process has exited when its pidfd says so, not when its pipes reach EOF, which a descendant can hold open forever.
- **Bounded drain:** output then drains for up to 1 s. `POLLHUP` on a duplicate of each pipe's read end tells "every writer closed, the reader is behind" (keep reading) from "a descendant still holds the pipe" (stop waiting). Then the call's cgroup is killed, so `cmd &` can't hang a call.
- **Typed outcome** in the result's `detail`: `exited{code}`, `signaled{signal}`, `timed_out` or `unknown`.

## Admission

**v2, designed.** Built: hands calls and ingress PTYs are `busy` before `configure` and while frozen; nothing else below.

The 64 and 256 caps, the queue and the 5 s first-frame limit are SPACE's guest numbers ([lib.rs](https://github.com/perplexityai/space/blob/main/crates/libs/spaced/guest/server/src/lib.rs), [admission_queue.rs](https://github.com/perplexityai/space/blob/main/crates/libs/spaced/common/src/admission_queue.rs)).

- **Memory before bytes:** a frame (up to 16 MiB) is charged against a budget of 1/16 of guest memory, clamped to 16–64 MiB, before its payload is read.
- **Caps:** 16 hands calls per agent and 64 in total, and 256 connections on the in-sandbox CLI socket. A call is admitted once its request is read, so a refusal names it. Over a cap, it waits up to 2 s (64 waiters at most), then is refused as `busy` with a retry hint.
- **A control lane:** the control connection is separate, `TaskStop` and `call_status` skip the caps, and `cancel` arrives on its call's own connection, so stopping work never queues behind running work.
- **Liveness:** a connection whose request doesn't arrive within 5 s is closed. A hands call silent for 10 s sends a heartbeat, so the runner can tell a long call from a wedged guest.

## Terminals

**v2, designed.** Built: a dropped connection SIGHUPs the terminal's session.

- **A dropped connection detaches.** The terminal keeps running for 60 s with its output in scrollback, and is reattached by terminal id, a reattach token and a byte offset. After 60 s it gets SIGHUP. An exited terminal's scrollback and exit status are kept 60 s. The token never goes in a URL ([ingress](../networking/ingress/)).
- **Bounded scrollback:** all terminals share 1/32 of guest memory, clamped to 16–64 MiB, with at most 4 MiB each, oldest bytes dropped first. These are SPACE's process-output bounds ([process.rs](https://github.com/perplexityai/space/blob/main/crates/libs/spaced/guest/server/src/process.rs)).
- **Backpressure comes only from the attached reader.** An observer that falls behind skips ahead, and a detached terminal overwrites its oldest bytes, so neither stalls the process.
- **Hands calls don't detach:** a hangup cancels them, whatever caused it (see [hands](../../agents/hands/)).

## Change ledger

**Designed, not built.** A fanotify watch on the guest's filesystems (file names need Linux 5.9+, [fanotify_init(2)](https://man7.org/linux/man-pages/man2/fanotify_init.2.html)) records modified paths against a position counter, not a clock, since resume steps the clock. Each call record holds the position at its intent, so [recovery](../../agents/sessions/#after-a-crash) can list what changed since.
- **Bounded:** the newest 10,000 paths.
- **Honest coverage:** a query that reaches past an evicted path or a kernel queue overflow says `overflowed`. A guest-agent restart starts a new ledger, so older positions report incomplete coverage.

## Diagnostics

**v2, designed.** The `health` reply carries counts of the guest agent's own WARN and ERROR log sites since the last drain, by site (module and line) only. Message text and fields never leave the guest, since they can hold commands, paths and output. nestd folds the counts into its [metrics](../../control-plane/metrics/).

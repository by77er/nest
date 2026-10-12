# nest-guest

The hands server that runs inside every sandbox VM. Spec: [`docs/interfaces/host-guest/`](../../docs/interfaces/host-guest/). Design: [`docs/sandbox/guest-agent/`](../../docs/sandbox/guest-agent/).

```
nest-guest [--listen vsock|unix:<dir>] [--state-dir /run/nest] [--cgroup-root /sys/fs/cgroup/nest|none]
           [--cli-socket /run/nest/guest.sock|none] [--port-poll-ms 1000] [--run-as UID:GID|none]
```

| Module | Role |
|---|---|
| `transport` | AF_VSOCK listeners, or `unix:<dir>` (`<dir>/<port>.sock`). `transport::emulator` plays Firecracker's hybrid-vsock socket (`CONNECT <port>` → `OK <n>`) for tests and local runs. |
| `control` | Port 1024: hello, configure, agent attach/detach, resume, prepare_snapshot/thaw, health, buffered events (`ports`, `task_exited`), CLI relay replies |
| `hands` | Port 1025, one connection per call: `Bash` (persistent per-agent cwd via an fd-3 `$PWD` report, timeouts, background tasks, missing-cwd warning), `TaskOutput`, `TaskStop`, `Read` (regular files only, streamed ranges), `Write`/`Edit` (in place through symlinks; Write rejects stale files), `Glob` (bounded walk, top 100), `Grep` (ripgrep, capped and timed). File tools run on a blocking thread with the sandbox user's filesystem identity (`exec::AsUser`), cancellable, 120 s deadline |
| `ingress` | Port 10000: raw TCP splice (127.0.0.1, then 172.16.0.2, then ::1) or a framed PTY |
| `ports` | `/proc/net/tcp{,6}` watcher |
| `cli` | `/run/nest/guest.sock` for the in-sandbox `nest` CLI: `whoami` locally, everything else relayed |
| `exec`, `cgroup`, `output`, `tasks` | Agent exec context (user env, process group, cgroup v2 leaf, uid drop; `run_helper` for bounded helpers; `AsUser` per-thread fs identity), output capture (64 MiB file cap, kill past 5 GB, bounded reads, retention of 64 call outputs / 32 finished tasks per agent), background tasks |

**vsock peers:** only CID 2 (the host) is accepted.

**Without root or cgroupfs** (tests, local runs), cgroups are skipped and kills go to the process group, `--run-as` defaults to none (no identity switch). Clock steps, `RNDADDENTROPY`, hostname/machine-id changes, `drop_caches` and `fsfreeze` are skipped with a warning.

**Not exercised here (needs root / a VM):** the uid drop and the per-thread `setfsuid` identity switch, cgroup v2 kill and `memory.max`, the real vsock path and its CID check, `fsfreeze`, PDF and image helpers (poppler/vips not installed).

**Known gaps:** the `agent_root: none` package-install helper; image downscaling only via external `vips`/`convert`.

**Tests:** `cargo test -p nest-guest`. The integration tests run the guest over the unix emulation and drive every channel with real frames.

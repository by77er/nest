# Guest agent

The daemon inside each sandbox VM. It is the **hands server**. It holds no credentials and runs no harness. Wire contract: [../../interfaces/host-guest/](../../interfaces/host-guest/).

- **vsock, host-initiated:** nestd opens every connection (control on 1024, one connection per hands call on 1025, ingress on 10000). The guest **accepts only the host (CID 2)**, so a process inside the sandbox can't reach these ports even if the guest kernel has vsock loopback.
- **Post-resume fixes** (nestd's `resume`): resync the clock, mix host entropy into the kernel RNG on every resume, and on a fork set a new machine-id and hostname.
- **Hands RPC:** Bash (per-agent cwd, background tasks, PTY), Read/Write/Edit with per-agent read records and staleness checks, Glob/Grep. Everything runs as the sandbox user: processes via `setuid`, in-process file tools via a per-thread filesystem identity. Inputs that could block forever (FIFOs, devices) are refused, file tools have a deadline, and Grep and helper output is capped. See [../../agents/hands/](../../agents/hands/).
- **Per-agent context:** each process runs in the agent's **cgroup** (accounting, and `cgroup.kill` on interrupt) with the user's `HOME`/`USER`/`LOGNAME`/`SHELL`, `NEST_AGENT_ID` (attribution only) and `HTTP(S)_PROXY` pointing at the agent's explicit proxy port.
- **Output retention:** call outputs live on tmpfs (`/run/nest`, i.e. guest RAM). The newest 64 foreground outputs per agent (at most 256 MB) and the newest 32 finished background tasks are kept; `agent_detach` with `kill_processes` deletes the agent's outputs.
- **`nest` CLI endpoint** for programs inside the sandbox (`nest post`, `nest read`, `nest expose`), relayed to nestd on the control connection. Its posts are always tainted ([tools](../../agents/tools/#the-nest-cli-inside-sandboxes)). The built guest still speaks `notify`/`emit`/`ask` ([pending contract changes](../../interfaces/README.md#pending-contract-changes)).
- **Before a snapshot:** `drop_caches`, and optionally `fsfreeze`.
- **Ingress endpoint** (vsock `:10000`): takes a `{port}` header and connects to `127.0.0.1:<port>`, then `172.16.0.2`, then `::1`. Used by previews, `nest port-forward` and terminal attach (PTY). See [../networking/ingress/](../networking/ingress/).
- **Port watcher:** reports listening ports (`/proc/net/tcp{,6}`) as `ports` events; whether a port is exposed is the control plane's business (`nest expose` is relayed there).
- **Packages:** with `agent_root: none`, installs go through an allowlisted helper (**not built yet**).

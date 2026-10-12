# Host-internal interfaces

Boundaries between the processes on one host. Rust types: `nest_protocol::host`. Fixtures: `protocol/fixtures/host/<message>/<variant>[.<case>].json`; tests round-trip every fixture and fail if an enum variant has none. Claude Code reference artifacts: `protocol/claude-code/`.

| Boundary | Transport | Spec |
|---|---|---|
| nestd ↔ nest-proxy | unix `SOCK_SEQPACKET`, one JSON object per packet, listener fds via `SCM_RIGHTS` | [nestd-proxy/](nestd-proxy/) |
| nestd ↔ agent runner | unix `SOCK_STREAM`, length-prefixed JSON (u32 BE) | [nestd-runner/](nestd-runner/) |
| `nest hook` → runner | unix `SOCK_DGRAM` (async) / `SOCK_STREAM` frame (sync) | [runner-hooks/](runner-hooks/) |
| `nest mcp` ↔ runner | unix `SOCK_STREAM`, length-prefixed JSON | [runner-mcp/](runner-mcp/) |
| runner ↔ Claude Code | argv, env, managed settings, stream-json on stdio | [runner-claude/](runner-claude/) |

## Who talks to the control plane

| Process | Control-plane connections | Holds |
|---|---|---|
| **nestd** (privileged) | enrollment, **fleet channel** (FleetDO) | host token, proxy CA key, leases, fencing authority |
| **agent runner** (unprivileged) | one **session channel** per active agent (AgentDO), per `docs/interfaces/control-host/session/` | host token (memory, pushed by nestd), OAuth tokens (memory) |
| **nest-proxy** (unprivileged) | none | injection secrets, CA key (memory, pushed by nestd) |

**Decision: the runner owns its session channels; nestd does not relay them.** Session bytes are the largest traffic on a host, and turns, inbox, caches and platform tool calls are per-agent AgentDO concerns. Relaying them through nestd would add a hop and per-agent logic to the privileged daemon for no security gain. Fencing stays with nestd: it mirrors the lease to the runner (`lease_update`), kills brains on `fence`, and the runner kills everything if the nestd socket closes. AgentDO independently rejects stale epochs. The runner authenticates with the host token nestd hands it (memory only, rotated). Claude Code processes never see it.

## Sockets

| Path | Type | Listener | Mode |
|---|---|---|---|
| `/run/nest/proxy.sock` | `SOCK_SEQPACKET` | nestd | `0660 root:nest-proxy` |
| `/run/nest/runner.sock` | `SOCK_STREAM` | nestd | `0660 root:nest-runner` |
| `/run/nest/runner/hook.dgram` | `SOCK_DGRAM` | runner | `0660 nest-runner:nest-agents` |
| `/run/nest/runner/hook.sock` | `SOCK_STREAM` | runner | `0660 nest-runner:nest-agents` |
| `/run/nest/runner/mcp.sock` | `SOCK_STREAM` | runner | `0660 nest-runner:nest-agents` |

**Planned:** Claude Code processes run as per-agent `DynamicUser`s in the `nest-agents` group (supplementary), so `nest hook` and `nest mcp` can reach the runner's sockets and nothing else. **Today** brains run as the runner's user in their own process group; the sync-hook and MCP sockets are bound to the brain's process tree with `SO_PEERCRED` (see [runner-hooks/](runner-hooks/)).

## Framing

- **Stream sockets:** `u32` big-endian length, then that many bytes of UTF-8 JSON (one object). Max 16 MiB. Compatible with `tokio_util::codec::LengthDelimitedCodec` defaults. Helpers: `host::frame`.
- **Seqpacket:** one packet = one JSON object, plus 0..32 fds in a single `SCM_RIGHTS` cmsg. Receivers use `MSG_CMSG_CLOEXEC`; `MSG_TRUNC`/`MSG_CTRUNC` is a fatal protocol error. Max 1 MiB nestd → proxy (nestd sets `SO_SNDBUFFORCE` ≥ 2 MiB), 64 KiB proxy → nestd. Helpers: `host::fdpass`.
- Conventions from [../README.md](../README.md) apply, except the two external formats: Claude Code hook output and MCP objects keep their own camelCase names.

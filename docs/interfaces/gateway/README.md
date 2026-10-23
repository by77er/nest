# Brain ↔ gateway (WebSocket)

> **Designed, not built.** Rust types planned as `nest_protocol::gateway`; fixtures planned under `protocol/fixtures/gateway/`. Design: [sandbox gateway](../../sandbox/gateway/), [hands](../../agents/hands/).

How any client of a sandbox (the agent runner's hands client, AgentDO's `api-loop`, the `nest` CLI on a laptop) talks to the [gateway](../../sandbox/gateway/) on the sandbox's host. The frames inside are the [host-guest](../host-guest/) ones, verbatim; this boundary adds only the transport, the binding and `resolve`.

## Transport

`wss://<hostname>/<route>`, one connection per call or stream, through the host's Cloudflare Tunnel behind Cloudflare Access (the service token goes on the upgrade request).

| Route | Guest port | Carries |
|---|---|---|
| `/hands` | 1025 | `HandsRequest` → `started`, `heartbeat`, `result` \| `error`; or a read-only `call_status` |
| `/pty` | 10000 | `{"mode":"pty"}` or `pty_attach`, then framed PTY bytes |
| `/ingress/<port>` | 10000 | `{"mode":"tcp","port"}`, then raw bytes |

- **First message:** `bind{binding, protocol_version, gateway_version}`, where `protocol_version` is the guest version `resolve` reported. The gateway answers `bound{guest{protocol_version, capabilities}}`, or closes with an `error`.
- **Then the host-guest frames,** one WebSocket binary message per frame (`len:u32be kind:u8 payload`, at most 16 MiB, under the 32 MiB a Worker or Durable Object accepts per message ([Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/))). On `bind` the gateway opens the guest's vsock port and pipes frames both ways. It stamps nothing: a `HandsRequest` already carries `agent_id` and `epoch`, and the gateway refuses a frame whose `epoch` or `agent_id` differs from the binding's.
- **Cancel is a close.** Closing the WebSocket closes the vsock connection; the guest kills the call's cgroup. A `cancel` frame works too.
- **One connection per call,** for the reasons [host-guest](../host-guest/#why-one-connection-per-call-not-multiplexing) gives, and because a WebSocket is the outbound stream a Durable Object can open (an upgrade `fetch`, then `accept()`) and a Cloudflare Tunnel carries.

## Binding

`{v: 1, sandbox, epoch, client, scope: hands | pty | ingress, exp_ms, sig}`, signed with the cell's binding key, which FleetDO holds and pushes to sandbox hosts. Issued by SandboxDO at `attach`, renewed by `resolve`, valid about an hour.

- **The slot is not in it.** The cwd, env and cgroup a client acts under are configured in the guest at `attach` (`configure` / `agent_attach`); the binding names only the client (`agent_id` for an agent, a person's id for a terminal).
- **Revoked** by `detach` (SandboxDO → FleetDO → nestd → gateway) and by any epoch bump: the token names the epoch, and the gateway accepts only the VM's current one.
- A call admitted on a valid binding runs to completion; the next connection needs a renewed one.
- Never in a URL. It travels in the `bind` message.

## Resolve

`resolve(sandbox, client)` on SandboxDO returns the sandbox's current placement. An agent runner reaches it through AgentDO (`hands_resolve` on the [session channel](../control-host/session/)); a person's `nest` CLI through the Worker API.

```json
{"hostname": "<host>.<zone>", "epoch": 7, "binding": {"…": "…"},
 "guest": {"protocol_version": 2, "capabilities": ["pty", "cgroup_v2", "flush", "call_status", "heartbeat"]}}
```

A client calls it at start, before a binding expires, and after a refused connection, `moved` or `stale_epoch`. It caches nothing past the binding's lifetime. A sandbox that moved answers with its new hostname and epoch.

## Versions and capabilities

The gateway serves guests in `[min_supported, current]`, and the client speaks the version `resolve` reported. Features follow `capabilities`, as [host-guest](../host-guest/#versions-v2) says: a client answers its own caller `unsupported` for a feature the guest didn't advertise. `gateway_version` in `bind` lets a brain host and a sandbox host be one release apart in either direction; the release gate runs the previous release's client against the new gateway and the previous gateway against the new client.

## Error codes

Before `bound`, the gateway closes with `error{code, message, retryable, executed: false}`:

| Code | Meaning |
|---|---|
| `unauthorized` | Bad signature, expired binding, wrong scope or client |
| `stale_epoch` | The binding's epoch isn't the VM's current epoch; re-resolve |
| `moved` | The sandbox isn't on this host; re-resolve |
| `unsupported_version` | The client's guest or gateway version is outside the range |
| `busy` (retryable) | The guest isn't ready (before `configure`, during a freeze); `retry_after_ms` |

After `bound`, every error is the guest's own frame.

## Sequence

```
runner (brain host)                   gateway (sandbox host)               guest
  │ hands_resolve via AgentDO → {hostname, epoch 7, binding, guest v2}
  │ WSS /hands ────────────────────────►│ Access ok; verify binding; epoch 7 == VM's
  │ bind{binding, v2} ─────────────────►│ CONNECT 1025 / OK ──────────────────►│
  │◄── bound{guest}                     │                                      │
  │ HandsRequest{Bash, epoch 7} ───────►│ ────────────────────────────────────►│ check epoch+agent; run
  │◄── started / heartbeat / result     │◄─────────────────────────────────────│
  │ close ─────────────────────────────►│ close the vsock side ───────────────►│ cgroup.kill if still running
```

## What other boundaries adopt

- **Runner:** the hands client speaks this; nestd carries nothing about hands to the runner ([nestd-runner](../host-internal/nestd-runner/)).
- **AgentDO:** `agent_start` carries `{hostname, binding, guest}`; the session channel carries `hands_resolve` ([session](../control-host/session/)).
- **FleetDO and nestd:** the binding key and revocations travel on the fleet channel and over `/run/nest/gateway.sock` ([host-internal](../host-internal/)); a sandbox host's enrollment response carries its tunnel token ([enrollment](../control-host/enrollment/)).

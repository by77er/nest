# Brain ↔ gateway (WebSocket)

How any client of a sandbox (the agent runner's hands client today; AgentDO's `api-loop` and the `nest` CLI later) talks to the [gateway](../../sandbox/gateway/) on the sandbox's host. The frames inside are the [host-guest](../host-guest/) ones, verbatim; this boundary adds only the transport, the binding and `resolve`. Rust types: `nest_protocol::gateway`; TypeScript mirrors: `control-plane/src/protocol/gateway.ts`, with the signer in `control-plane/src/lib/binding.ts`. Fixtures: `protocol/fixtures/gateway/`, round-tripped by both languages. Design: [sandbox gateway](../../sandbox/gateway/), [hands](../../agents/hands/).

**Built:** the `/hands` route, in `crates/nest-gateway` (the server), `crates/nest-hands-client` (the client the runner uses) and the control plane (bindings, `resolve`). Also built, verified on AWS on 2026-10-23 and, with Access in front, on 2026-10-24 (spike item 13): the tunnel in front (the control plane creates it at enrollment and tells clients `wss://<host>-gw-nest.<zone>`; nestd runs cloudflared) and the Access credential in every target that points at a host's tunnel; the Access applications are created by hand ([gateway](../../sandbox/gateway/)). **Not built:** the `/pty` and `/ingress/<port>` routes (the gateway answers HTTP 501) and key rotation beyond accepting a list. The e2e harness speaks plain `ws://` on loopback with no tunnel.

## Transport

`ws://<address>/<route>` on the harness, `wss://<host>-gw-nest.<zone>/<route>` through the host's Cloudflare Tunnel behind Cloudflare Access on a real host (the service token goes on the upgrade request as `CF-Access-Client-Id` / `CF-Access-Client-Secret`; the client refuses to send it over cleartext to anything but loopback). One connection per call or stream. Before `bound`, up to 256 connections may be in the handshake at once, and a connection that has not finished the upgrade and `bind` within 5 s is dropped.

| Route | Guest port | Carries | Status |
|---|---|---|---|
| `/hands` | 1025 | `HandsRequest` → `started`, `heartbeat`, `result` \| `error`; or a read-only `call_status` | Built |
| `/pty` | 10000 | `{"mode":"pty"}` or `pty_attach`, then framed PTY bytes | 501 |
| `/ingress/<port>` | 10000 | `{"mode":"tcp","port"}`, then raw bytes | 501 |

- **First message:** a text frame `bind{binding, protocol_version, gateway_version}`, where `protocol_version` is the guest version the client will speak inside the frames and `gateway_version` is this boundary's. The gateway answers a text frame `bound{guest{protocol_version, capabilities}, gateway_version}` (`guest` is authoritative; `gateway_version` is the version the gateway chose, the highest it serves that is not above the client's), or a text frame `error{...}` and a close.
- **Then the host-guest frames,** exactly one per binary message: `len:u32be kind:u8 payload` with `len == message_len − 4` and `kind` 0x00 (JSON) or 0x01 (DATA), at most 16 MiB (under the 32 MiB a Worker or Durable Object accepts per message ([Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/))). A message that is not exactly one well-formed frame closes the connection with code 4400, so no message can smuggle a second frame past the checks on the first. Guest frames come back one per message too.
- **The first client frame is checked, later ones pass.** It must be a JSON frame; where it carries `agent_id`, `epoch` or `protocol_version`, they must equal the binding's client and epoch and the bound guest version, or the gateway closes with 4401 before forwarding anything. Later client frames (`cancel`) pass through untouched; the guest's own epoch and agent checks still apply to every request.
- **No text frames after `bound`,** in either direction: refusals are close codes, every other error is the guest's own frame, and a text frame from the client is a protocol error (4400).
- **Cancel is a close.** Closing the WebSocket closes the vsock connection; the guest kills the call's cgroup. A `cancel` frame works too.
- **One connection per call,** for the reasons [host-guest](../host-guest/#why-one-connection-per-call-not-multiplexing) gives, and because a WebSocket is the outbound stream a Durable Object can open (an upgrade `fetch`, then `accept()`) and a Cloudflare Tunnel carries.

### Close codes

| Code | Meaning |
|---|---|
| 4400 | A client message that is not exactly one frame, a first frame that is not JSON, or a text frame after `bound` |
| 4401 | The first frame's agent, epoch or version differs from the binding's; nothing was forwarded |
| 4409 | The sandbox left this host mid-call (fence, eviction, a lost nestd link, the gateway stopping). The call may have run: the client treats the outcome as unknown |
| 1011 | The guest's stream broke or sent a malformed frame |

## Binding

`nbd_<base64url(claims JSON)>.<base64url(signature)>`. The claims are `{v: 1, kid, sandbox, epoch, client, scope: hands | pty | ingress, exp_ms}`; the signature is ECDSA P-256 with SHA-256, fixed-size `r‖s` (64 bytes), over `nest-binding-v1:` followed by the base64url claims segment exactly as it appears in the token, so the signed bytes are unambiguous without canonical JSON. `kid` is the first 16 hex characters of SHA-256 over the raw public key (the uncompressed SEC1 point). A binding lives one hour.

- **Minted at `resolve`, never at `attach`.** `attach` configures the client's slot in the guest (cwd, env, cgroup, through nestd's `agent_attach`); the binding names only the client (`agent_id` for an agent, a person's id for a terminal) and travels only over the session channel from AgentDO to the runner, never through FleetDO, nestd or a command at rest. In code it is a redacting `Secret`; it is never put in a URL or a log.
- **Keys:** the per-cell private key lives in BrokerDO; hosts hold a list of public keys (`binding_key{keys}` on the fleet channel, `key_update{keys}` to the gateway), so a rotation can keep the previous key listed for a binding lifetime. A `kid` that is not listed is `unknown_key`.
- **Revoked** by `detach` (the gateway refuses a client that is not in the sandbox's attached set, which nestd sends with every `sandbox_upsert`) and by any epoch bump, since the token names the epoch and the gateway accepts only the sandbox's current one.
- A call admitted on a valid binding runs to completion; the next connection needs a renewed one.
- **The cross-language oracle:** `protocol/fixtures/gateway/binding_token/signed.json` holds a reproducible P-256 key, a signed token and its claims. The control plane's tests verify it with WebCrypto, the gateway's tests with `ring`, and both refuse a tampered copy, which pins base64url without padding, the signing domain and the `r‖s` format on both sides.

## Resolve

`resolve(agent)` on SandboxDO returns the sandbox's current placement as a `HandsTarget`: `{url, sandbox, epoch, binding, guest{protocol_version, capabilities}, edge?}`, where `url` is `wss://` plus the tunnel hostname FleetDO recorded for the host at enrollment, or the host's own `gateway_url` from its fleet hello when it has no tunnel; `guest` is what nestd last reported (the gateway's `bound.guest` is authoritative); and `edge` is the Access service token from BrokerDO (`access:gateway`), present only for a `wss://` URL.

- **A runner** asks through AgentDO: `hands_resolve{request}` on its [session channel](../control-host/session/), answered by `hands_resolved{request, hands | error, retry_after_ms?}` with exactly one of `hands` and `error`: `not_bound` (the agent has no hands, or the client is not attached), `sandbox_not_ready` with a retry hint (no host, placing, the slot not confirmed yet, or a host that advertised no gateway), `stale_epoch` (the asking runner process or epoch is not the current one), or another error the runner surfaces. AgentDO answers only the current runner's socket.
- **An operator or a test harness** asks the Worker: `POST /v1/sandboxes/<sbx>/resolve {client}` with the admin token returns the same target for an attached client. Mints are not audited yet.
- The runner prefetches a target at brain start and otherwise resolves before its first call; it caches the target until a refusal (`stale_epoch`, `moved`, `unknown_key`, or `unauthorized`, which is how an expired binding is reported) or an unreachable host, then resolves again once and retries once. A sandbox that moved answers with its new URL and epoch.

```json
{"url": "wss://01jb7k3x9q-gw-nest.example.dev", "sandbox": "sbx_01jb7m2a4c", "epoch": 4,
 "binding": "nbd_…", "guest": {"protocol_version": 1, "capabilities": ["pty", "cgroup_v2", "pdf", "fsfreeze"]}}
```

## Versions and capabilities

The gateway serves gateway protocol versions in `[min_supported, current]` (both 1 today) and refuses a `bind.gateway_version` outside it; `bound` echoes the version it chose, so a newer client can step down. `bind.protocol_version` must equal the guest's version, or the bind is `unsupported_version`. Features follow `bound.guest.capabilities`, as [host-guest](../host-guest/#versions-v2) says: a client answers its own caller `unsupported` for a feature the guest did not advertise. The range lets a brain host and a sandbox host be one release apart in either direction; the release gate runs the previous release's client against the new gateway and the previous gateway against the new client.

## Error codes

Before `bound`, the gateway sends a text frame `error{error{code, message, retryable}, executed: false, retry_after_ms?}` and closes. `executed` is always false here: the gateway never executes anything, and nothing has reached the guest. The checks run in this order, and the first refusal is the answer:

| Order | Code | Meaning | Same binding again? |
|---|---|---|---|
| 1 | `bad_request` | Not a well-formed text `bind` within 5 s, or an unknown route (the upgrade itself answers 404; `/pty` and `/ingress` answer 501) | No |
| 2 | `unsupported_version` | `gateway_version` outside the served range, or a claims format this gateway does not know | No |
| 3 | `unknown_key` | The binding's `kid` is none of the keys this gateway holds: rotated away, or never this cell's | No: resolve again |
| 4 | `unauthorized` | Bad signature, expired, wrong scope, or a client not attached to the sandbox. The message never says which | No |
| 5 | `moved` | The sandbox is not on this host, or the gateway has lost nestd | No: resolve again |
| 5 | `busy` | During a resync after the gateway reconnected to nestd, an unknown sandbox is `busy`, not `moved` | Yes, after `retry_after_ms` |
| 6 | `stale_epoch` | The binding names an epoch older than the sandbox's current one | No: resolve again |
| 6 | `busy` | The binding names an epoch newer than the gateway's table (a placement nestd has not pushed yet) | Yes |
| 7 | `busy` | The guest has not been configured, or its vsock port did not answer the `CONNECT` | Yes |
| 8 | `unsupported_version` | `bind.protocol_version` is not the guest's | No |

The signature is verified before any state-dependent answer, so an unsigned probe learns nothing about which sandboxes a host runs. Only `busy` is retryable with the same binding; `stale_epoch`, `moved` and `unknown_key` mean "resolve again"; the rest are final. A client holding a cached target also resolves again on `unauthorized`, since an expired binding is refused with that code.

## Sequence

```
runner (brain host)                   gateway (sandbox host)               guest
  │ hands_resolve via AgentDO → {url, epoch 4, binding, guest v1}
  │ WS /hands ─────────────────────────►│ verify binding; epoch 4 == the sandbox's; client attached
  │ bind{binding, v1, gw 1} ───────────►│ CONNECT 1025 / OK ──────────────────►│
  │◄── bound{guest, gateway_version 1}  │                                      │
  │ HandsRequest{Bash, epoch 4} ───────►│ first frame matches the binding ────►│ check epoch+agent; run
  │◄── started / result                 │◄─────────────────────────────────────│
  │ close ─────────────────────────────►│ close the vsock side ───────────────►│ cgroup.kill if still running
```

## What other boundaries adopt

- **Runner:** the hands client speaks this; `agent_start` carries the sandbox's id and epoch only, and nestd carries nothing about hands to the runner ([nestd-runner](../host-internal/nestd-runner/)).
- **AgentDO:** the session channel carries `hands_resolve` / `hands_resolved` ([session](../control-host/session/)).
- **FleetDO and nestd:** the public keys travel on the fleet channel (`binding_key`) and over `gateway.sock` ([nestd-gateway](../host-internal/nestd-gateway/)); a sandbox host's enrollment response carries its tunnel token and the gateway URL the control plane will advertise for it ([enrollment](../control-host/enrollment/)).

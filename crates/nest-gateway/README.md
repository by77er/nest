# nest-gateway

The one network door into a sandbox. One unprivileged Rust process per sandbox host: a client opens one WebSocket per hands call, sends a signed binding, and the gateway pipes host-guest frames to the guest's vsock port. **It holds no secret but the public verification keys, terminates no TLS (cloudflared or a test port sits in front), and knows nothing about brains.**

- **Design docs:** `docs/sandbox/gateway/`
- **Protocol:** `docs/interfaces/gateway/` (`nest_protocol::gateway`) and the nestd link `nest_protocol::host::gateway_link`

```
nest-gateway [--listen 127.0.0.1:18790] [--nestd-sock /run/nest/gateway.sock]
RUST_LOG=debug   # tracing filter
```

## Modules

| Module | Role |
|---|---|
| `state` | What nestd said: keys (`kid` → raw P-256 point), sandboxes (epoch, vsock socket, attached clients, guest version), the resync generation, and the open connections it can cut (close code 4409) |
| `verify` | The bind check in the documented precedence: gateway version → token shape → claims version → `unknown_key` → signature, expiry, scope → `moved`/`busy` → `stale_epoch`/`busy` → client attached → guest known → guest version |
| `server` | Accept, route (`/hands` only; `/pty` and `/ingress/*` answer 501), the bind handshake (5 s), the vsock `CONNECT 1025`, then the pipe: exactly one frame per message, the first frame checked against the binding (4401), guest frames re-framed one per message, a hangup on either side ends the call |
| `link` | Dials nestd, says hello, applies `key_update` / `sandbox_upsert` / `sandbox_remove` / `resync_done`, answers pings; losing the socket clears everything and cuts every connection, then reconnects with backoff |
| `testing` | A ring ECDSA signer that mints bindings the gateway accepts, for this crate's tests and for other crates that need a gateway without nestd (`State::set_key`, `State::upsert_sandbox`, `serve`) |

## Behavior worth knowing

- **Fail closed:** with nestd gone there are no sandboxes, so every bind is `moved` and every open call is cut with 4409 (the public keys stay, so a bind after a link loss is `moved`, not `unknown_key`). During a resync an unknown sandbox is `busy`, not `moved`. SIGTERM cuts every call the same way and waits up to 2 s for the close frames to go out before the process exits.
- **Nothing is forwarded before the checks pass:** a refused bind never opens the guest's port, and a first frame whose agent, epoch or version differs from the binding closes the connection before the guest sees a byte. A connection is registered against its sandbox and epoch, under the same lock that re-checks both, before the guest's port is opened, so a sandbox that leaves between the check and the first frame is refused or cut, never piped.
- **Bounded before authentication:** the upgrade and the `bind` share one 5 s deadline from the accept, at most 256 connections sit before `bound` at once (each may hold a 16 MiB message), and every write toward a client has a 2 s bound, so a client that stops reading cannot pin a task, its registration or the guest connection.
- **One frame per message:** `len == message_len - 4` with a known kind, or the connection closes with 4400; a message over 16 MiB is refused by the WebSocket layer.
- **Detach revokes:** a binding whose client is not in the sandbox's attached set is `unauthorized`, so a detached agent's hour-long binding stops working at once.
- **Logs** carry sandbox ids, clients and outcomes, never a token or a key.

## Not built

- The `/pty` and `/ingress/<port>` routes (terminals, previews, port-forwards).
- Key rotation beyond accepting a list of keys (the control plane sends one key).
- An Access service-token check at the gateway itself: the edge (Cloudflare Access) does that in front of the tunnel.

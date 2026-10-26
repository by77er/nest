# nestd ↔ sandbox gateway

How nestd feeds the [gateway](../../../sandbox/gateway/) everything it needs to admit a hands call: the cell's binding verification keys and, per sandbox, the epoch, the host-side vsock socket, the attached clients and the guest's version. Rust types: `nest_protocol::host::gateway_link`. Fixtures: `protocol/fixtures/host/gateway_command/`, `protocol/fixtures/host/gateway_event/`. **Built** (`crates/nestd/src/gateway_link.rs`, `crates/nest-gateway/src/link.rs`).

## Transport

`/run/nest/gateway.sock` (`paths::GATEWAY_SOCK`; the e2e uses `<run_dir>/gateway.sock`): nestd listens (`SOCK_STREAM`, `0660` with the configured group), the gateway connects. Length-prefixed JSON (`u32` big-endian, then one object, 16 MiB at most) like `runner.sock`. The peer uid is checked with `SO_PEERCRED` against `sockets.gateway_uids`; one gateway is served at a time, and a second connect is refused while the first is live. The gateway reconnects with a backoff from 250 ms to 5 s, reset once a `hello_ack` arrives.

## Messages

**gateway → nestd (`GatewayEvent`)**

| `type` | Purpose |
|---|---|
| `hello` | First frame: `protocol_version` (the host protocol's; a mismatch ends the session), `instance_id` (random per gateway process), `listen` (the address it accepts WebSockets on, for nestd's logs; the URL clients use is nestd's own `gateway_url` configuration) |
| `pong` | Answer to `ping` |
| `error` | `invalid_message` for an undecodable command; the link stays up |

**nestd → gateway (`GatewayCommand`)**

| `type` | Purpose |
|---|---|
| `hello_ack` | `protocol_version`, `host_id`. A full replay follows on every (re)connection |
| `key_update` | `keys[{kid, public_key}]`: every binding verification key still valid (ECDSA P-256, the uncompressed SEC1 point, base64url without padding); replaces the set. The gateway keeps only 65-byte points starting with `0x04` |
| `sandbox_upsert` | A sandbox this host runs: `epoch`, `vsock_uds_path` (the gateway connects it and writes `CONNECT 1025`), `clients[]` (agent ids with a configured slot: a binding whose client is not listed is `unauthorized`, which is how `detach` revokes), `guest?{protocol_version, capabilities}` (absent until the guest's hello: bindings get `busy`), `client_floors?{<client>: agent epoch}` (a binding whose `agent_epoch` is below its client's floor is `stale_epoch`; a raise cuts that client's open connections below it with 4409; never lowered while the sandbox stays, dropped with it). A newer epoch replaces the old one and cuts its open connections with 4409 |
| `sandbox_remove` | The sandbox left this host: open connections close with 4409, bindings answer `moved` |
| `resync_done` | Ends the replay after `hello_ack`: entries not re-sent since `hello` are dropped, and an unknown sandbox answers `moved` instead of `busy` from here on |
| `ping` | Every 5 s |

## Rules

- **nestd is the source of truth.** It keeps a mirror and replays it in full on every connection: `hello_ack`, `key_update`, one `sandbox_upsert` per sandbox, then `resync_done`. Deltas follow as they happen: a boot or resume (no `guest` yet), the guest's hello (with `guest`), every slot change (`agent_attach`, `agent_detach`), every floor raised by `agent_attach.agent_epoch` (sent at once, before the slot work), and `sandbox_remove` on fence, destroy and a failed create. An upsert identical to the last one sent is not resent.
- **A fenced epoch is never re-added.** `sandbox_remove` from a fence tombstones the epoch in nestd's mirror; a teardown (a failed create that SandboxDO retries at the same epoch, a destroy, an archive, a move) and a suspend forget the entry without a tombstone, the rule nest-proxy's listeners follow, so a late upsert from a command that was awaiting the guest when the fence landed changes nothing; only a newer epoch can replace it (the same rule nest-proxy's listeners follow). A suspend forgets the entry without a tombstone, since the same epoch resumes and is re-upserted.
- **Liveness both ways.** nestd pings every 5 s and drops a peer silent for 15 s, counting only decodable frames; a send that stalls past 15 s drops the peer too, so a wedged gateway never blocks a replacement from connecting. The gateway drops a link silent for 30 s and expects `hello_ack` within 10 s.
- **Losing the socket is a fence.** When the link ends for any reason, the gateway forgets every sandbox, cuts every open connection with 4409, and answers `moved` to every bind until a new replay completes; its keys stay, since they are public. A dead nestd therefore fences its gateway without a message. When nestd's lease lapses it sends `sandbox_remove` for every sandbox before the pauses complete.
- **Nothing about hands ever crosses `runner.sock`:** this socket and the session channel are the only places a sandbox's address or a binding exist on a host.

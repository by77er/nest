# gateway doc audit (docs/sandbox/gateway/README.md)

## Corrections

| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| docs/sandbox/gateway/README.md:12 | A connection that hasn't finished upgrade and `bind` within 5 s "is dropped", and at most 256 "may be in that phase" | After the upgrade, the 5 s deadline answers `bad_request` (only a connection that never upgraded is dropped); the 256-permit semaphore is held from accept until after the guest vsock connect, i.e. until `bound` | crates/nest-gateway/src/server.rs:29-30, 81-83, 118, 169, 266-310 (`Err(_) => return Some((ws, None, via))` then `refuse(BAD_REQUEST)` at :132-134); docs/interfaces/gateway/README.md timers row agrees |
| docs/sandbox/gateway/README.md:15 | "the jail grant and the unit's hardening are unverified on a host" | Verified on a host 2026-11-06: as `nest-gw` under the unit's file-access properties the probe connected to a socket in a jail with nestd's modes (0711 dirs, 0710 root, 0660 socket), and a production host's gateway under its unit bound a VM over the tunnel. Network restrictions (IPAddressDeny, SocketBindAllow) not covered by that record, so kept as unverified | dev/rollout/2026-11-05-instance-store-hosts-come-back.md:6-11; dev/measure-cut/results-probe-i-0705fb9b9898f4f2f.json; dev/measure-cut/probe-instance-store.sh:42-59 |

## Parent summary lines to update

None found repeating the corrected facts (grepped docs/README.md, docs/architecture/README.md, docs/sandbox/README.md for "unverified on a host", "256", "5 s").

## Unconfirmed claims

- docs/sandbox/gateway/README.md:3 — per-host tunnel "verified on AWS on 2026-10-23" and Access "since 2026-10-24" — backed only by docs/README.md:269 (spike item 13) and docs/architecture/README.md:12; no record under dev/cloud-checks/ or e2e/FINDINGS.md found with those dates.
- docs/sandbox/gateway/README.md:18 — cloudflared dials on port 7844, QUIC falling back to HTTP/2 — external Cloudflare fact, not in code; link looks plausible.
- docs/sandbox/gateway/README.md:15 — "a real host's gateway runs as nest-gw" relies on the AMI nestd listing `gateway-user` (deploy/host/install.sh:60-71); the rollout record says "its real gateway, under its real unit" without stating the uid explicitly.

## Suspected code bugs

None.

## Drift outside the area

- crates/nest-gateway/README.md:18 — the `verify` row's precedence list ends at "guest version"; code adds a last step, VM paused -> `busy` with `PAUSED_RETRY_AFTER_MS` (crates/nest-gateway/src/verify.rs:432-466). Suggest appending "→ VM running (`busy`, reason `paused`)".

## Docs with no drift (beyond the two fixes)

Everything else in docs/sandbox/gateway/README.md checked out: routes `/hands`, `/pty`, `/ingress/` (501 for the latter two; nest-protocol/src/gateway.rs:32-34, server.rs:281-291); vsock ports 1024/1025/10000 (nest-protocol/src/guest.rs:25-29); close code 4409 MOVED (gateway.rs:302); SIGTERM shutdown closes all (main.rs:34-42, server.rs:93-100); 2 s paused hint (gateway.rs:49); epoch regression refused and logged (state.rs:150-157); keys survive link loss, sandboxes cleared (state.rs:183-188); first-frame agent_id/epoch/protocol_version check (verify.rs:474-491); 16 MiB, one frame per message (guest.rs:43,97; server.rs:202-209); served range and echo (verify.rs:406, server.rs:172); `via=edge` on `cf-ray` (server.rs:262); `--listen 127.0.0.1:18790`, `/run/nest/gateway.sock` defaults; nestd 0660 + SO_PEERCRED (nestd/src/gateway_link.rs:11,119); 0710/0711/0600, O_NOFOLLOW (nestd/src/driver/firecracker.rs:209-227, driver/access.rs:7,70,80); `gateway_gid`/`gateway_uids`, `gateway-user` feature (nestd/src/config.rs:171-184, deploy/host/bootstrap.sh:136-139); unit hardening (deploy/host/install.sh:141-187); tombstones on fence, forget on suspend, pause marks for checkpoint/suspend/archive (nestd/src/host.rs:1334-1336, 1948, 1806-1812, 1958, 2066, 2404); `/ready` polling, TUNNEL_TOKEN env (nestd/src/cloudflared.rs:16-18, 258); tunnel `nest-<host>`, ingress `http://127.0.0.1:18790`, CNAME to cfargotunnel, 3 env vars, daily sweep (control-plane/src/lib/cloudflare.ts:1-29,184; do/fleet.ts:280); resolve: connected/connecting/down, `edge` only for tunnel targets, non-retryable without `access:gateway` (do/sandbox.ts:1861-1905; do/fleet.ts:2041-2051); enrollment carries tunnel_token + gateway_url (do/fleet.ts:595); binding lifetime 1 h (protocol/gateway.ts:13); Access apps in deploy/lean/Edge/Stack.lean:11-56 with 401; e2e gateway as own uid via setpriv (e2e/inner.sh:42). All relative links and anchors resolve.

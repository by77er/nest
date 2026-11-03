# Ingress

**All inbound traffic arrives through the [gateway](../../gateway/), then over vsock through the guest agent.** Nothing enters the netns.

```
browser ─► Cloudflare Access ─► Worker (<port>-<sandbox>-preview-nest.<zone>)
              exposed? suspended → activator resumes the sandbox, request held
         ─► Tunnel → cloudflared on the current host → gateway (`/ingress/<port>`)
         ─► Firecracker vsock unix socket: "CONNECT 10000" → guest agent → {port} → 127.0.0.1:<port> (falls back to 172.16.0.2)
```

- **Loopback-bound dev servers work,** because the guest agent connects from inside the guest. The gateway needs only file permission on the vsock socket: no privileges, no `setns`.
- **Not built:** the Worker has no preview or share route yet (`control-plane/wrangler.jsonc` routes only `nest.bitcru.sh`). SandboxDO mints the names, and signs share links, for when it does.
- **Routing in the Worker:** it looks up the sandbox's current host in SandboxDO and proxies to that host's single tunnel hostname, protected by an Access service token. WebSockets (hot module reload) pass through. Previews follow a sandbox when it moves, and **a request to a paused or suspended sandbox wakes it**. Hands, terminals and port-forwards skip the Worker: the client calls `resolve`, gets the hostname and a binding, and connects to the gateway itself ([gateway](../../gateway/)).
- **Ingress guards:** an in-flight HTTP response, or an open WebSocket or terminal, keeps the sandbox from pausing or suspending while its client keeps reading. A stalled reader counts as absent, and a stream counts for at most 2 h ([idle rule](../../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Exposure is opt-in per port:** `nest expose 3000` in the sandbox, or the `expose_port` tool. The guest agent watches `/proc/net/tcp` and reports listening ports; nestd turns a newly opened one into a `port_opened` sandbox event, which FleetDO logs.
- **Auth:**
  - `*-preview-nest.<zone>` sits behind Access, so only me.
  - `*-share-nest.<zone>` has no Access; the Worker is to check a signed, expiring token for one specific `{sandbox, port}` (not built).
  - Every nest hostname is a first-level label of the Cloudflare zone, so Universal SSL covers it, and the kind of a name is its suffix. The sandbox hosts' own hostnames sit beside these as `<host>-gw-nest.<zone>` with no Worker route; the full table is in [setup](../../../setup/#hostnames).
- **Host header:** dev servers often reject unfamiliar `Host` values (DNS-rebinding protection). The router sends `Host: localhost:<port>` and passes the original as `X-Forwarded-Host`, configurable per exposed port.
- **Over the same vsock channel:**
  - **Terminal attach:** a PTY, over WebSocket → the gateway's `/pty` route → vsock, with a `pty` binding. A dropped connection detaches it for 60 s ([guest agent](../../guest-agent/#terminals)), and the client reattaches with the terminal id, its byte offset and a reattach token. **The token never goes in a URL:** Cloudflare logs the request URI with its query string ([`ClientRequestURI`](https://developers.cloudflare.com/logs/reference/log-fields/zone/http_requests/#clientrequesturi)), so it travels in the first WebSocket message.
  - **`nest port-forward <sandbox> <port>`:** raw TCP over the gateway's `/ingress/<port>` route, with an `ingress` binding.
- **Fencing:** a stale host's gateway refuses connections (`moved`, `stale_epoch`), and the Worker routes only to the host holding the current lease.
- **cloudflared** dials out only; the host accepts no inbound connection. Each host's tunnel and DNS record live and die with the host ([gateway addressing](../../gateway/)).

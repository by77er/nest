# Ingress

**All inbound traffic arrives over vsock through the guest agent.** Nothing enters the netns.

```
browser ─► Cloudflare Access ─► Worker (<port>-<sandbox>.preview.<domain>)
              exposed? suspended → activator resumes the sandbox, request held
         ─► Tunnel → cloudflared on the current host → preview router
         ─► Firecracker vsock unix socket: "CONNECT 10000" → guest agent → {port} → 127.0.0.1:<port> (falls back to 172.16.0.2)
```

- **Loopback-bound dev servers work,** because the guest agent connects from inside the guest. The preview router needs only file permission on the vsock socket: no privileges, no `setns`.
- **Routing in the Worker:** it looks up the sandbox's current host in SandboxDO and proxies to that host's single tunnel hostname, protected by an Access service token. WebSockets (hot module reload) pass through. Previews follow a sandbox when it moves, and **a request to a suspended sandbox wakes it**.
- **Exposure is opt-in per port:** `nest expose 3000` in the sandbox, or the `expose_port` tool. The guest agent watches `/proc/net/tcp` and reports newly opened ports as events, so the UI and subscribed agents can offer a preview link.
- **Auth:**
  - `*.preview.<domain>` sits behind Access, so only me.
  - `*.share.<domain>` has no Access; the Worker checks a signed, expiring token for one specific `{sandbox, port}`.
- **Host header:** dev servers often reject unfamiliar `Host` values (DNS-rebinding protection). The router sends `Host: localhost:<port>` and passes the original as `X-Forwarded-Host`, configurable per exposed port.
- **Over the same vsock channel:**
  - **Terminal attach:** a PTY, over WebSocket → nestd → vsock.
  - **`nest port-forward <sandbox> <port>`:** raw TCP over the same authenticated WebSocket.
- **Fencing:** a stale host's router refuses connections, and the Worker routes only to the host holding the current lease.
- **cloudflared** dials Cloudflare outbound on port 7844: QUIC, falling back to HTTP/2 over TCP. No inbound ports.

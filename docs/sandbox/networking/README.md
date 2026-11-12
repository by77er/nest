# Networking

**Every sandbox sees the same network, and that network leads nowhere except nest-proxy.** Anything that differs between sandboxes lives on the host or behind vsock.

```
guest:          eth0 172.16.0.2/30   MAC 06:00:AC:10:00:02   gw/DNS/proxy 172.16.0.1
netns ns-<id>:  tap0 172.16.0.1/30 + listening sockets owned by nest-proxy — no veth, no route, no NAT
ingress:        the gateway → vsock (Firecracker's host-side unix socket → guest agent)
```

- **Egress:** the only reachable addresses are nest-proxy's listeners on `172.16.0.1`, which nestd binds inside the netns and hands to the unprivileged proxy. Anything else is rejected at once (UDP/443 too, so HTTP/3 falls back to TCP). The VM boots right after nestd pushes its policy (waiting for the proxy's acknowledgement is designed, not built), and the proxy refuses non-public addresses on the host's side. See [egress/](egress/).
- **Ingress:** previews, terminals and port-forwards all arrive through the [gateway](../gateway/), then over **vsock** through the guest agent; hands take the same door. Only the hands route is built. Loopback-bound servers work, and nothing needs network access into the netns. See [ingress/](ingress/).
- **Snapshots restore unchanged** on any host or into any fork. nestd rebuilds the host side (netns, tap0, nft, listeners) before Firecracker starts.
- **Sandboxes can't reach each other.** With identical addresses and no routes, it's structurally impossible. An explicit **link** would go through the proxy (not designed yet).
- **Control and identity go over vsock.**
- **TCP connections drop on suspend or move.** Clients retry. Brains are unaffected: they run on brain hosts and reach the sandbox through the gateway, and their next `resolve` names the new host.
- The guest is IPv4-only. The proxy chooses the upstream address family.

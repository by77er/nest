# Steering

**nestd** (privileged) builds each sandbox's network before Firecracker starts:

1. Create netns `ns-<id>` with `tap0` = `172.16.0.1/30`. No veth, no default route.
2. Install nft rules in the netns:
   - tcp/80 and tcp/443 from the guest → redirect to the transparent listeners on `172.16.0.1`
   - udp/53 and tcp/53, the explicit listener ports and the TCP-exception ports to `172.16.0.1` → accept
   - everything else → **reject**: TCP with a reset, anything else with ICMP port-unreachable. A rejected connection fails at once where a dropped one waits out a timeout; the guest is the only sender, so rejecting reveals nothing. In particular, UDP/443 (QUIC) is rejected, so HTTP/3 clients fall back to TCP immediately, as in [SPACE's guardrails](https://github.com/perplexityai/space/blob/main/docker/space/nftables/sandbox-pre-tproxy-guardrails.json).
3. Create the **listening sockets inside the netns** (a helper thread does `setns` → `socket`/`bind`/`listen` → switches back; a socket keeps the namespace it was created in):
   - `:53` udp+tcp (DNS)
   - `:80` and `:443` (transparent)
   - `:3128 + slot` per agent (explicit proxy)
   - one port per TCP-exception rule
4. Send the fds to **nest-proxy** over a unix socket (`SCM_RIGHTS`), each tagged `{sandbox, epoch, purpose, agent?, rule?}`. nestd keeps duplicates.
5. **Push the policy.** nestd sends `sandbox_upsert` (the policy) and `secrets_set`, and boots the VM without waiting for an answer. **Designed, not built:** the policy, its sha256 and the binding secrets travel in one `sandbox_upsert`, and the VM starts or resumes only after nest-proxy answers `policy_ack` with the same `(sandbox, epoch, version, sha256)`, so a guest never runs against a missing or wrong policy. See [nestd-proxy](../../../../interfaces/host-internal/nestd-proxy/#policy-acknowledgement).

- **nest-proxy never calls `setns`** and needs no privileges. It accepts on the fds it was given. Connections to the internet are opened from the root namespace.
- **On proxy restart,** the proxy reconnects and nestd resends the full state: every listener, from duplicated fds. Pending connections wait in the kernel's accept queue. If the counts in `resync_ack` don't match what nestd sent, nestd closes the connection so the proxy resyncs again.
- **Access:** `proxy.sock` is mode `0660` with an optional group, the peer uid is checked with `SO_PEERCRED`, and only one proxy is served at a time.
- **The link never blocks nestd:**
  - Queued commands carry their own duplicated fds, so the mirror lock is never held during a send.
  - Sends time out after 2 s.
  - A ping watchdog disconnects a proxy that hasn't answered for 15 s.
  - In all of these cases the proxy fails closed until it resyncs.
- **Bad packets:** an oversized or undecodable packet from the proxy is dropped, not the connection.
- **Fenced epochs:** once nestd drops a sandbox epoch for fencing, nothing re-adds it (not policy, secrets or listeners).
- **Changes:**
  - **New agent or new TCP-exception rule:** nestd binds another port and sends it.
  - **Teardown:** nestd tells the proxy to drop the sandbox and closes its own copies.
  - **Self-fence:** the same, plus removing the netns.
- **Suspended sandboxes** keep their netns and listeners, which cost nothing. On restore elsewhere, the same steps run on the new host.

## Kernel backstop

nest-proxy runs in the host's root namespace, where IMDS and the instance role's credentials are reachable, so its [hard-deny check](../policy/#hard-deny) gets a kernel layer that a proxy bug can't bypass:
- nestd installs an nft `output` rule in the root namespace that matches the proxy's uid (`meta skuid`) and **rejects** every non-public destination the kernel can express: `169.254.0.0/16` (IMDS, `169.254.170.2` and the rest of link-local), loopback, private, CGNAT, multicast and reserved IPv4, and loopback, link-local and unique-local IPv6 (`fc00::/7`, which holds IPv6 IMDS).
- **One exception:** udp and tcp port 53 to the host's resolver (from `/etc/resolv.conf`), which the proxy's upstream resolution needs.
- Accepted guest connections live in the sandbox's netns, so the rule never touches them.
- Embedded-IPv4 IPv6 forms stay the proxy's job.

SPACE puts its kernel guardrails (IMDS, the ECS credentials endpoint, RFC 1918) on guest traffic before its transparent proxy ([nftables guardrails](https://github.com/perplexityai/space/blob/main/docker/space/nftables/sandbox-pre-tproxy-guardrails.json)). A nest guest can reach only the proxy, so nest's kernel layer goes on the proxy's own connections.

## Attribution

The guest agent sets `HTTP(S)_PROXY=http://172.16.0.1:<3128+slot>` on every hands exec, so **the listener port identifies the agent**. Traffic that ignores proxy settings reaches the transparent listeners and is attributed **to the sandbox only**. The host can't see the guest's cgroups. Attribution is best-effort; enforcement is per sandbox.

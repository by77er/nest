# Steering

**nestd** (privileged) builds each sandbox's network before Firecracker starts:

1. Create netns `ns-<id>` with `tap0` = `172.16.0.1/30`. No veth, no default route.
2. Install nft rules in the netns:
   - tcp/80 and tcp/443 from the guest → redirect to the transparent listeners on `172.16.0.1`
   - udp/53 and tcp/53, the explicit listener ports and the TCP-exception ports to `172.16.0.1` → accept
   - everything else → drop
3. Create the **listening sockets inside the netns** (a helper thread does `setns` → `socket`/`bind`/`listen` → switches back; a socket keeps the namespace it was created in):
   - `:53` udp+tcp (DNS)
   - `:80` and `:443` (transparent)
   - `:3128 + slot` per agent (explicit proxy)
   - one port per TCP-exception rule
4. Send the fds to **nest-proxy** over a unix socket (`SCM_RIGHTS`), each tagged `{sandbox, epoch, purpose, agent?, rule?}`. nestd keeps duplicates.

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

## Attribution

The guest agent sets `HTTP(S)_PROXY=http://172.16.0.1:<3128+slot>` on every hands exec, so **the listener port identifies the agent**. Traffic that ignores proxy settings reaches the transparent listeners and is attributed **to the sandbox only**. The host can't see the guest's cgroups. Attribution is best-effort; enforcement is per sandbox.

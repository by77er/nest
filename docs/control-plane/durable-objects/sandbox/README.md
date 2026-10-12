# SandboxDO

The authority for one sandbox.

**State:**
- Epoch and current host; the epoch→host history (which host held which epoch)
- Head generation and the generation chain (including orphaned salvage generations)
- Attached agents, the idle refcount
- Policy layers: base, workstream (allow, passthrough, injection bindings, TCP exceptions), sandbox (temporary grants)
- Exposed ports

**Placement:**
- **Every placement attempt grants a new epoch.** Creation places at epoch 1.
- **A placed or being-placed sandbox is never placed again.** A `placing` marker guards the FleetDO call, and a marker left by an eviction is reconciled against FleetDO's lease after 60 s.
- **No capacity:** the sandbox stays unplaced and its own alarm retries every 30 s.
- **Failed create:**
  - Retryable failures, e.g. nestd restarting before it ran the command, are re-issued up to 3 times.
  - Otherwise the sandbox is `failed`. The operator's `POST /place` fences it on the old host, releases the lease and places it again under a new epoch.

**Lease loss** (`leaseLost`, after STONITH):
- Idempotent: FleetDO retries it until it succeeds.
- The sandbox is placed elsewhere under a new epoch, restoring from head.
- Bound agents are told to follow. One agent failing to follow doesn't stop the others.

**Commits:**
- `commit(epoch, parent, manifest)` is a compare-and-set, accepted only from the lease holder at the current epoch with the head as parent. It's idempotent per request.
- A **salvage** commit from an older epoch becomes an orphaned sibling generation (raising `orphaned_work`), but only from the host that held that epoch.

**Policy:**
- **Changes:** set by the operator (`PUT /v1/sandboxes/<id>/policy`) or a temporary grant, and pushed live as `policy_update`.
- **Injection secrets:** pushed as BrokerDO references, resolved only when FleetDO sends them.

**Ports:**
- `port_expose` / `port_unexpose`.
- **Public share links** bypass Cloudflare Access, so only the operator API mints them, never an agent.

**Idle rule:** the sandbox may suspend once every attached agent is between turns. Suspend, resume and fork aren't issued yet.

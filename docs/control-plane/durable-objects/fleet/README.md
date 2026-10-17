# FleetDO

One per cell: hosts, enrollment, leases, placement, drains, STONITH, base generations and command delivery.

- **Enrollment:**
  - **One-time enrollment token** minted by the operator for a role.
  - **AWS signed identity document**, accepted only for an instance this control plane recorded as launched in this cell, as the recorded role, from the recorded account and region, and only once.
  - **Order:** the CSR for nest-proxy's intermediate CA is validated before the proof is consumed, so a bad CSR doesn't burn a token. Only the fixed CSR shape is accepted, and the intermediate is signed with the KMS-held root ([TLS](../../../sandbox/networking/egress/tls/)).
  - **Host tokens** are short-lived and rotated over the fleet channel. A host that was disconnected past expiry can still open the fleet channel for 24 h, and gets a fresh token right after hello.
- **Fleet channel:** nestd connects here and heartbeats every 5 s, which renews the leases of every sandbox on the host. See [../../../sandbox/fencing/](../../../sandbox/fencing/).
- **Hello reconciliation:**
  - **Sandboxes:** reported sandboxes we don't honor, including any below SandboxDO's current epoch, are fenced, salvaged if dirty and destroyed; the reported state of honored ones is adopted as evidence. `head`/`dirty` are informational.
  - **Agents:** a brain whose `agent_start` completed but that the host no longer reports is marked detached. Reported ones keep the reported state.
  - **New nestd process:** a new `instance_id` resets both seq lineages. Unfinished commands then fail retryably, except a `sandbox_create` the host reports running, which completes.
- **Commands:** persisted, delivered in order, exactly one result each.
- **Leases:**
  - **One lease, one host:** placement refuses a sandbox that already holds a lease, and a lease is never overwritten.
  - **Expiry:** a host silent for 30 s has its leases expired.
  - **Controller hosts** hold no sandbox leases. One silent for 30 s is marked `expired`, and its agents (none of which have hands) start on another controller host without STONITH: nothing on it can run twice, its runner killed the brains when its lease lapsed at 20 s, and only an agent's assigned host may attach its session. Its next `hello` makes it active again.
- **STONITH:**
  - **EC2:** terminates the old instance (signed with `aws4fetch`) and waits until it's `shutting-down`/`terminated`.
  - **Without EC2:** waits for the host to reconnect and fence. The fence is re-issued on every hello, every tick and after a failure, until one succeeds.
  - **Operator:** can confirm a host dead.
  - **Reassignment:** an idempotent per-sandbox queue that the alarm retries, so one failure can't strand the others.
- **Restore ABIs:** each host advertises the [restore ABIs](../../../sandbox/state/memory/#restore-abi) it can create and load (in `hello` and `capacity`), and each host release records the ones its hosts will have, so FleetDO knows whether launching a host would help. A memory generation is placed only on a host that loads its ABI; if none with room does and the desired host version wouldn't either, the sandbox boots disk-only.
- **Placement** grants a lease at the epoch of a SandboxDO [claim](../sandbox/#placement), only once every older epoch's lease is gone. It packs: among hosts whose free hugepages and vCPUs fit the sandbox, prefer one with its snapshot warm and a loading restore ABI, then the one with the fewest free hugepages that still fit, then fewest free vCPUs. Packing lets idle hosts empty out and scale to zero; spreading keeps every host partly full. An undersized hugepage pool makes Firecracker fail with SIGBUS, so hugepages are reserved, never overcommitted; paused sandboxes keep theirs. Disk I/O isn't packed; each sandbox's drive is rate-limited instead ([I/O limits](../../../sandbox/state/disk/#io-limits)).
- **Drains** ([modes](../../../compute/autoscaling/)): a draining host gets no new placements, and its resident sandboxes become `evacuating`. **FleetDO terminates a drained host only when, for every resident sandbox:**
  - SandboxDO's head is the host's last committed generation for it (exact ids, through [`isRestoreSource`](../../../sandbox/state/#restore-sources));
  - that head is `ready`, verified when it was committed;
  - the host's pending-upload list is empty. The list is all-or-nothing: an answer the host can't complete is an error, never a short list, because a short list looks the same as a complete one.

  A spot notice doesn't wait for the gate: the instance goes anyway, and whatever didn't commit is recorded as a loss.
- **Base generations:** an index of `(image digest, restore ABI) → generation` for the cell, with a per-digest backoff for failed preparation ([base generations](../../../sandbox/state/memory/#base-generations)). Each is a GC root until its image is retired.
- **Object-store GC:** the cell's sandbox registry, the GC schedule and the roots snapshot. A burst host runs the pass ([GC](../../../sandbox/state/object-store/#garbage-collection)).
- **Not built:**
  - **The desired host version** per cell, which drives [host upgrades](../../../compute/provisioning/#upgrades).
  - **Command batching:** one frame per `issueCommands` call.
  - **Packing:** placement is least-loaded by lease count (warm snapshots first); hugepage-aware packing and the restore-ABI match aren't built.
  - **Drains, the drain gate and base generations.**

# SandboxDO

The authority for one sandbox.

## State

- Epoch and placement (below); the epoch→host history (which host held which epoch)
- The generation chain: head, retained generations, orphaned salvage generations, pins and loss records ([state](../../../sandbox/state/))
- Attached agents, the idle refcount, ingress guards and holds
- Resources: vCPUs, memory, disk I/O limits ([I/O limits](../../../sandbox/state/disk/#io-limits))
- Policy layers: base (image), sandbox (allow, passthrough, injection bindings, TCP exceptions; set by whoever holds `egress_policy` on it, and inherited by forks), temporary grants. Built: the middle layer is still the `workstream` layer, set by the operator API ([pending contract changes](../../../interfaces/README.md#pending-contract-changes)).
- Exposed ports
- The channels programs inside it may post to (`sandbox_create{channels}`; by default its own `events`)

## Placement

**A fenced claim:** claim in the DO, do the work on a host, then complete with one compare-and-set.

| State | Meaning |
|---|---|
| `unplaced{head}` | No host holds it: never placed, archived, or its host was lost. It restores from `head` (a new sandbox from its image) |
| `placing{host, epoch, attempt, lease_expires}` | One claimed attempt on the host FleetDO picked. Exists only while its lease is live |
| `placed{host, epoch}` | The host holds the lease. Running, paused or suspended there; the host's reports say which |
| `evacuating{host, epoch, mode}` | Placed on a draining host; it leaves through a suspend ([drains](../../../compute/autoscaling/)) |

- **Claim:** one synchronous mutation that issues the next epoch with a 2-minute lease. Outcomes: `Claimed`; `AlreadyOwned{lease_expires_at}` (a live claim holds it); `Backoff{next_attempt_at}` (a recent attempt failed); `Blocked(reason)` (being destroyed, or parked). Creation claims epoch 1.
- **Then FleetDO** picks a host and grants its lease at that epoch, only once every older epoch's lease is gone: fenced on a live host, or expired and STONITHed on a silent one ([fencing](../../../sandbox/fencing/)).
- **No stuck state:** an expired `placing` reads as `unplaced` with its head restorable, so nothing has to sweep it.
- **Completion** is one compare-and-set. It checks that the epoch is still the newest issued and that the host reported, at that epoch, the VM running, the guest agent's hello, and the guest agent ready (its post-resume fixes done). Outcomes: `Completed`; `Superseded` (a suspend or destroy asked for meanwhile takes over, and the running VM is handed to it, not lost); `CasLost` (nothing written, and that epoch is fenced). **An epoch is never retried;** a retry is a new claim.
- **Evidence never authorizes.** Heartbeats, `sandbox_state` and `hello` reports can block a completion but never make a transition.
- **Failures:** no capacity releases the claim and backs off 30 s. A failed create or restore backs off 30 s, doubling to 10 min, and after a failed memory restore the next attempt boots disk-only. After three failed attempts the sandbox rests unplaced at its head (it reads as suspended) until something needs it.
- **Never terminally failed while a committed head exists.** Only a sandbox with no committed generation, whose create from its image keeps failing, is `failed`. The operator's `POST /place` claims again at once, skipping backoff.

## Losses

**Every abandon and every STONITH writes a loss record** and posts it to the sandbox's `events` as a rollback notice: "work since generation G (at T) lost", and "process state lost" when a memory head comes back disk-only. No loss is implicit. The recovery point is the [commit cadence](../../../sandbox/state/#writeback-cadence).

## Lease loss

`leaseLost`, after STONITH:
- Idempotent: FleetDO retries it until it succeeds.
- It records the loss, then claims again under a new epoch, restoring from head.
- Bound agents are told to follow. One agent failing to follow doesn't stop the others.

## Commits and generations

- `commit(epoch, parent, manifest)` is a compare-and-set, accepted only from the lease holder at the current epoch with the head as parent, for a manifest the host has [verified](../../../sandbox/state/#generations). It's idempotent per request.
- A **salvage** commit from an older epoch becomes an orphaned sibling generation (raising `orphaned_work`), but only from the host that held that epoch.
- **Pins:** a claim pins the generation it restores, and a fork pins its source, by id, until completion or abandon (for a fork, until the child has recorded it as its head).
- **`isRestoreSource`** lives here and is the only answer to "may this be loaded or deleted" for resume selection, the drain gate and GC ([restore sources](../../../sandbox/state/#restore-sources)).
- **Retention** runs from the alarm: it thins generations and marks them `deleting`, which is one-way ([retention](../../../sandbox/state/#retention)).
- **The single writer serializes** fork admission, sandbox destruction and retention: a fork can't pin a `deleting` generation, retention can't delete a pinned one, and a destroy keeps pinned generations until their forks finish.

## Activity and idle

**A sandbox may pause or suspend only when** no agent is mid-turn, no ingress guard is live, and no hold is active.
- **Ingress guards,** reported by the host: an in-flight HTTP response, or an open WebSocket or terminal through [ingress](../../../sandbox/networking/ingress/). A stream counts only while its client keeps reading, so a stalled reader counts as absent, and for at most 2 h, so a forgotten tab can't keep a sandbox up (SPACE's cap; [spaced_bridge.rs](https://github.com/perplexityai/space/blob/main/crates/libs/sbx/mgr/server/src/service/spaced_bridge.rs)).
- **Holds:** `nest hold <duration>` from inside the sandbox keeps it awake for background builds and dev servers, up to the sandbox's maximum hold (1 h by default). A later call replaces the hold, and `nest hold 0` ends it ([CLI](../../../agents/tools/#the-nest-cli-inside-sandboxes)). A running background hands task holds it the same way, so the task's exit can still wake its agent. A guest can ask to stay awake, never to pause, suspend or shut down.
- **Staged:** idle for 1 min → **pause** (vCPUs stopped, hugepages kept, disk committed; resumes in milliseconds). Paused for 10 min, or sooner when the host needs the hugepages → **suspend** (memory and disk to S3). Both flush the guest first ([disk](../../../sandbox/state/disk/#flush-before-commit)).
- **Superseded:** each wake bumps `wake_seq`. A pause or suspend carries the `wake_seq` it was decided at and is rejected as `superseded` if a wake came after. nestd also re-checks turns and ingress guards under the sandbox lock and answers `busy`, which isn't a failure.
- **Failures back off:** 10 s, doubling to 600 s. After 10 consecutive failures it parks and retries about every 6 h; activity or a success resets the count. The numbers are SPACE's ([auto_lifecycle.rs](https://github.com/perplexityai/space/blob/main/crates/libs/sbx/mgr/server/src/auto_lifecycle.rs)).

## Repair loops

- **Every transient state has an alarm:** `placing`, a pause or suspend in flight, `evacuating`, pins. When it fires, the DO re-derives the state from durable facts (claims, epochs, the head) and retries or releases.
- **Unreachable means defer, never destroy.** A host that doesn't answer gets more time until its lease expires and STONITH settles it. Silence never deletes a generation or a host's local state.

## Policy

- **Changes:** set by the operator (`PUT /v1/sandboxes/<id>/policy`), by a holder of `egress_policy` on it, or by a temporary grant, and pushed live as `policy_update`.
- **Injection secrets:** pushed as BrokerDO references, resolved only when FleetDO sends them.

## Ports

- `port_expose` / `port_unexpose`.
- **Public share links** bypass Cloudflare Access, so only the operator API mints them, never an agent.

## Built

Placement is a `placing` marker, reconciled against FleetDO's lease after 60 s, and a create that fails three times leaves the sandbox `failed`. The typed claim, evidence-checked completion, loss records, pins, retention and the staged idle policy aren't built. The idle refcount is built; pause, suspend, resume and fork aren't issued yet.

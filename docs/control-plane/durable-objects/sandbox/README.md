# SandboxDO

The authority for one sandbox.

## State

- Epoch and placement (below); the epoch→host history (which host held which epoch, every one, in the `epochs` table; `info().history` shows the last 50)
- The generation chain: head, retained generations, orphaned salvage generations, pins and loss records ([state](../../../sandbox/state/))
- Attached clients (agents and people) and their slots, the idle refcount, ingress guards and holds
- Resources: vCPUs, memory, disk I/O limits ([I/O limits](../../../sandbox/state/disk/#io-limits))
- Policy layers: base (image), sandbox (allow, passthrough, injection bindings, TCP exceptions, the push allowlist `repos`, request guards; set by whoever holds `egress_policy` on it, and inherited by forks), temporary grants. The effective policy adds what the rule constructors build from the push allowlist ([repo allowlists](../../../sandbox/networking/egress/policy/#repo-allowlists)): the layer's `repos` plus each attached agent's (kv `agent_repos`, by agent). Built: the middle layer is still the `workstream` layer, set by the operator API ([pending contract changes](../../../interfaces/README.md#pending-contract-changes)).
- Exposed ports
- The channels programs inside it may post to (`sandbox_create{channels}`; by default its own `events`)
- Its `owner` (the agent an `agent_spawn` made it for; none for the operator's), its idle TTL, and its dormancy ([lifetime](#lifetime))

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

## Attach and bindings

A client reaches the sandbox only with a binding this DO issued, whoever and wherever the client is: an agent's runner on a brain host, AgentDO's own loop, or my `nest` CLI ([gateway](../../../sandbox/gateway/)).

- **`attach(client, cwd?)`** records the client and configures its slot in the guest (cwd, proxy port, cgroup) through an `agent_attach` command to the sandbox's host, and holds the client **pending** until that command's `ok` comes back, so a first hands call never beats the slot. A retryable failure is retried with a doubling backoff (2 s to 30 s) for as long as the sandbox is placed; the attach is re-issued for every attached client after every new placement and whenever the sandbox becomes `running` (a suspended sandbox takes the slot once it is back). A repeat `attach` of a confirmed client sends nothing. Needs `attach` on the sandbox.
- **Move notices:** every placement that changes where the sandbox runs (or that it runs nowhere) sets the `notify_moved` alarm, which tells each attached agent (`onSandboxMoved(sandbox, epoch, host)`), retried until all have heard it. Never inline: a placement can be made inside an agent's own start.
- **`resolve(client)`** mints the **binding** and returns the target: the host's `gateway_url`, a binding `{sandbox, epoch, client, scope: hands, exp}` signed by BrokerDO with the cell's key and valid one hour, and the guest's `protocol_version` and `capabilities` from its latest `running` report (never guessed); for one release it also repeats the sandbox and epoch unsigned, for clients of the previous release (current ones read them from the binding). It answers `not_bound` for a client that is not attached, `sandbox_not_ready` (retryable) while the sandbox has no host, is placing, the slot is pending, the guest hasn't reported its version since the placement, the host advertised no gateway, or the host has a tunnel it doesn't serve (logged as an error; its hello URL is its own loopback, never handed out); it resumes a suspended placed sandbox first. After its awaits it re-checks that the client is still attached and confirmed at the same epoch and host, so a detach during signing never yields a token. A runner reaches it through AgentDO (`hands_resolve` on its session channel); an operator or a test harness through `POST /v1/sandboxes/<sbx>/resolve` with the admin token. Bindings are minted here, never at `attach`.
- **`attach(client, cwd?, repos?)`**: an agent's spec `repos` join the sandbox's push allowlist while it is attached (AgentDO passes them at create); a change bumps the policy and pushes a freshly minted token. `allowAgentRepos(agent, repos)` adds to that part (an approved `github.fork`). `detach` takes them away.
- **Injection secrets** are pushed after every placement and every policy change that touches injection: the static ones as BrokerDO references, and for a push allowlist the token BrokerDO mints ([injection minting](../broker/#injection-minting)), again 15 minutes before it expires (deadline `inject_refresh`). A push whose epoch, host or allowlist changed while BrokerDO answered is dropped; the change pushes again. An emptied allowlist pushes the set without the token.
- **`detach(client)`** removes the client and its slot (`agent_detach{kill_processes: true}`); the gateway refuses the client's bindings from the next `sandbox_upsert` on, since it admits only clients in the attached set.
- **Bindings are verified, not stored.** The gateway checks the signature, the epoch, the expiry and the client, and the guest checks the epoch again. Every epoch bump (a new placement claim) revokes every binding, since each names the epoch, and clears the recorded guest version and pending state. A binding valid when a call opened lets that call complete; the next call needs a renewed one.
- **Nothing about the client's backend, model or location** is known here or on the host: the binding names a client id, an epoch and a scope.

## Losses

**Every abandon and every STONITH writes a loss record** and posts it to the sandbox's `events` as a rollback notice: "work since generation G (at T) lost", and "process state lost" when a memory head comes back disk-only. No loss is implicit. The recovery point is the [commit cadence](../../../sandbox/state/#writeback-cadence).

## Lease loss

`leaseLost`, after STONITH, or after the holder reported the sandbox `fenced`:
- Idempotent: FleetDO retries it until it succeeds.
- Keyed on the lease (host, epoch), never on a state a host reported: a sandbox whose last report was `fenced` or `failed` is placed again like any other. A lease this DO never adopted (its placement was cut off) counts as its own.
- It records the loss, then claims again under a new epoch, restoring from head.
- Bound clients keep running wherever they are: their open calls were cancelled by the hangup, their bindings for the old epoch are dead, and their next `resolve` returns the new host and epoch. The loss record reaches each agent through the sandbox's `events` and its recovery turn.

## Commits and generations

- `commit(epoch, parent, manifest)` is a compare-and-set, accepted only from the lease holder at the current epoch with the head as parent, for a manifest the host has [verified](../../../sandbox/state/#generations). It's idempotent per request.
- A **salvage** commit from an older epoch becomes an orphaned sibling generation (raising `orphaned_work`), but only from the host that held that epoch, however many placements ago. The idempotency records of commit requests are kept 7 days, or as long as the generation they committed ([retention](../../../data/#retention)).
- A commit whose `kind` disagrees with its memory manifest (`checkpoint` without `mem_manifest`, or `disk_only` with one) is rejected (`invalid_message`): the chain is immutable, and a checkpoint without memory would restore without it.
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

- **Changes:** set by the operator (`PUT /v1/sandboxes/<id>/policy`), by a holder of `egress_policy` on it, or by a temporary grant, and pushed live as `policy_update`, with its version and sha256, and with its injection secrets in the same push. The VM starts or resumes only after nest-proxy acknowledges that exact policy ([policy changes](../../../sandbox/networking/egress/policy/#changes)).
- **Injection secrets:** pushed as BrokerDO references, resolved only when FleetDO sends them.

## Lifetime

**A sandbox nobody uses is destroyed, through `destroy`** (so FleetDO's registry marks it and its generations stop being GC roots, [commit-gc](../../../verification/commit-gc/)). Built (`checkExpiry`, `release`; rules in `lib/lifetimes.ts`):
- **Dormant:** no agent attached, no placement in flight, and no VM up (`creating`, `restoring`, `running` or `suspending` on a host): suspended, unplaced or failed. `decide`, the step every mutation goes through, keeps `dormant_since_ms`: set at the first dormant change, cleared at once by one that isn't (a wake, a placement, an attach), so a sandbox used again starts its clock over.
- **Idle TTL:** its own (`idle_ttl_ms` at create, from the operator's `POST /v1/sandboxes` or `agent_spawn`; `PUT /v1/sandboxes/<id>/lifetime` sets or clears it), else the cell default: the cell's `sandbox_idle_ttl_ms` in `AWS_CELLS`, else `SANDBOX_IDLE_TTL_MS`, else **30 days**. At least a minute.
- **The `expiry` deadline** checks it (armed at create and on every check, at most an hour apart, sooner for a short TTL): dormant for its TTL → destroyed. A TTL over a day posts a `sandbox_expiring` notice on `user` a day before (saying how to keep it), and destruction never comes less than a day after that notice: a late check posts it and waits. A shorter TTL (an ephemeral worker's, say) gets no notice: whoever set it chose it. Each check records when it ran (`expiry_checked_ms`); after a gap of over 6 hours (missed checks: a rolled-back release, which keeps but never updates the clock, ran meanwhile) the clock and any notice start again, so a missed wake can't shorten a TTL.
- **Owner release:** an ending agent's `release(agent, destroy)` detaches it and, with `destroy`, destroys the sandbox in the same step if the agent owns it and no other agent is attached. A sandbox attached to an agent that hasn't ended (even one stopped by the operator) is never dormant, so never destroyed by its TTL.
- **Older sandboxes:** FleetDO's daily `prune` asks each live registered sandbox to arm its check if it isn't (`ensureLifetime`): first those never asked (`sandboxes.lifetime_ms` null), then each again weekly, 200 a day. So a sandbox from before this release, suspended and called by nobody, gets its TTL too, counted from the first check, and one whose check a rolled-back release dropped gets it back.
- A destroyed sandbox refuses `attach`.

## Ports

- `port_expose` / `port_unexpose`.
- **Names** follow the [hostname rule](../../../setup/#hostnames), derived from `NEST_DOMAIN` (`nest.localhost` when unset, the harness): a preview is `https://<port>-<sandbox>-preview-<label>.<zone>`, the share link `https://<port>-<sandbox>-share-<label>.<zone>/?exp=…&sig=…` (the query carries an HMAC over `{sandbox, port}` and the expiry), with the sandbox id's `sbx_` prefix dropped since a hostname has no `_`. The preview URL is recomputed on every read, never trusted from storage.
- **Public share links** bypass Cloudflare Access, so only the operator API mints them, never an agent. No Worker route serves previews or share links yet ([ingress](../../../sandbox/networking/ingress/)): the URLs are names only.

## Built

Placement is a `placing` marker with a `place` deadline armed with it. A placement that never finished (this DO reset mid-call, or FleetDO's answer lost: the marker stays) is reconciled once 60 s old, by that deadline, `wake()` or the next placement: a live lease FleetDO granted at that epoch is adopted with the state and guest its holder last reported, and no lease clears the marker. FleetDO's `place` is idempotent per (sandbox, epoch). A create that fails three times leaves the sandbox `failed`. The typed claim, evidence-checked completion, loss records, pins, retention and the staged idle policy aren't built. The idle refcount is built, and so is one idle tier: a running sandbox with no agent working is suspended (disk-only) after `SANDBOX_SUSPEND_IDLE_MS`, 11 min by default, the pause and suspend tiers together, since pause isn't in the host contract yet. Ingress guards and holds don't reach the control plane yet, so they don't keep a sandbox awake. **Lazy start** is built: `wake()` resumes a sandbox suspended on its host, or places one that has no host from its head; an agent's start calls it, and a suspended sandbox with nobody working is never placed by its retry alarm; any other unplaced one is, whatever its host last reported (`fenced`, `failed`). A lease loss keeps the agents' working marks (their brains run elsewhere). A destroy is final at once, and FleetDO hears of it before the lease is released, so it grants the sandbox nothing afterwards; a placement answer granted before that releases its lease and destroys the VM. The lease's decisions are a pure core with one function per model action (`control-plane/src/lib/sandbox-lease.ts`), and the slots and the binding rule another (`lib/slots.ts`); SandboxDO keeps the awaits. A placement no host can take (or that FleetDO refuses) rolls its epoch back, so the next claim reuses the number, contrary to "an epoch is never retried" above; it also makes the old holder's salvage fail for good. **Open:** keep it and authorize that salvage, or spend an epoch per attempt ([sandbox lease](../../../verification/sandbox-lease/)). Fork isn't issued yet. `attach`, `resolve` and `detach` are built as described above, with the control plane's tests verifying each minted binding against the key the host received; mints through the operator route aren't audited yet.

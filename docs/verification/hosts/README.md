# Host lifecycle and autoscaling: inventory for a model

What a model of FleetDO ↔ nestd ↔ EC2 ↔ Cloudflare needs: state, transitions, messages, properties, and the bugs found. Code refs are on main (`edf6829`); short names:

| Name | Path |
|---|---|
| `fleet.ts` | [control-plane/src/do/fleet.ts](../../../control-plane/src/do/fleet.ts) |
| `reliable.ts` | [control-plane/src/lib/reliable.ts](../../../control-plane/src/lib/reliable.ts) |
| `ec2.ts` | [control-plane/src/lib/ec2.ts](../../../control-plane/src/lib/ec2.ts) |
| `index.ts` | [control-plane/src/index.ts](../../../control-plane/src/index.ts) |
| `fleet.rs`, `host.rs` | [crates/nestd/src/fleet.rs](../../../crates/nestd/src/fleet.rs), [crates/nestd/src/host.rs](../../../crates/nestd/src/host.rs) |

> **Since** (checked on `main` at b63c0a3): B4 is fixed by #30: the tick expires any silent host, and one holding no lease at once (`expireSilent`), so a host terminated outside FleetDO stops counting toward `max_hosts`. #36 split hosts into two kinds (`sandbox` and `brain`, stored as `burst` and `controller` for one release); the `burst` rows below are today's sandbox hosts.

Design docs: [FleetDO](../../control-plane/durable-objects/fleet/), [autoscaling](../../compute/autoscaling/), [fleet channel](../../interfaces/control-host/fleet/), [enrollment](../../interfaces/control-host/enrollment/).

## 1. Scope, actors, state

**Actors.** FleetDO (one per cell, single-threaded but **the input gate opens across every RPC/fetch await**, so its handlers interleave at awaits; `reliable.ts` `SerialQueue` comment); nestd (one process per host, a new `instance_id` per process); EC2 (RunInstances, TerminateInstances, DescribeInstances, the spot reclaimer, anyone terminating by hand); Cloudflare (tunnels, DNS records); the alarm (`Deadlines` multiplexes `tick` every 5 s while busy and the daily `tunnel_sweep`, `fleet.ts:1291-1332`); the operator (admin routes, `index.ts:143-167`).

**Out of scope:** leases and SandboxDO placement semantics beyond what drives host transitions, reliable-channel internals, GC, CA signing.

**State (FleetDO SQLite, `fleet.ts:180-233`).**

| Table | Columns that matter | Notes |
|---|---|---|
| `hosts` | `status` ∈ {`active`, `draining`, `expired`, `stonith_pending`, `dead`} (`:30`); `role` ∈ {`burst`, `controller`} (`model.ts:72`; no `brain` yet); `instance_id` (null for token enrollment); `last_rx` (null = never said hello); `token_exp`; `nestd_instance`; `idle_since`; `tunnel_id`, `tunnel_hostname`, `dns_record_id`, `tunnel_state` ∈ {null, `none`, `connecting`, `connected`} | No `enrolling` status: a row is born `active` with `last_rx = NULL` (`:355-358`). "Never connected" ≡ `active ∧ last_rx = NULL` (`:331-334`). |
| `launched` | `instance_id`, `launched_ms`, `host` (set at enrollment), `role`, `region`, `account_id`, `cell`, `reason` ∈ {null, `enroll_timeout`, `idle`, `drained`}, `ended_ms` | A launch is *pending* iff `host IS NULL ∧ reason IS NULL` (`:1441`). |
| `enroll_tokens` | `hash`, `role`, `used_ms`, `host` | Pruned 7 d after use (`:1325`). |
| `tunnels_created` | `host`, `created_ms` | Written before the first Cloudflare call; never deleted on main (`:198-200`, `:400`). |
| `commands` | `cmd`, `host`, `type`, `sandbox`, `agent`, `epoch`, `purpose` ∈ {null, `stonith_fence`} (`:110`), `body`, `result`, `result_ms` | Answered rows pruned after 24 h (`:1323`); unanswered rows never pruned. |
| `rel_out`, `rel_state` | per host: unacked command batches by `seq`; `next_out`, `last_in` | `reliable.ts:11-14`. |
| `leases` | `sandbox` (PK), `host`, `epoch`, `expired`, `state` | Drives busy/idle and STONITH. |
| `reassign_queue` | `sandbox` (**PK alone**), `host`, `epoch`, `host_dead`, `attempts` | `:195-196`. |
| `evictions` | (`sandbox`, `host`, `epoch`) | SandboxDO told `evicted`, retried (`:1580-1589`). |
| `host_agents`, `stale_incarnations` | brains per host; incarnations awaiting `sandbox_destroy` | Busy check and dead-host cleanup. |

In memory only: `launching` (a RunInstances in flight, `:175`), `keysSent` (`:1339`), WebSocket attachments `{host, helloed}` (`:83-86`).

**nestd state (`fleet.rs:106-128`).** `last_command_seq` (highest batch processed and acked), `forwarded_command_seq` (highest batch handed to the executor), event outbox `pending`/`unacked`, lease deadline (monotonic and boottime), the saved credentials file (host id, token, tunnel token).

## 2. State machines

### 2.1 Host status

| # | From → to | Actor / trigger | Guard | Effect | Code |
|---|---|---|---|---|---|
| H1 | ∅ → `active` (never connected) | enroll | proof valid and unused, or used by a never-connected host (H2) | row with `last_rx = NULL`, token, tunnel ids | `fleet.ts:347-369` |
| H2 | `active`(never connected) → `dead` | enroll reusing the proof | `neverConnected(prior)` | close sockets, release tunnel, reassign leases | `:337-345` |
| H3 | `active` → `active` (connected) | hello | host not dead, protocol matches | `last_rx`, supersede old sockets, resend commands, reconcile | `:729-797` |
| H4 | `expired` → `active` | hello | prior status `expired` | | `:782` |
| H5 | `active`/`draining` → `stonith_pending` | tick | `now - last_rx ≥ 30 s` ∧ some unexpired lease | expire every lease, close sockets, TerminateInstances, poll | `:1307-1309`, `:1749-1765` |
| H6 | `active`/`draining` → `expired` | tick | silent ≥ 30 s ∧ no unexpired lease ∧ role `controller` | move brains (`onHostLost`) | `:1310`, `:1773-1785` |
| H7 | `stonith_pending` → `active` | fence result ok, or ensureStonithFence finds nothing to fence | every expired lease covered by the fence just reported ∧ a helloed socket | then reassign the fenced sandboxes | `:1107-1121`, `:1827-1830` |
| H8 | `stonith_pending` → `dead` | tick → pollStonith | EC2 state ∈ {null, `shutting-down`, `terminated`} | `confirmHostDead`: close, release tunnel, reassign with `host_dead` | `:1787-1799`, `:1833-1842` |
| H9 | any → `dead` | operator `confirm-dead` | none (no instance terminated on main) | as H8 | `index.ts:157-159` |
| H10 | `active` → `draining` | `spot_notice` event | status `active` | evict suspended leases, `sandbox_suspend{disk_only}` to the rest | `fleet.ts:1042`, `:1544-1554` |
| H11 | `active` → `dead` (idle) | tick → scaleDown | role `burst`, `instance_id` set, no lease with `state ≠ suspended`, no brain, `idle_since` ≥ `idle_grace_ms` (600 s) ago | endInstance(`idle`), release tunnel, close, evict | `:1496-1512` |
| H12 | `draining` → `dead` (drained) | tick → scaleDown | role `burst`, `instance_id` set, no lease at all | endInstance(`drained`), release tunnel, close | `:1515-1523` |

Absent on purpose: no transition out of `dead` (fetch and hello refuse a dead host, `:624`, `:739`; H4/H7/H10 are guarded by prior status). Two unguarded writes break this (B3). A silent host with no unexpired lease and role `burst` has **no** transition until H11 fires (the 10-minute watch item, B4). H7 returns a `draining` host to `active`, losing the drain (B5).

### 2.2 A launch

| From → to | Trigger | Guard | Code |
|---|---|---|---|
| ∅ → pending | `place` finds no connected candidate → scaleUp | AWS cell config and EC2 access, `¬launching`, no pending launch, `#burst hosts in {active, stonith_pending}` < `max_hosts` (default 1, `cells.ts:22`); tries each type on spot, then the first on demand; a non-capacity error stops | `fleet.ts:1234-1237`, `:1437-1480` |
| pending → enrolled | identity enrollment | `launched` row exists; role/region/account match where recorded; `host` NULL or never connected | `:308-322` |
| pending → ending (`enroll_timeout`) | scaleDown | `launched_ms` older than `enroll_timeout_ms` (600 s) | `:1490-1495` |
| enrolled → ending (`idle`/`drained`) | H11/H12 `endInstance` | | `:1572-1578` |
| ending → ended | scaleDown | DescribeInstances says dead; otherwise TerminateInstances and retry next tick | `:1525-1536` |

A launch's row is written only after RunInstances returns (`:1462-1465`): a lost answer or an object reset in between leaves an untracked instance that can never enroll and is never terminated (B6). STONITH's own termination (H5/H8) is not recorded in `launched`: the row stays enrolled with `ended_ms` NULL.

### 2.3 A tunnel

| Step | Trigger | Code |
|---|---|---|
| intent recorded, sweep armed | enroll of a `burst` host, before any Cloudflare call | `fleet.ts:399-400` |
| created (tunnel, ingress, record) | same; 401/403 → host enrolls without a tunnel; other failure → enrollment fails, tunnel deleted best effort | `:394-426` |
| deleted on refused consumption | enrollRecord throws | `:285-290` |
| deleted on death | every path to `dead` calls `releaseTunnel` (H2, H8/H9, H11, H12), fire-and-forget, nulls the ids on success | `:429-459` |
| swept | daily: retry dead rows' ids; then delete listed nest-named tunnels/records whose host is in `tunnels_created` and (`dead` or no row after 1 h); others counted as unknown | `:469-524` |

Served state: `tunnel_state` from hello and `tunnel_state` events; `hostGatewayUrl` hands out the hostname only while `connected` (`:1372-1382`).

### 2.4 A command

| From → to | Actor | Code |
|---|---|---|
| ∅ → issued | `issueCommands`: insert row (result NULL), `rel.push` with next seq, send if a helloed socket exists | `fleet.ts:1152-1173` |
| issued → sent | `sendResolved` resolves BrokerDO refs (only `agent_start`, `secrets_update`); on a BrokerDO failure it **returns without sending**, "resent after the next hello" | `:699-723` |
| sent → resent | hello: `rel.ack(last_command_seq)`, then `pendingAfter(last_command_seq)` | `:777-778` |
| delivered → executed | nestd forwards a batch iff `seq > last_command_seq ∧ seq > forwarded_command_seq` (**no `seq = last + 1` check**); executor runs batches in order; `CommandsDone(seq)` → flush results, then `ack{up_to: seq}` | `fleet.rs:393-401`, `host.rs:551-563`, `fleet.rs:336-341` |
| executed → acked | `rel.ack(up_to)` deletes every batch ≤ `up_to` | `fleet.ts:663-665`, `reliable.ts:37-39` |
| → result | `command_result` event; first result wins (`result IS NULL` guard) | `fleet.ts:1099-1105` |
| → failed (new nestd) | new `instance_id`: `rel.reset`, then fail retryably every unanswered command captured at `:789` (a `sandbox_create` the hello reports at its epoch completes ok) | `:753-755`, `:787-792`, `:1086-1097` |
| → failed (host dead) | **not on main**: a dead host's unanswered rows stay NULL for ever; `deferred/retention-enums` `fdf121d` answers them at death and L6 of `dede063` answers at once on issue to a dead host | — |

Purpose `stonith_fence`: an error re-issues the fence (`:1109-1111`); ok drives H7.

### 2.5 Drain

| Mode | Built | Rule |
|---|---|---|
| Forced (spot) | yes: nestd polls IMDS every 5 s and emits `spot_notice` once per process (`host.rs:1261-1277`); FleetDO H10 | A resident leaves when it reports `suspended` (`fleet.ts:1018`); nestd reports `suspended` only after its commit landed (`host.rs:1688-1707`). H12 when no lease is left; otherwise AWS kills the host and H5 → H8 reassigns with `host_dead`. |
| Gentle (consolidation, upgrades) | no | Docs only ([autoscaling](../../compute/autoscaling/)). |
| Drain gate ("terminate only when every resident's head is the host's last commit and the pending-upload list is empty, all or nothing") | **no** (no `isRestoreSource` or upload-list code anywhere) | H11/H12 terminate on lease state alone. The `drain` command exists in nestd (`host.rs:2012-2031`) but FleetDO never sends it. |

## 3. Messages, delivery, timing

| Message | Delivery | Code |
|---|---|---|
| `hello` / `hello_ack` | first frame; per-host `SerialQueue` with event batches | `fleet.ts:651`, `fleet.rs:243-298` |
| `heartbeat` / `heartbeat_ack{revoked}` | unreliable, every 5 s; updates `last_rx` only for `active`/`draining`/`stonith_pending` (not `expired`) | `fleet.ts:941-956` |
| `events{seq}` | reliable host → FleetDO; gap or failure closes the socket | `:962-983` |
| `commands{seq}` | reliable FleetDO → host, cumulative ack | §2.4 |
| `host_token`, `binding_key` | unreliable plain sends | `:1384-1391`, `:1341-1349` |

| Timer | Value | Code |
|---|---|---|
| heartbeat; tick period | 5 s | `control.ts:13`, `fleet.ts:1331` |
| host self-fence after last acked heartbeat was sent | 20 s | `control.ts:14`, `fleet.rs:373-380` |
| CP lease expiry (silence) | 30 s | `control.ts:15`, `fleet.ts:1308` |
| nestd liveness (no inbound) → reconnect; backoff | 12.5 s; 200 ms → 30 s | `fleet.rs:306`, `:158-184` |
| host token TTL; rotate when < 10 min left (hello, tick) | 1 h; 10 min | `fleet.ts:354`, `:112`, `:772`, `:1318` |
| expired token still opens the fleet channel | 24 h | `index.ts:19`, `:120` |
| idle grace; enroll timeout; max hosts | 600 s; 600 s; 1 | `cells.ts:22-26` |
| stale-incarnation salvage window | 11 min | `fleet.ts:118` |
| nestd enrollment wait | 60 s | [enrollment](../../interfaces/control-host/enrollment/) |

## 4. Safety properties

| Id | Predicate | Holds on main? |
|---|---|---|
| S1 | No transition out of `dead`. | **No** under one interleaving (B3). |
| S2 | A lease expired by H5 is dropped (reassigned) only after a successful `stonith_fence` covering it, or EC2-confirmed death, or an operator confirm. | Yes: reassignment sources are `:1120`, `:1841`, `:815` (unexpired only), `:863` (holder's own `fenced`, needs a live lease, `:986-990`). Relies on `isDead(null)` (B7). |
| S3 | `stonith_pending → active` only when no expired lease remains outside the fence just reported, and a socket exists. | Yes (`:1827-1830` rechecks all leases even though `ensureStonithFence` skips queued sandboxes). |
| S4 | scaleDown terminates a host only when every lease on it is `suspended` (idle) or none remain (drained), and it has no brain. | Yes as written; but `state` is FleetDO's last report, not what is in flight (B8), and dirty stale incarnations are ignored (B9). |
| S5 | A proof enrolls at most one host that ever said hello; a proof re-used by a never-connected host retires that host first (in the same synchronous step). | Yes (`:294-323`, `:353-358`). Note: the weaker "used once" from the docs is by design not true. |
| S6 | Cloudflare deletes target only (a) a dead host's recorded ids, (b) listed nest-named objects whose host is in `tunnels_created` and dead or rowless for ≥ 1 h, (c) a tunnel just created whose enrollment failed. | Yes. Depends on S1: a resurrected host (B3) keeps nulled tunnel ids. |
| S7 | Every command gets exactly one result, or a failure when its host dies or restarts. | **No**: lost commands (B1, B2), no answer on death (§2.4), fake failures for delivered commands (B10). "At most one result" holds (`:1104`). |
| S8 | Commands to a host execute in `seq` order, none skipped. | **No** (B1, B2); docs claim `seq = last + 1` on both channels, nestd does not check it for commands. |
| S9 | Drain terminates only after an all-or-nothing upload report. | Not built; current code: spot drain needs no gate (docs agree), H11/H12 have none. |
| S10 | `#pending launches ≤ 1` and `#burst hosts in {active, stonith_pending} ≤ max_hosts` at launch time. | Yes within one object instance (`launching` flag + pending row); untracked launches (B6) escape it. |

## 5. Liveness (with fairness)

Fairness assumed: the alarm fires; DO RPCs eventually succeed; EC2/Cloudflare calls eventually succeed; a connected nestd keeps heartbeating.

| Id | Property | Holds? |
|---|---|---|
| L1 | A cell with an unplaceable sandbox and `max_hosts` headroom eventually launches. | Yes, but placement retry is SandboxDO's alarm; a disconnected `active` host counts as headroom used for up to 600 s (B4). |
| L2 | An idle launched burst host is eventually terminated. | Yes (H11 + the `launched` retry loop). Token-enrolled hosts (no `instance_id`) never are. |
| L3 | Every launched instance is eventually enrolled or ended. | Yes for recorded launches (`enroll_timeout`); no for B6. An enrolled-but-never-connected host ends by H11. |
| L4 | A `stonith_pending` host eventually becomes `dead` or `active`. | With EC2 and an `instance_id`: yes (polled every tick). Without: only by reconnect + fence, or the operator. |
| L5 | Every sandbox with an expired lease is eventually reassigned. | Suspected no in one case: `reassign_queue` is keyed by `sandbox` alone and `INSERT OR IGNORE` (`:1849`); a second host's request for the same sandbox is dropped while an older row is retrying; if that second host then reaches `dead` (confirmHostDead runs once) nothing re-queues its expired lease and `place` refuses the sandbox for ever (`:1194-1196`). Needs a persistently failing `leaseLost`. |
| L6 | Every command is eventually answered. | No on main (S7). |
| L7 | A dead host's tunnel and record are eventually deleted. | Yes (sweep retries dead rows daily). |

## 6. Past bugs and the property that catches each

| Commit | Bug | Property | Model needs |
|---|---|---|---|
| `4f85ffd` (in `e76fe31`) | hello reset `stonith_pending`; a host that reconnected while being terminated and died before its fence result was never polled | S3, L4 | hello as an action separate from the fence result; host death between them |
| `4f85ffd` | STONITH fence left the sandbox `fenced` with no lease (FleetDO forwarded a non-holder's `fenced`) | S2 + lease authority | `sandbox_state` before `command_result` in one batch |
| `4f85ffd` | a tunnel host reporting `none` was handed out at its loopback URL | (gateway resolution, not lifecycle) | tunnel_state; trivial as a test |
| `1b83482` | a silent controller (no leases) was never expired | L4-like for controllers; the same gap remains for burst hosts (B4) | silent host with zero leases |
| `1b83482` | `Deadlines` swallowed a re-arm made while its handler ran | alarm liveness | the alarm as an action with re-arm inside the handler |
| `24b8613` | lost enrollment answer bricked the instance; a Cloudflare 401 burned instances through the enroll timeout | L3, S5 | a lost reply to enroll; a CF failure branch |
| `c8457e1` | restarted nestd's leases: old-epoch create raced the re-placement | S7/S2 | `instance_id` change |
| `fdf121d`, `dede063` (unmerged) | dead host's commands never answered; dead host's brains stranded; operator confirm did not terminate | S7, L6 | host death with commands in flight |
| docs watch item | host terminated outside FleetDO delayed replacement ~10 min | L1 | external termination; `max_hosts` = 1 |

## 7. Bugs found

| Id | Where | Interleaving / input | Property | Confidence |
|---|---|---|---|---|
| B1 | `fleet.ts:714` + `fleet.rs:393-401` | `issueCommands(h, [agent_start])`; BrokerDO `resolveRefs` throws → batch N not sent. Any later batch N+1 without refs (a `sandbox_create`, a fence) is sent; nestd forwards it (`N+1 > forwarded`), runs it, acks `up_to: N+1`; `rel.ack` deletes N. N is never sent and its row stays NULL. The same happens without a failure when batch N awaits `resolveRefs` and N+1 (no refs, no await) is sent first: N then arrives with `N ≤ forwarded` and is dropped as "still processing". | S7, S8 | **Real**, high. Repro: unit test with a BrokerDO stub that fails once, then a second `issueCommands`; assert batch N reaches the host. Mitigated for `agent_start` only by AgentDO's 2 min `starting` deadline. |
| B2 | `fleet.ts:762` vs `:778` | hello marks the socket `helloed` before resending pending batches, with awaits in between (`rotateToken`, `sendBindingKeys` → BrokerDO). A concurrent `issueCommands` sends batch M on the new socket first; the resend of older batches K < M then arrives with `K ≤ forwarded = M` and is dropped; M's ack deletes them. | S7, S8 | **Real**, medium-high (needs an unacked batch at reconnect plus a concurrent issue). Repro: slow `bindingPublicKeys`, issue during hello. Fix shape: nestd closes on a command gap, as the docs already say. |
| B3 | `fleet.ts:1751`, `:1774` | tick snapshots `active/draining` hosts (`:1307`), then awaits EC2 per host. An operator `confirm-dead` of a later host lands in that await; `processReassign` deletes its leases one per await, so the tick still sees an unexpired lease and `expireHost` writes `stonith_pending` unguarded (or `expireController` writes `expired`). The dead host is alive again: fetch admits it (`:624` refuses only `dead`), a fence success makes it `active`. | S1, S6 | Suspected, medium (narrow window; operator action). Confirm with a test that calls `confirmHostDead` from inside a stubbed `ec2.terminate`. |
| B4 | `fleet.ts:1443-1446`, `:1309` | A lease-less burst host terminated outside FleetDO stays `active` without a socket; scaleUp counts it toward `max_hosts` (1) until H11 after 600 s. Explains the docs watch item. | L1 | **Real**, high (matches the observed ~10 min). |
| B5 | `fleet.ts:1829` | A `draining` host silent ≥ 30 s goes to `stonith_pending`; a fence success returns it to `active`, so it takes placements again. With EC2 the instance is already being terminated; without EC2 it is a live host that will be reclaimed. | drain is absorbing | Real, low impact. |
| B6 | `fleet.ts:1458-1465` | RunInstances succeeds but the answer is lost (or the object resets) before the `launched` insert; the client token embeds `now`, so no retry reuses it. The instance can never enroll and nothing terminates it; nothing reconciles EC2 `nest=true` instances against `launched`. | L3, S10 | Real, low frequency, costs money. |
| B7 | `ec2.ts:45`, `:65`, `:117` | `state()` maps `InvalidInstanceID.NotFound` and any unparseable 200 to `null`, and `isDead(null)` is true. A cell whose region or credentials change while hosts run (per-cell AWS since `d0c328f`) would confirm every silent host dead without terminating it. The host's own 20 s self-fence is the remaining guard; a hung nestd with running VMMs is not covered. | S2 | Suspected (fail-open assumption), medium. Half fixed on refactor/fleet: an unparseable answer throws; NotFound is still `null` (a wrong account or region answers NotFound). |
| B8 | `fleet.ts:1499` | `wake` sends `sandbox_resume` to a host whose lease says `suspended`; if the tick runs H11 before the host's `running` event arrives (idle grace already elapsed), the host is retired, the lease evicted and the resumed VM's work since its last commit is lost. | S4 | Suspected, medium-low (narrow window). Fix shape: an unanswered command on a lease counts as busy. |
| B9 | `fleet.ts:1496-1523` | H11/H12 ignore `stale_incarnations` with `clean = 0`: a host whose fenced incarnation is still salvaging can be terminated before the salvage commit lands. | S9 | Suspected; salvage is best-effort by design, so this may be acceptable. |
| B10 | `fleet.ts:783` vs `:789` | On a new nestd, `reconcileSandboxes` (and any concurrent caller during its SandboxDO awaits) issues commands to the new process before `pending` is captured; they are then failed as "restarted before running this command" although delivered, and their real result is ignored. The reconcile `fence` and `reapStale`'s `sandbox_destroy` get a fake failure every time; today their failure handling is a no-op (`fence` has no `sandbox` column, `commandFailed` acts only on `sandbox_create`, `sandbox.ts:437`). A `sandbox_create` from a concurrent placement gets a fake retryable failure and SandboxDO re-issues it. | S7 | Real (deterministic for the reconcile commands, harmless today); the concurrent create case is suspected, low impact. The comment at `:788` states the opposite intent. |
| B11 | `fleet.ts:1389-1390`, `:772` | `rotateToken` stores the new `token_exp` before the unreliable `host_token` frame is delivered; if it is lost, hello does not re-rotate (DB expiry is not near), so the host runs on an expired token; the session channel accepts no grace (`index.ts:120`). | docs claim "fresh token right after hello" | Suspected, low. |

Doc/code disagreements: S8 (docs: gap closes the socket on both channels); the docs' "used only once" for identity proofs (code: once per connected host); FleetDO docs list "drains and the drain gate" as not built while autoscaling docs describe the forced drain as built (both true: forced drain without gate).

## 8. Modelling notes

**Abstraction.** Model one cell: hosts `{h1,h2}` (+1 launch), sandboxes `{s1,s2}`, commands as a per-host seq'd queue of ≤ 3 batches, one with refs. Essential: the await points of FleetDO handlers as interleaving points (B1-B3, B10 all need them); host death, nestd restart (new lineage), lost replies (enroll, RunInstances, DescribeInstances), external termination, a host that never connects, BrokerDO failure. EC2 as a state machine `pending → running → shutting-down → terminated` with `NotFound` either "gone" or "not yet visible" (eventual consistency) and terminate idempotent. Cloudflare: a set of (name, id) with failing deletes. Incidental: capacity packing, CA, binding keys, GC, tunnel served-state, wall-clock values (model 5/20/30 s as ordered ticks: host fences before CP expiry).

**Action-to-code.**

| Action | Code |
|---|---|
| `Enroll(proof)` split into `Check`, `CreateTunnel`, `Consume` | `fleet.ts:276-369` |
| `Hello(h, instance)` with await points after `:762` | `:729-797` |
| `Heartbeat(h)`, `Silence(h)` | `:941-956` |
| `Tick` = expire, poll STONITH, ensure fences, reassign, reap, scaleDown | `:1304-1332` |
| `Issue(h, batch, hasRefs)`, `Send`, `HostRecv`, `HostExec`, `HostAck` | `:1152-1173`, `fleet.rs:382-401`, `host.rs:551-563` |
| `FenceResult(h, ok)` | `:1099-1121` |
| `SpotNotice(h)`, `Suspended(h, s)` | `:1544-1554`, `:1018` |
| `ScaleUp`, `LaunchReplyLost` | `:1437-1480` |
| `Ec2Terminate(i)` external | — |
| `OperatorConfirmDead(h)` | `:1833-1842` |
| `Sweep` | `:469-524` |

**Worth a formal model (TLA+/P, small bounds):** command delivery (S7, S8, L6) and STONITH (S1-S3, L4, L5). Both are protocols with interleavings humans keep getting wrong; B1, B2 and B10 would fall out in seconds. **Property-based tests are enough for:** autoscaling counts (S10, L1-L3), tunnel bookkeeping (S6, L7) and enrollment (S5), which are mostly plumbing over SQL with one decision each.

**Runtime assertions or tests now.**
- nestd: refuse (close and reconnect) a `commands` batch with `seq ≠ last + 1`; FleetDO: never send a later batch while an earlier one for the same host is unsent (B1, B2).
- Guard every status write with its expected prior status (`WHERE status IN (...)`), and assert no write leaves `dead` (B3).
- A test: an unanswered `commands` row on a `dead` host is a failure (S7); merge the retention branch's fix.
- A test: `place` with a disconnected `active` host at `max_hosts` launches within one tick (B4); count only hosts with a socket or a recent `last_rx`.
- `isDead`: treat `NotFound` as dead only for an instance older than a few minutes and seen running before (B7).
- scaleDown: busy if any unanswered command names a lease on the host (B8).

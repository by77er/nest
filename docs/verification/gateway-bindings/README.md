# Gateway bindings and the hands path: verification inventory

> **Study, not a decision.** Code on `main` (edf6829); every claim cites `file:line`. Contracts: [gateway](../../interfaces/gateway/), [nestd-gateway](../../interfaces/host-internal/nestd-gateway/), [host-guest](../../interfaces/host-guest/); design: [sandbox gateway](../../sandbox/gateway/), [hands](../../agents/hands/), [SandboxDO attach and bindings](../../control-plane/durable-objects/sandbox/#attach-and-bindings). Channel delivery underneath: [reliable-channels](../reliable-channels/).

> **Since:** not re-checked after `edf6829`. #30 changed the hands path: the agent epoch fences the brain, `hands_resolved` is a tagged union, and the hands client takes sandbox and epoch from the binding's claims.

## Scope and actors

A hands call travels runner → (AgentDO `resolve`) → gateway → guest. Bindings are verified, never stored; revocation is the gateway's attached-client set and the sandbox epoch.

| Actor | State | Code |
|---|---|---|
| SandboxDO | `epoch`, `host`, `state`, `placing`, `attached[]`, `attach_pending[]`, `attach_inflight{agent→cmd}`, `attach_attempts`, `guest?` | `control-plane/src/do/sandbox.ts:49-70` |
| BrokerDO | `binding_key:<cell>` = one `{kid, public_key, private_jwk}`, made on first use | `control-plane/src/do/broker.ts:93-142` |
| FleetDO | `keysSent` (memory), host `gateway_url`, tunnel row and state | `control-plane/src/do/fleet.ts:1339-1349,1372-1395` |
| Binding | `nbd_<claims>.<sig>`, claims `{v, kid, sandbox, epoch, client, scope, exp_ms}`, ECDSA P-256, lifetime 1 h | `control-plane/src/lib/binding.ts:41-50`, `control-plane/src/protocol/gateway.ts:13` |
| nestd | per sandbox `Sbx{epoch, slots, guest_info, vm}` behind an async mutex; `summary{epoch, state}`; gateway mirror `{keys, sandboxes: id→{epoch, vsock, clients, guest}, conn}`; `Tombstones: id→max fenced epoch` | `crates/nestd/src/gateway_link.rs:55-73`, `crates/nestd/src/tombstones.rs:17-55` |
| gateway | `keys: kid→point`; `sandboxes: id→{epoch, vsock, clients, guest, generation}`; `resyncing`; `conns: id→{sandbox, epoch, close}` | `crates/nest-gateway/src/state.rs:11-50` |
| guest | `identity{sandbox, epoch}?`, `agents` (slots), `frozen` | `crates/nest-guest/src/hands/mod.rs:116-131`, `crates/nest-guest/src/control.rs:57-77` |
| runner | cached target `{url, sandbox, epoch, binding, guest, edge?}` + generation; per-call `Retries{re_resolved, busy_since}` | `crates/nest-runner/src/hands.rs:91-200` |

## Transitions

**Control plane.**

| # | Transition | Actor | Guard | Effect | Code |
|---|---|---|---|---|---|
| P1 | attach(a) | SandboxDO | not already confirmed with this cwd | `attached += a`; if placed `pending += a`; issue `agent_attach`; `inflight[a] := cmd` (if same host and epoch) | `sandbox.ts:720-733,757-767` |
| P2 | attachResult ok | SandboxDO | host, epoch match; `a` attached; `inflight[a] = cmd` | `pending -= a` | `sandbox.ts:803-813` |
| P3 | attachResult error | SandboxDO | same | retryable: backoff 2–30 s; else wait for next `running` | `sandbox.ts:814-828` |
| P4 | new placement | SandboxDO | — | `pending := attached`, `inflight := {}`; reissue all | `sandbox.ts:770-786` |
| P5 | detach(a) | SandboxDO | — | remove `a` everywhere; issue `agent_detach{kill_processes}` | `sandbox.ts:736-749` |
| P6 | resolve(a) | SandboxDO | attached; not destroyed/archived; placed, not placing; `running`; `a ∉ pending`; gateway URL; tunnel connected; guest known | mint `{sandbox, epoch, client: a, hands, now+1h}`; after the awaits re-check attached, epoch, host, pending, guest | `sandbox.ts:835-882` |
| P7 | hands_resolve | AgentDO | socket is the current runner and epoch (checked **before** the await only) | answer `hands_resolved` | `agent.ts:651-658,568-579` |
| K1 | keys | BrokerDO → FleetDO → nestd → gateway | hello, or a heartbeat while `keysSent` lacks the host | `binding_key{keys}` (one key); nestd mirrors and sends `key_update`, which replaces the set | `broker.ts:124-127`, `fleet.ts:773-774,951-954,1341-1349`, `crates/nestd/src/fleet.rs:415-417`, `gateway_link.rs:138-141` |

**Sandbox host.**

| # | Transition | Actor | Guard | Effect | Code |
|---|---|---|---|---|---|
| N1 | agent_attach | nestd executor | epoch current, not fenced | slot insert; `gateway_sync` (upsert only if `summary` says running at this epoch); guest attach outside the lock; on failure or fence drop the slot | `crates/nestd/src/host.rs:1926-1975,697-713` |
| N2 | agent_detach | nestd | — | slot remove; `gateway_sync`; guest detach (kill cgroup) | `host.rs:1989-2010` |
| N3 | into running | nestd | create, resume | `gateway_upsert` before reporting `running` | `host.rs:1460,1735,1760` |
| N4 | suspend | nestd | — | `gateway.forget` (no tombstone) | `host.rs:1706` |
| N5 | fence | nestd (no sandbox lock) | `summary.epoch = e`, not fenced | `summary := Fenced`; `tombstones.fence(e)`; proxy drop; `gateway.forget` | `host.rs:1110-1134` |
| N6 | guest ready | nestd | incarnation not fenced | `guest_info`; `gateway_sync` | `host.rs:966-978` |
| M1 | mirror upsert | gateway link | epoch not tombstoned; entry changed | insert under the mirror lock, **release**, then send under a second lock | `gateway_link.rs:146-159` |
| M2 | mirror forget | gateway link | entry present | remove; send `sandbox_remove` | `gateway_link.rs:165-170` |
| M3 | (re)connect | gateway link | one gateway at a time | under the lock: `hello_ack`, `key_update`, every upsert, `resync_done` | `gateway_link.rs:192-210` |
| G1 | upsert | gateway | `epoch ≥ held` (else refuse, log) | replace; a changed epoch cuts the old epoch's conns (4409) | `crates/nest-gateway/src/state.rs:134-158` |
| G2 | remove / link loss | gateway | — | forget sandbox (all, on loss); cut conns (4409); keys kept | `state.rs:161-175`, `crates/nest-gateway/src/link.rs:38` |
| G3 | resync | gateway | `hello_ack` … `resync_done` | unknown sandbox → `busy`; at end drop entries not re-sent | `state.rs:179-196` |
| G4 | bind | gateway | version → shape → kid listed → signature → `exp_ms > now`, scope → sandbox known → `claims.epoch` = held (older `stale_epoch`, newer `busy`) → client ∈ clients → guest known → guest version | `Accepted` or one refusal, `executed: false` | `crates/nest-gateway/src/verify.rs:60-118` |
| G5 | register | gateway | held epoch still `claims.epoch` (re-checked under the write lock; clients are not) | conn registered | `state.rs:213-223`, `server.rs:100` |
| G6 | first frame | gateway | `agent_id`, `epoch`, `protocol_version`, where present, equal the binding's | forward; else close 4401 | `verify.rs:126-143`, `server.rs:162-175` |
| Q1 | configure | guest | `epoch ≥ identity.epoch` | set identity; else `stale_epoch` | `control.rs:57-77` |
| Q2 | validate | guest | version; identity set (else `busy`); not frozen (else `busy`); `req.epoch = identity.epoch`; agent attached | run the tool; hangup or `cancel` cancels | `hands/mod.rs:41-111,116-131` |

**Client (runner).** `ensure_target` (cached until 60 s before `exp_ms`: `crates/nest-hands-client/src/lib.rs:166-176`) → `open` → on refusal `Next::{RetrySame (busy, ≤30 s), Resolve (stale_epoch, moved, unknown_key, unauthorized, unsupported_version; once per call), Final}` (`lib.rs:129-161,286-301`; `hands.rs:158-200`) → send `HandsRequest` (**point of no return**) → `exchange`: result, guest error (`busy` → retry in the same budget; others final), close 4409 or EOF → `outcome_unknown` (`hands.rs:104-128,202-258`).

## Delivery and timing assumptions

- `agent_attach`/`agent_detach` ride the fleet command channel ([reliable-channels](../reliable-channels/)); their effect at the gateway follows command processing, the nestd→gateway socket (FIFO, one writer: `gateway_link.rs:216-232`) and any resync.
- The gateway trusts nestd fully; nestd trusts FleetDO for keys. Cloudflare Access gates the edge (out of scope).
- `exp_ms` is minted on the Worker's clock (`sandbox.ts:866`) and checked on the gateway's (`verify.rs:88`): skew shifts expiry (bound unverified).
- A host whose lease lapses self-fences in 20 s and removes every sandbox from the gateway ([fleet](../../interfaces/control-host/fleet/#lease-and-fence)).

## Safety properties

| Id | Predicate | Holds on main? |
|---|---|---|
| S1 admission | a `HandsRequest` runs in the guest only if: at bind, the token verifies under a listed key, `exp_ms > now_gw`, scope `hands`, `claims.epoch = gw.epoch(sandbox)`, `client ∈ gw.clients(sandbox)`, guest known with equal version; at register, `gw.epoch` unchanged; first frame `epoch = claims.epoch`, `agent_id = client`; at the guest, `req.epoch = identity.epoch`, agent attached, not frozen | yes (G4–G6, Q2). Client membership is not re-checked at register (G5): a detach between check and register admits one call, which the detach's cgroup kill ends |
| S2 epoch monotonic | between removes, `gw.epoch(s)` never decreases; `guest.identity.epoch` never decreases; nestd never sends an upsert at or below a tombstone | gateway: yes (`state.rs:146-151`); guest: yes (`control.rs:60`); nestd: **no** under B1 |
| S3 fenced stays out | after `fence(s, e)` on a host, the gateway never again holds `(s, e' ≤ e)` | **no** under B1 |
| S4 no retry past the point of no return | a `HandsRequest` for a call id is resent only after a pre-`bound` refusal or a guest `busy` | yes by inspection: the guest's `busy` comes only from `validate` (`hands/mod.rs:121-124`), before `run_tool`. Not structural: no `executed` flag on guest errors, no duplicate-call check. Send failure: B2 (fixed) |
| S5 crash outcome from guest records | after a runner crash, the outcome of an in-flight call comes from the guest's call record (`call_status`) | **not built**: no records, `call_status` or `duplicate_call` in `crates/nest-guest/src/hands/`; `docs/agents/hands/README.md:33` says so, while `docs/README.md:144` lists it as settled |
| S6 detach voids | once nestd has processed `agent_detach(a)` and the gateway applied its upsert, no new call by `a` is admitted, and `a`'s running processes are killed | yes (N2, G4 client check, Q2 `unknown_agent`). Before that, a binding minted earlier stays admissible until `exp_ms` (≤ 1 h): the end-to-end bound is command delivery, which the reliable-channel bug B1 can make unbounded |
| S7 mint only current | `resolve` returns a binding only for an attached, confirmed client of a `running` sandbox at the epoch current after its awaits | yes (`sandbox.ts:871-880`) |
| S8 keys | only bindings under a `kid` in the gateway's set verify; a `key_update` replaces the set | yes (`state.rs:106-108`, `verify.rs:82-87`). Rotation and validity windows are **not built** (one key per cell, `broker.ts:124-127`); a leaked binding is revoked only by detach or an epoch bump |
| S9 link loss fences | the gateway losing nestd cuts every conn and answers `moved` until a full replay | yes (`state.rs:170-175`, `link.rs:38`) |
| S10 one acting brain | at most one runner process of an agent holds a usable binding | **not a property of main**: two processes of one agent get identical `(sandbox, epoch, client)` claims. Branch `deferred/agent-epoch`: ce5c472 added an `agent_epoch` claim and per-client gateway floors, 0c3a85c confirmed floors before minting, 65bf6ef removed both for an AgentDO "one brain per agent" rule |

## Liveness (fairness: AgentDO answers `hands_resolve`; commands and upserts are delivered)

| Id | Property | Holds on main? |
|---|---|---|
| L1 | sandbox `running` at `e` on `h`, client confirmed, gateway linked with keys, tunnel connected ⇒ a call is admitted after at most one re-resolve plus `busy` waits (≤ 30 s), per call | yes (`hands.rs:158-200`); a call that runs out returns an error and the next call starts afresh |
| L2 | an attach is eventually confirmed while the sandbox stays placed | retryable errors retry (P3); **a lost `agent_attach` never resolves**: `inflight` stays set and `reissuePendingAttaches` skips it (`sandbox.ts:794`) until a new placement or attach |
| L3 | a host eventually holds the cell's keys | yes: resent on heartbeat while `keysSent` lacks it (`fleet.ts:951-954`) |
| L4 | a detach eventually takes effect at the gateway | only if `agent_detach` is delivered (see S6) |

## Past bugs and the property that catches each

| Commit | Bug | Property |
|---|---|---|
| b5cb0d0 (in #25) | a late upsert at an older epoch cut current calls and re-admitted old bindings | S2 |
| b5cb0d0 | refusal handling differed per path; expired bindings paid a refused bind hourly | L1 |
| 6d1586f (#25) | attach, detach or a guest hello while suspended re-added a paused sandbox to the gateway | S1, S3 |
| 6d1586f | a create retried at the same epoch was refused egress (tombstone on teardown) | L1 |
| a9d3ce0 (#27) | tombstones kept twice and never pruned; a create at a tombstoned epoch failed as a retryable internal | S3, L1 |
| edf6829 (#27) | a superseded epoch's late fence could take the newer epoch's pause handle | S2 (per incarnation) |
| e76fe31 (#25) | `resolve` invented a guest version | S1 (version check) |
| e76fe31 | a launch prompt could pull `binding_key:` out of BrokerDO into a command | S8 (key confidentiality) |
| ce5c472 (branch) | a brain moved hosts while its sandbox stayed; the old one kept acting with an hour-long binding | S10 |

## Bugs found

**B1 — a fenced epoch re-added to the gateway as a ghost (real from code; low likelihood).** `upsert` checks the tombstone and inserts under the mirror lock, releases it, then sends under a second acquisition (`gateway_link.rs:147-158`); the fence path runs without the sandbox lock (`host.rs:1110-1134`). Interleaving: `gateway_sync` passes its running check (`host.rs:698`) and M1's tombstone check, inserts, releases; N5 tombstones, `forget` removes the entry and sends `sandbox_remove`; M1 then sends its `sandbox_upsert`. The gateway re-adds `(s, e)` after the remove; nestd's mirror lacks it, so a later destroy's `forget` returns early (`gateway_link.rs:166`) and sends nothing. The ghost lasts until a gateway reconnect or a newer epoch. Breaks S2 (nestd clause) and S3; the guest-side epoch check and the stopped VM still prevent execution. Confirm with shuttle (two tasks: `upsert` vs `fence`), asserting the gateway's final table equals the mirror.

**B2 — a failed request send reported as a plain error (confirmed, fixed).** `conn.send_json(&req)` failing returned `"hands request failed"`, not `outcome_unknown`; a WebSocket send can fail after part of the frame left, so the guest may run a call the model was told failed. Now only a request refused before any byte left (`InvalidInput`: it does not fit a frame) is a plain error; any other send failure is `outcome_unknown` (`hands.rs` `call_with`). Test: `a_request_send_that_fails_part_way_is_an_unknown_outcome` (a gateway that binds, reads nothing and resets while the client writes a 15 MiB request).

**B3 — detach then attach reordered (suspected; low).** P5 and P1 each send their command after an await (`sandbox.ts:745-747`, `sandbox.ts:731`); if `agent_attach` reaches the host before `agent_detach`, SandboxDO records the slot confirmed while the host has removed it. Every `resolve` then mints a binding the gateway refuses as `unauthorized`, each call fails after one re-resolve, until the next placement. Whether two RPCs from one DO to another keep their order is unverified.

**B4 — no re-check after resolving (low).** AgentDO checks the runner is current before `await resolve` and not after (`agent.ts:651-658`); a superseded socket is closed, so the send usually fails. Branch 0c3a85c (L2) adds the re-check.

**Docs vs code.** `docs/README.md:144` (settled) states journaling, `executed: false`, duplicate refusal and crash lookup; none is built (S5). The fleet doc says the gateway refuses a detached client's bindings (`docs/interfaces/control-host/fleet/README.md:61`): true only once the command lands.

## Modelling notes

- **Abstraction.** One sandbox; epochs 1..3; one or two clients; hosts A and B. Actors: SandboxDO (P1–P6), host = nestd mirror + tombstones (N1–N6, M1–M3) with the mirror lock split into insert and send steps, the nestd→gateway FIFO, gateway (G1–G6), guest (Q1–Q2), client (resolve, bind, send, outcome). Bindings are tuples `(sandbox, epoch, client, exp)`; signatures are abstracted to "minted by SandboxDO under a listed kid". Time is a tick counter for `exp`.
- **Invariants to check.** S1, S2, S3, S6 (as "no call by `a` after the detach's upsert is applied"), S10 (expected to fail on main, as a regression target for the branch).
- **Tools.** Cross-process protocol: Stateright (or Quint) over the abstraction above. In-process: **shuttle** for `GatewayLink` (`upsert`/`forget`/`serve` replay, B1) and the gateway's `State` (`upsert_sandbox`/`register_conn`/`clear`); **loom** fits the std `RwLock`/`Mutex` code but not tokio. **proptest**: `check_bind` precedence against the error-code table in the [contract](../../interfaces/gateway/#error-codes), and Rust/TS binding parse/verify differential beyond `protocol/fixtures/gateway/binding_token/signed.json`. **fast-check** with `fc.scheduler()` for SandboxDO attach/detach/resolve interleavings.

| Model action | Code |
|---|---|
| mint | `sandbox.ts:835-882`, `broker.ts:130-142` |
| attach / detach | `sandbox.ts:720-749`, `host.rs:1926-2010` |
| mirror upsert / forget / replay | `gateway_link.rs:146-210` |
| fence / suspend | `host.rs:1110-1134,1706` |
| gateway upsert / remove / clear / bind / register | `state.rs:134-223`, `verify.rs:60-118` |
| guest configure / validate | `control.rs:57-77`, `hands/mod.rs:116-131` |
| client retry policy | `nest-hands-client/src/lib.rs:129-161,286-301`, `hands.rs:91-258` |

## Runtime assertions and tests to add now

- nestd: send mirror deltas under the same lock as the mirror change (or tag them with a seq, as the proxy link does) and test `upsert` racing `fence`: the gateway must end without the fenced epoch (B1).
- Gateway: re-check `client ∈ clients` in `register_conn` alongside the epoch.
- Guest: make pre-execution refusals a distinct type that `run_tool` cannot return, so "`busy` only before the point of no return" is enforced by the compiler (S4).
- SandboxDO: a test that detach then attach leaves the host with the slot (B3); log when the gateway's `unauthorized` follows a fresh mint (needs the runner to report it).
- e2e: after `detach`, a call with the previously minted binding is refused within command latency (S6).

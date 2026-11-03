# Verification

How nest's state machines and protocols are formally checked, which ones are worth it, and what the checks found. The subject is the platform design: it doesn't depend on how this repo is built.

**Direction** (owner's decision, 2026-10-26): verification checks the code that ships, not a parallel model. Each protocol's decision logic is a pure sans-IO core, `step(state, input) -> effects`, behind a thin I/O shell that makes no decisions. The real cores are model checked within stated bounds, proved with Kani, mutation-tested, and their trust-boundary parsers fuzzed, all in CI. Hand-written models (TLA+, or Quint) stay for design exploration; such a model says something about the code only through a conformance review. nestd is first ([nestd/](nestd/)). The control plane's decisions are pure functions since #62 (`lib/sandbox-lease.ts`, `host-lifecycle.ts`, `brain.ts`, `turns.ts`, `slots.ts`, `retention.ts`), tested by tables and seeded random walks in vitest; nothing composes them with models of their peers yet (open, below).

**Status:**
- **The study** (PR #29, 2026-10-25/26): the inventories below, the [methods](methods/) survey and four pilots. A dated record: its `file:line` citations are at `main` `edf6829`, plus the brain-lifecycle branches named in each doc.
- **The one-brain rule** (#30): its TLA+ model and conformance passes gated the merge (#31, #38). Results: [agent-brain/pilot/](agent-brain/pilot/); conformance: [agent-brain/conformance/](agent-brain/conformance/).
- **nestd phase 1** (#39): `crates/nestd-core` holds the fleet link, command dedup, the lease decision, the incarnation decisions and the unchanged-disk memo, checked by Stateright, Kani, cargo-fuzz and cargo-mutants in CI. It found and fixed the lost-command bug below. See [nestd/](nestd/).
- **In CI:** the nestd checks only ([dev/ci.md](../../dev/ci.md#verification)). The TLA+, Lean and command-delivery Stateright pilots run by hand with `verification/run.sh`; wiring them is proposed in [dev/verification.md](../../dev/verification.md).
- **Next:** [roadmap/](roadmap/).

## Recommendation

For design exploration and code with no pure core yet: TLA+ with TLC for protocol models; Lean 4 for unbounded proofs of data invariants once TLC has found them; Stateright and Kani over real Rust cores; shuttle for tokio shells; fast-check for Durable Object await interleavings; conformance tables until model-based tests exist. Reasons, and the survey behind them: [methods](methods/#decision). Which language the Durable Objects' models use is open (below).

## Inventory

Each row is a machine or protocol worth modelling. Its doc (a study record, cited at `edf6829`) lists states, transitions with `file:line`, delivery and timing assumptions, properties, past bugs and modelling notes.

| Machine | Actors | Key safety | Key liveness | Doc | Model |
|---|---|---|---|---|---|
| Sandbox lease, placement, fencing, STONITH, salvage | SandboxDO, FleetDO, nestd, EC2 | One committer (head moves only from `(host, epoch)`); no double run; no leased epoch reused; reassignment after STONITH; salvage never dropped; `destroyed` final | A lost sandbox is placed again; markers clear; queues drain | [sandbox-lease/](sandbox-lease/) | TLA+ pilot |
| Brain lifecycle, one brain per agent | AgentDO, FleetDO, nestd, runner, gateway | At most one brain can act (on AgentDO or through a binding); no epoch regression; no start at or below a kill | A queued turn runs or fails; no agent or healthy host wedges | [agent-brain/](agent-brain/) | TLA+ pilot, conformance check |
| Host lifecycle, autoscaling, command delivery | FleetDO, nestd, EC2, Cloudflare | Dead is final; terminate only when empty; every command gets exactly one result | Capacity eventually arrives; STONITH resolves | [hosts/](hosts/) | none yet |
| Reliable channels | FleetDO, AgentDO, nestd, runner | In-order exactly-once processing per lineage; ack only after effects | Every event processed given connectivity | [reliable-channels/](reliable-channels/) | Stateright pilot (commands); the fleet link over nestd's real core ([nestd/](nestd/)) |
| Gateway bindings and the hands path | SandboxDO, nestd, gateway, guest, hands client | A call runs only under a binding at the guest's current epoch; no epoch regression; detach voids | A refused call re-resolves and succeeds | [gateway-bindings/](gateway-bindings/) | none yet |
| Commit chain and object-store GC | SandboxDO, FleetDO, nestd, S3 | No object reachable from a live or pending generation is deleted; the chain is a tree; commits are idempotent | Garbage is collected | [commit-gc/](commit-gc/) | Lean pilot, with retention |
| nestd incarnations, tombstones, restart recovery | nestd, FleetDO | A dirty incarnation's work ends as a head, an orphan or a recorded loss; fenced is terminal; tombstones pruned only when safe | Every stale incarnation is reaped | [nestd-incarnations/](nestd-incarnations/) | decisions proved with Kani; the machine is phase 2 of [nestd/](nestd/) |

## Pilots

| Pilot | Tool | Checked | Result |
|---|---|---|---|
| [Sandbox lease](sandbox-lease/pilot/) | TLA+/TLC | main's placement, lease, fencing, STONITH, salvage and commit | Seven real defects (below); vitest against the real DOs reproduces B1 and B2. With the modelled fixes on, every safety invariant holds exhaustively at 2 hosts, 2 epochs, no commits and one disconnect; larger fixed runs are partial. Mutations show each invariant can fail |
| [Brain lifecycle](agent-brain/pilot/) | TLA+/TLC | 65bf6ef, the single-record design and its amendments, the record as built | Reproduced the four review findings on 65bf6ef; found six holes in the new design, each adopted as an amendment or fix; reproduced N1 with zero faults. The design as built holds exhaustively at 2 hosts and epochs ≤ 2 for each single fault and for a previous-release host; drain and epochs ≤ 3 are depth-bounded (epochs ≤ 3 found C6 in a variant without the host-loss guards the code has). Liveness is only partly explored |
| [Brain conformance](agent-brain/conformance/) | review | the brain-record branch at five heads, then later merges, action by action | D1 to D13, then N1 to N25, each fixed by the next head except the lows listed. S conforms for an all-new fleet and in the mixed-version window; L conforms for an all-new fleet (N25 is handled by the rollout rule in [dev/deploy.md](../../dev/deploy.md)) |
| [Commit chain and GC](commit-gc/pilot/) | Lean 4 | `SandboxDO.commit` guard for guard; GC mark and sweep with reuse and grace; retention | Chain shape, orphan never head, CAS-only head moves and idempotence proved for every reachable state; GC and retention safety proved under assumption A1; B1 checked as a 6-step counterexample. No `sorry` |
| [Command delivery](reliable-channels/pilot/) | Stateright | FleetDO → nestd commands at `edf6829` | Reproduced the lost acked command in 8 steps with no fault; both fix shapes hold. Superseded by the check over nestd's real core ([nestd/](nestd/)) |

## Real bugs found

Found on `main` (`edf6829`) unless marked; "Where" cites that commit. "Confirmed" means a checker trace, a test run, or a reading of the code; reproduction sketches are in the owning doc. "Now" is by reading the code on `main` (2026-11-02). #62 also fixed sandbox-lease B3 (a fenced sandbox never re-placed by its alarm) and B7 (a stale placement answer's follow-ups).

| Bug | Where (`edf6829`) | Consequence | Found by | Now | Doc |
|---|---|---|---|---|---|
| Fleet commands lost. A later batch can be sent before an earlier one that awaits BrokerDO or hello's resend; nestd has no gap check, so the cumulative ack deletes the earlier batch | `fleet.ts:699-723`, `:762-778`, `:1169-1171`; `fleet.rs:394-404` | An `agent_start`, `agent_attach`, `agent_detach`, `fence` or `sandbox_destroy` is never run or answered | two inventories; Stateright (8 steps) | **Fixed** (#39): one per-host send chain in seq order; nestd accepts commands only in order from `hello_ack.next_command_seq` and reconnects on a gap. Checked over the real core | [nestd/](nestd/), [reliable-channels/pilot/](reliable-channels/pilot/) |
| A dirty incarnation's work is deleted: retire resends an unanswered commit, and its `stale_epoch` refusal ends retire before the salvage is prepared | `host.rs:2052-2058`, `:1193` | Uncommitted work lost after a nestd restart or a timed-out commit | inventory; TLC (MCBB1) | **Fixed** (#62): `nestd_core::incarnation::reask_failure_ends_commit` | [nestd-incarnations/](nestd-incarnations/) |
| Salvage refused after a no-capacity rollback: leaseLost finds no host and rolls the epoch back to the lost one, so the old holder's salvage hits the stale branch | `sandbox.ts:312`, `:575`, `:585` | Uncommitted work lost, contradicting "no agent work is silently lost" | inventory; TLC (18 steps, no faults); vitest | Open: needs the owner's decision (below) | [sandbox-lease/](sandbox-lease/) |
| Destroy during a placement resurrects the sandbox | `sandbox.ts:304-319`, `:507-519` | A destroyed sandbox comes back, maybe running; its generations become GC roots again | inventory; TLC (7 steps); vitest | **Fixed** (#62): `destroy` clears `placing` and tells FleetDO first; a late answer releases its lease and destroys the VM (`SandboxDO.discardPlacement`) | [sandbox-lease/](sandbox-lease/) |
| Double run after a lapse: a `sandbox_create` executed after the host's lease lapsed runs unfenced, and STONITH counts `shutting-down` as dead | `host.rs:1066-1072`, `:1404-1490`; `ec2.ts:45` | Two VMs of one sandbox until the instance stops; commits stay safe | TLC | **Control-plane half fixed** (#63): STONITH waits for `terminated`. nestd still runs a create executed after the lapse (#30's lapse guard covers `agent_start` only) | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| Stuck sandboxes: a late placement answer adopts a lost host (L1); a reassignment is dropped by `INSERT OR IGNORE` (L2) | `sandbox.ts:466-473`; `fleet.ts:1849-1850` | The sandbox never runs again without an operator | TLC (L1, L2) | L1 open; L2 **fixed** (#62: `reassignments` keyed by sandbox, host and epoch) | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| A resent commit has no age bound against the GC grace | `host.rs:2052`; `sandbox.ts:552`; `gc.rs:97` | A generation can name deleted chunks; every later GC pass then fails closed | inventory; Lean counterexample | Open | [commit-gc/](commit-gc/) |
| A host terminated outside FleetDO counts toward `max_hosts` until idle retirement | `fleet.ts:1443-1446` | The ~10 min wait for a replacement | inventory | **Fixed** (#30, by reading; not re-run on AWS): the tick expires any silent host (`expireSilent`) | [hosts/](hosts/) |
| Brain record (branch): six design holes, then 38 divergences across five heads (D1-D13, N1-N25) | `deferred/brain-record` | Two brains acting, or a wedged agent or healthy host | TLC; conformance | Merged as #30, each adopted or fixed except the lows; N25 handled by the rollout rule in [dev/deploy.md](../../dev/deploy.md) | [agent-brain/conformance/](agent-brain/conformance/) |

The inventories list more suspected bugs, each with what would confirm it.

**Docs and code disagree** on these points; each needs an owner decision or code, not just an edit:
1. "An epoch is never retried" vs. the no-capacity rollback in `placeAnswered` (`lib/sandbox-lease.ts`).
2. Hands-call journaling is a settled decision ([hands](../agents/hands/)) but isn't built: the guest keeps no call records and nothing answers `call_status`. Only the gateway's refusal before `bound` carries `executed: false`.
3. "A gap closes the socket" holds for FleetDO's receivers and nestd's command receiver (#39), not for the runner's session receiver, which drops duplicates but accepts a higher seq.

## What the methods would and wouldn't have caught

- **Caught in these pilots:** split brain across moves, stale epochs accepted, retries that stop, pruning of needed data, and reordered delivery. Each needed the model to split DO handlers at every `await` and to include resets and lost replies.
- **Not caught by any model:** a fake collaborator hiding a binding error (lesson 8) and a guessed wire encoding (lesson 5).
- **The models are hand translations:** a model that is wrong about the code proves nothing about it. The brain conformance check found transitions the model lacked (a start's error result, an expiry split by an `await`); both broke S.
- [methods/](methods/#past-bug-classes) maps each past bug class to the tools that catch it.

## Layout

Specs live in [`verification/`](../../verification/README.md) at the repo root, because they need builds and pinned tools; its README lists each directory. The cores are in `crates/nestd-core`. Each pilot's report sits next to the inventory it checks.

## Open questions

- **The Durable Objects' checks:** the control plane's decisions are pure functions, but nothing composes them with models of their peers. The [direction](#verification) names a TypeScript explorer (Rust cores via WASM where a protocol spans both sides); neither it nor how it models DO interleavings is designed. Until then, which language the design models use is open too: TLA+, as the pilots did, or Quint, as the survey picked for model-based tests. See [roadmap/](roadmap/).
- **Spec ownership:** a PR that changes a modelled handler should update the spec or its conformance table. Should a guard enforce that? See [roadmap/](roadmap/#open-questions).
- **The epoch rollback:** keep it (and authorize salvage at the current epoch while unplaced) or spend an epoch per attempt? See [sandbox-lease/](sandbox-lease/).

## Contents

| Directory | What |
|---|---|
| [methods/](methods/) | Tool survey, conformance approaches, costs, bug classes |
| [sandbox-lease/](sandbox-lease/) | Inventory; [pilot/](sandbox-lease/pilot/) |
| [agent-brain/](agent-brain/) | Inventory; [design/](agent-brain/design/); [pilot/](agent-brain/pilot/); [conformance/](agent-brain/conformance/) |
| [hosts/](hosts/) | Inventory |
| [reliable-channels/](reliable-channels/) | Inventory; [pilot/](reliable-channels/pilot/) |
| [gateway-bindings/](gateway-bindings/) | Inventory |
| [commit-gc/](commit-gc/) | Inventory and retention; [pilot/](commit-gc/pilot/) |
| [nestd-incarnations/](nestd-incarnations/) | Inventory; the decisions are in `nestd_core::incarnation` |
| [nestd/](nestd/) | nestd's pure cores checked as shipped; phase 2 design |
| [roadmap/](roadmap/) | What is next: open findings, models, assertions, CI |

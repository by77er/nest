# Verification

How nest's state machines and protocols are formally checked, which ones are worth it, and what the checks found. The subject is the platform design: it doesn't depend on how this repo is built.

**Direction** (owner's decision, 2026-10-26): verification checks the code that ships, not a parallel model. Each protocol's decision logic is a pure sans-IO core, `step(state, input) -> effects`, behind a thin I/O shell that makes no decisions. The real cores are model checked within stated bounds, proved with Kani, mutation-tested, and their trust-boundary parsers fuzzed, all in CI. Hand-written models (TLA+, or Quint) stay for design exploration; such a model says something about the code only through a conformance review. nestd is first ([nestd/](nestd/)); the control plane's cores are to be checked by a TypeScript explorer, with Rust cores compiled to WASM for protocols that span both sides (not designed yet).

**Status (2026-10-29):**
- **Done:**
  - **The study** (2026-10-25/26, PR #29): the inventories below, the [methods](methods/) survey and four pilots. It is a dated record: its `file:line` citations are at `main` `edf6829`, plus the brain-lifecycle branches named in each doc.
  - **The one-brain rule** (#30): its TLA+ model and conformance passes gated the merge (#31). The follow-ups (#38) added the epochs ≤ 3 sweep (depth-bounded), the previous-release host (exhaustive) and C6 as a regression config. Results: [agent-brain/pilot/](agent-brain/pilot/); conformance through #32 and #36's checked head: [agent-brain/conformance/](agent-brain/conformance/).
  - **nestd phase 1** (#39): `crates/nestd-core` holds the fleet link, command dedup, the lease decision and the incarnation decisions. Stateright checks the real fleet-link core against a FleetDO peer model; Kani proves the decision functions; cargo-fuzz covers every parser nestd runs on input from across a trust boundary; cargo-mutants misses no mutant of the core. It found and fixed the lost-command bug below. See [nestd/](nestd/).
- **In CI:** the nestd checks only ([dev/ci.md](../../dev/ci.md#verification)). The TLA+, Lean and command-delivery Stateright pilots run by hand with `verification/run.sh`; wiring them is proposed in [dev/verification.md](../../dev/verification.md). Their sources are in [`verification/`](../../verification/README.md).
- **Next:** [roadmap/](roadmap/).

## Recommendation

The study's recommendation, with what the [direction](#verification) has since settled. It stands for design exploration and for code that has no pure core yet.

| Need | Tool | Why |
|---|---|---|
| Protocol models (leases and fencing, placement, the one-brain rule, host lifecycle, the channels) | **TLA+, checked with TLC** | Exhaustive search, deadlock detection and liveness in one tool. Every TLA+ pilot found real bugs within hours. Agents wrote working specs with the checker in the loop. Apalache reads the same specs for symbolic checks and emits ITF traces, so model-based testing stays open |
| Unbounded proofs of data invariants (GC never deletes a live object; chain shape; later, grants only shrink) | **Lean 4**, core only | Already in the toolchain (`deploy/lean`). The pilot proved GC safety for any bounds in about 1.5 h. Use it after TLC has found the invariant, not to find bugs |
| A pure core composed with models of its peers | **Stateright** | Checks the real Rust core. nestd's fleet link is checked this way in CI ([nestd/](nestd/)); the command-channel pilot before it reproduced the real loss |
| Pure Rust decision functions; tokio task interleavings | **Kani**; **shuttle** | Both check the real code. Kani proves nestd-core's decision functions in CI ([nestd/](nestd/#kani)); shuttle is planned for phase 2's shells and not used yet |
| Durable Object await interleavings | **fast-check** (`fc.scheduler`, `fc.commands`) in vitest | The class behind "re-check after an await" and the cross-DO deadlock |
| Spec-to-code conformance | **Conformance tables now; model-based tests next** | A transition-by-transition review of the brain branch against its model found 13 divergences, then 10 more after the fixes, including one that broke S. Replaying model traces against the real DOs is the mechanical version |

[methods/](methods/) has the full survey: candidates, local trials, costs, and which past bug class each tool catches. That survey preferred Quint over TLA+ for its model-based-testing tooling and agent-readable syntax. The pilots argue for TLA+ for design models: it ran exhaustively, found every bug reported below, and Quint's own path to exhaustive and liveness checks goes through TLA+ export. Which one the Durable Objects' models use is open (below).

## Inventory

Each row is a machine or protocol worth modelling. Its doc (a study record, cited at `edf6829`) lists states, transitions with file:line, delivery and timing assumptions, properties, past bugs, and modelling notes.

| Machine | Actors | Key safety | Key liveness | Doc | Model |
|---|---|---|---|---|---|
| Sandbox lease, placement, fencing, STONITH, salvage | SandboxDO, FleetDO, nestd, EC2 | One committer (head moves only from `(host, epoch)`); no double run; no leased epoch reused; reassignment after STONITH; salvage never dropped; `destroyed` final | A lost sandbox is placed again; markers clear; queues drain | [sandbox-lease/](sandbox-lease/) | TLA+ pilot |
| Brain lifecycle, one brain per agent | AgentDO, FleetDO, nestd, runner, gateway | At most one brain can act (on AgentDO or through a binding); no epoch regression; no start at or below a kill | A queued turn runs or fails; no agent or healthy host wedges | [agent-brain/](agent-brain/) | TLA+ pilot, conformance check |
| Host lifecycle, autoscaling, command delivery | FleetDO, nestd, EC2, Cloudflare | Dead is final; terminate only when empty; every command gets exactly one result | Capacity eventually arrives; STONITH resolves | [hosts/](hosts/) | none yet |
| Reliable channels | FleetDO, AgentDO, nestd, runner | In-order exactly-once processing per lineage; ack only after effects | Every event processed given connectivity | [reliable-channels/](reliable-channels/) | Stateright pilot (commands); the fleet link checked over nestd's real core ([nestd/](nestd/)) |
| Gateway bindings and the hands path | SandboxDO, nestd, gateway, guest, hands client | A call runs only under a binding at the guest's current epoch; no epoch regression; detach voids | A refused call re-resolves and succeeds | [gateway-bindings/](gateway-bindings/) | none yet |
| Commit chain and object-store GC | SandboxDO, FleetDO, nestd, S3 | No object reachable from a live or pending generation is deleted; the chain is a tree; commits are idempotent | Garbage is collected | [commit-gc/](commit-gc/) | Lean pilot |
| nestd incarnations, tombstones, restart recovery | nestd, FleetDO | A dirty incarnation's work ends as a head, an orphan or a recorded loss; fenced is terminal; tombstones pruned only when safe | Every stale incarnation is reaped | [nestd-incarnations/](nestd-incarnations/) | decisions proved with Kani; the machine is phase 2 of [nestd/](nestd/) |

## Pilots

| Pilot | Tool | Checked | Result |
|---|---|---|---|
| [Sandbox lease](sandbox-lease/pilot/) | TLA+/TLC | main's placement, lease, fencing, STONITH, salvage and commit; 9 properties plus 5 liveness | Seven real defects (below); vitest against the real DOs reproduces B1 and B2. With the seven modelled fixes on, every safety invariant holds exhaustively at 2 hosts, 2 epochs, no commits and one disconnect (4.3M states). Larger fixed runs are partial (up to 84M states, no violation). Mutations show each invariant can fail |
| [Brain lifecycle](agent-brain/pilot/) | TLA+/TLC | 65bf6ef, then the single-record design and its amendments, then the branch as built (6073da7; 82396b3 with no same-host re-issue) | Reproduced the four review findings on 65bf6ef. Found six holes in the new design, each adopted as an amendment or fix the same day (below), and reproduced N1 with zero faults. The 82396b3 design holds exhaustively at 2 hosts and epochs ≤ 2 for each single fault (none, reset, lost RPC, crash, idle exit, partition, operator restart) and for restart plus an ignored kill (53.9M states). Drain is depth-bounded: no violation through BFS depth ~40 (72.2M states). The previous-release-host variant holds exhaustively (none, crash, partition). At epochs ≤ 3 no run finished; there is no violation through depth 34-44. That sweep found C6 in a variant without the host-loss guards, which the code has (and tests). Liveness is only partly explored |
| [Brain conformance](agent-brain/conformance/) | review | brain-record at a38d3c0, 6073da7, 82396b3, fb9b836 and 36b60d5, action by action against the model and design | D1 to D13, then N1 to N25. Each was fixed by the next head except the lows listed in the doc. At 36b60d5, S conforms for an all-new fleet and in the mixed-version window. L conforms for an all-new fleet; in the mixed window, N25 wedges healthy old sandbox hosts unless their sandboxes are suspended or the hosts are upgraded first |
| [Commit chain and GC](commit-gc/pilot/) | Lean 4 | SandboxDO.commit guard for guard; the GC mark and sweep with reuse and grace | Chain shape, orphan never head, CAS-only head moves and idempotence proved for every reachable state. GC safety proved under assumption A1. B1 (no age bound on a resent commit) checked as a 6-step counterexample. No `sorry`; standard axioms only |
| [Command delivery](reliable-channels/pilot/) | Stateright | FleetDO → nestd commands: send, BrokerDO resolution, hello, ack, restarts | main loses an acked command in 8 steps with no fault. Both fix shapes hold (7.4M and 12.5M states), and the model showed which extra pieces each fix needs. Superseded by the check over nestd's real core ([nestd/](nestd/)), which found the fix #39 shipped |

## Real bugs found

Found on `main` (`edf6829`) unless marked; "Where" cites that commit. "Confirmed" means a checker trace, a test run, or the lead's own reading of the code; reproduction sketches are in the owning doc. "Now" is the state on `main` at b63c0a3 (2026-10-29), checked by reading the code.

| Bug | Where (`edf6829`) | Consequence | Found by | Now | Doc |
|---|---|---|---|---|---|
| Fleet commands lost. A later batch can be sent before an earlier one that is awaiting BrokerDO or hello's resend. nestd has no gap check, so the cumulative ack deletes the earlier batch | `fleet.ts:699-723`, `:762-778`, `:1169-1171`; `fleet.rs:394-404` | An `agent_start`, `agent_attach`, `agent_detach`, `fence` or `sandbox_destroy` is never run and never answered | two inventories independently; Stateright (8 steps) | **Fixed** (#39): FleetDO sends through one per-host chain in seq order; nestd accepts commands only in order from `hello_ack.next_command_seq` and reconnects on a gap. Checked over the real core ([nestd/](nestd/)) | [reliable-channels/pilot/](reliable-channels/pilot/) |
| A dirty incarnation's work is deleted. Retire first resends an unanswered commit; its `stale_epoch` refusal ends retire before the salvage is prepared | `host.rs:2052-2058`, `:1193` | Uncommitted work lost after a nestd restart or a timed-out commit | inventory; TLC (MCBB1) | Open (the re-ask's error still returns before the salvage is prepared); phase 2 of [nestd/](nestd/#phase-2-design) expects to reproduce it | [nestd-incarnations/](nestd-incarnations/) |
| Salvage refused after a no-capacity rollback. leaseLost finds no host and rolls the epoch back to the lost one, so the old holder's salvage hits the stale branch | `sandbox.ts:312`, `:575`, `:585` | Uncommitted work lost, contradicting "no agent work is silently lost" | inventory; TLC (18 steps, no faults); vitest | Open: needs the owner's decision (below) | [sandbox-lease/](sandbox-lease/) |
| Destroy during a placement resurrects the sandbox | `sandbox.ts:304-319`, `:507-519` | A destroyed sandbox comes back, maybe running; its generations become GC roots again | inventory; TLC (7 steps); vitest | Open (`placeCurrentEpoch`'s continuation still doesn't check `destroyed`) | [sandbox-lease/](sandbox-lease/) |
| Double run after a lapse. A `sandbox_create` executed after the host's lease lapsed runs unfenced, and STONITH counts `shutting-down` as dead | `host.rs:1066-1072`, `:1404-1490`; `ec2.ts:45` | Two VMs of one sandbox until the instance stops; commits stay safe | TLC | Open (#30's lapse guard covers `agent_start` only; `isDead` still counts `shutting-down`) | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| Stuck sandboxes: a late placement answer adopts a lost host; a reassignment is dropped by `INSERT OR IGNORE` | `sandbox.ts:466-473`; `fleet.ts:1849-1850` | The sandbox never runs again without an operator | TLC (L1, L2) | Open (`queueReassign` still inserts with `OR IGNORE`) | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| A resent commit has no age bound against the GC grace | `host.rs:2052`; `sandbox.ts:552`; `gc.rs:97` | A generation can name deleted chunks; every later GC pass then fails closed | inventory; Lean counterexample | Open | [commit-gc/](commit-gc/) |
| A host terminated outside FleetDO counts toward `max_hosts` until idle retirement | `fleet.ts:1443-1446` | Explains the ~10 min wait in the open watch item | inventory | **Fixed by #30** (by reading; not re-run on AWS): the tick expires any silent host, and one holding no lease at once (`expireSilent`), so it stops counting at the first tick after 30 s of silence | [hosts/](hosts/) |
| Brain record (branch): six design holes, then 38 divergences across five heads (D1-D13, N1-N25) | `deferred/brain-record` | Two brains acting, or a wedged agent or healthy host. Each was adopted as an amendment or fixed, except the lows and N25 (mixed-window availability) | TLC; conformance | Merged as #30; N25 handled by the rollout rule in [dev/deploy.md](../../dev/deploy.md) | [agent-brain/conformance/](agent-brain/conformance/) |

The inventories list more suspected bugs, each with what would confirm it.

**Docs and code disagree** on these points (state at b63c0a3); each needs an owner decision or code, not just an edit:
1. "An epoch is never retried" vs. the no-capacity rollback in `SandboxDO.placeCurrentEpoch`.
2. Hands-call journaling is a settled decision ([hands](../agents/hands/)) but isn't built: the guest keeps no call records and nothing answers `call_status`. Only the gateway's refusal before `bound` carries `executed: false`.
3. "A gap closes the socket" now holds for FleetDO's receivers and nestd's command receiver (#39), not for the runner's session receiver, which drops duplicates but accepts a higher seq.
4. The single `isRestoreSource` predicate doesn't exist in code: generation retention isn't built, so every generation is kept and is a GC root.

## What the methods would and wouldn't have caught

- **Caught in these pilots:** split brain across moves, stale epochs accepted, retries that stop, pruning of needed data, and reordered delivery. Each needed the model to split DO handlers at every `await` and to include resets and lost replies.
- **Not caught by any model:** a fake collaborator hiding a binding error (lesson 8) and a guessed wire encoding (lesson 5).
- **The models are hand translations:** a model that is wrong about the code proves nothing about it. The brain conformance check found transitions the model lacked: a start's error result, and an expiry split by an `await`. Both broke S.
- [methods/](methods/#past-bug-classes) maps each past bug class to the tools that catch it.

## Layout

- **Specs:** in [`verification/`](../../verification/README.md) at the repo root, because they need builds and pinned tools: `tla/` (TLC configurations with expected outcomes), `lean/` (a Lake project), `stateright/` (the command-delivery pilot, a standalone crate outside the workspace), `nestd/check/` (Stateright over nestd's real cores) and `nestd/fuzz/` (cargo-fuzz targets), both standalone too, and `repro/` (vitest reproductions, not in the suite). The cores themselves are in `crates/nestd-core`.
- **Docs:** each pilot's report sits next to the inventory it checks.

## Open questions

- **The Durable Objects' checks:** the [direction](#verification) names a TypeScript explorer over the control plane's cores (Rust via WASM where a protocol spans both sides), but neither is designed: which DO logic moves into cores first, and how the explorer models DO interleavings. Until then, which language the design models use is open too: TLA+, as the pilots did, or Quint, as the survey picked for model-based tests. See [roadmap/](roadmap/).
- **Spec ownership:** a PR that changes a modelled handler should update the spec or its conformance table. Should a guard enforce that? See [roadmap/](roadmap/#open-questions).
- **The epoch rollback:** keep it (and authorize salvage at the current epoch while unplaced) or spend an epoch per attempt? See [sandbox-lease/](sandbox-lease/).

## Contents

| Directory | What |
|---|---|
| [methods/](methods/) | Tool survey, conformance approaches, costs, bug classes |
| [sandbox-lease/](sandbox-lease/) | Inventory; [pilot/](sandbox-lease/pilot/) |
| [agent-brain/](agent-brain/) | Inventory; [pilot/](agent-brain/pilot/); [conformance/](agent-brain/conformance/) |
| [hosts/](hosts/) | Inventory |
| [reliable-channels/](reliable-channels/) | Inventory; [pilot/](reliable-channels/pilot/) |
| [gateway-bindings/](gateway-bindings/) | Inventory |
| [commit-gc/](commit-gc/) | Inventory; [pilot/](commit-gc/pilot/) |
| [nestd-incarnations/](nestd-incarnations/) | Inventory; its decisions are in `nestd_core::incarnation`, the machine is phase 2 of [nestd/](nestd/) |
| [nestd/](nestd/) | nestd's pure cores checked as shipped: Stateright over the real fleet-link core and the lease, Kani, cargo-fuzz, cargo-mutants; phase 2 design |
| [roadmap/](roadmap/) | What is next: open findings, models, assertions, CI |

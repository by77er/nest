# Verification

How nest's state machines and protocols can be formally checked, which ones are worth it, and what four pilots found. The subject is the platform design: it doesn't depend on how this repo is built.

**Status:** a study (2026-10-25/26). Code examined: `main` at `edf6829`, plus the brain-lifecycle branches `origin/deferred/agent-epoch` (65bf6ef) and `origin/deferred/brain-record` (a38d3c0 through 36b60d5, the merge gate).
- **Pilots:** two TLA+ models checked with TLC, one Lean 4 proof, one Stateright model. Their sources are in [`verification/`](../../verification/README.md).
- **Not yet wired into CI.** The proposal is in [dev/verification.md](../../dev/verification.md).

## Recommendation

| Need | Tool | Why |
|---|---|---|
| Protocol models (leases and fencing, placement, the one-brain rule, host lifecycle, the channels) | **TLA+, checked with TLC** | Exhaustive search, deadlock detection and liveness in one tool. Every TLA+ pilot found real bugs within hours. Agents wrote working specs with the checker in the loop. Apalache reads the same specs for symbolic checks and emits ITF traces, so model-based testing stays open |
| Unbounded proofs of data invariants (GC never deletes a live object; chain shape; later, grants only shrink) | **Lean 4**, core only | Already in the toolchain (`deploy/lean`). The pilot proved GC safety for any bounds in about 1.5 h. Use it after TLC has found the invariant, not to find bugs |
| A protocol model that should call real Rust code | **Stateright** | The command-channel pilot reproduced a real loss and checked both fixes. Use it where extracted pure nestd functions can be called from the model; otherwise prefer TLA+ |
| Pure Rust decision functions; tokio task interleavings | **Kani**; **shuttle** | Both check the real code. Neither has a pilot here beyond the survey's toy runs |
| Durable Object await interleavings | **fast-check** (`fc.scheduler`, `fc.commands`) in vitest | The class behind "re-check after an await" and the cross-DO deadlock |
| Spec-to-code conformance | **Conformance tables now; model-based tests next** | A transition-by-transition review of the brain branch against its model found 13 divergences, then 10 more after the fixes, including one that broke S. Replaying model traces against the real DOs is the mechanical version |

[methods/](methods/) has the full survey: candidates, local trials, costs, and which past bug class each tool catches. That survey preferred Quint over TLA+ for its model-based-testing tooling and agent-readable syntax. The pilots argue for TLA+ now: it ran exhaustively, found every bug reported below, and Quint's own path to exhaustive and liveness checks goes through TLA+ export. Quint stays an option if the model-based-testing harness ([roadmap](roadmap/)) turns out simpler with it (open question).

## Inventory

Each row is a machine or protocol worth modelling. Its doc lists states, transitions with file:line, delivery and timing assumptions, properties, past bugs, and modelling notes.

| Machine | Actors | Key safety | Key liveness | Doc | Model |
|---|---|---|---|---|---|
| Sandbox lease, placement, fencing, STONITH, salvage | SandboxDO, FleetDO, nestd, EC2 | One committer (head moves only from `(host, epoch)`); no double run; no leased epoch reused; reassignment after STONITH; salvage never dropped; `destroyed` final | A lost sandbox is placed again; markers clear; queues drain | [sandbox-lease/](sandbox-lease/) | TLA+ pilot |
| Brain lifecycle, one brain per agent | AgentDO, FleetDO, nestd, runner, gateway | At most one brain can act (on AgentDO or through a binding); no epoch regression; no start at or below a kill | A queued turn runs or fails; no agent or healthy host wedges | [agent-brain/](agent-brain/) | TLA+ pilot, conformance check |
| Host lifecycle, autoscaling, command delivery | FleetDO, nestd, EC2, Cloudflare | Dead is final; terminate only when empty; every command gets exactly one result | Capacity eventually arrives; STONITH resolves | [hosts/](hosts/) | none yet |
| Reliable channels | FleetDO, AgentDO, nestd, runner | In-order exactly-once processing per lineage; ack only after effects | Every event processed given connectivity | [reliable-channels/](reliable-channels/) | Stateright pilot (commands) |
| Gateway bindings and the hands path | SandboxDO, nestd, gateway, guest, hands client | A call runs only under a binding at the guest's current epoch; no epoch regression; detach voids | A refused call re-resolves and succeeds | [gateway-bindings/](gateway-bindings/) | none yet |
| Commit chain and object-store GC | SandboxDO, FleetDO, nestd, S3 | No object reachable from a live or pending generation is deleted; the chain is a tree; commits are idempotent | Garbage is collected | [commit-gc/](commit-gc/) | Lean pilot |
| nestd incarnations, tombstones, restart recovery | nestd, FleetDO | A dirty incarnation's work ends as a head, an orphan or a recorded loss; fenced is terminal; tombstones pruned only when safe | Every stale incarnation is reaped | [nestd-incarnations/](nestd-incarnations/) | none yet |

## Pilots

| Pilot | Tool | Checked | Result |
|---|---|---|---|
| [Sandbox lease](sandbox-lease/pilot/) | TLA+/TLC | main's placement, lease, fencing, STONITH, salvage and commit; 9 properties plus 5 liveness | Seven real defects (below); vitest against the real DOs reproduces B1 and B2. With the seven modelled fixes on, every safety invariant holds exhaustively at 2 hosts, 2 epochs, no commits and one disconnect (4.3M states). Larger fixed runs are partial (up to 84M states, no violation). Mutations show each invariant can fail |
| [Brain lifecycle](agent-brain/pilot/) | TLA+/TLC | 65bf6ef, then the single-record design and its amendments, then the branch as built (6073da7; 82396b3 with no same-host re-issue) | Reproduced the four review findings on 65bf6ef. Found six holes in the new design, each adopted as an amendment or fix the same day (below), and reproduced N1 with zero faults. The 82396b3 design holds exhaustively at 2 hosts and epochs ≤ 2 for each single fault (none, reset, lost RPC, crash, idle exit, partition, operator restart) and for restart plus an ignored kill (53.9M states). Drain is depth-bounded: no violation through BFS depth ~40 (72.2M states). Not yet covered: epochs ≤ 3, liveness on the final design, mixed versions |
| [Brain conformance](agent-brain/conformance/) | review | brain-record at a38d3c0, 6073da7, 82396b3, fb9b836 and 36b60d5, action by action against the model and design | D1 to D13, then N1 to N25. Each was fixed by the next head except the lows listed in the doc. At 36b60d5, S conforms for an all-new fleet and in the mixed-version window. L conforms for an all-new fleet; in the mixed window, N25 wedges healthy old sandbox hosts unless their sandboxes are suspended or the hosts are upgraded first |
| [Commit chain and GC](commit-gc/pilot/) | Lean 4 | SandboxDO.commit guard for guard; the GC mark and sweep with reuse and grace | Chain shape, orphan never head, CAS-only head moves and idempotence proved for every reachable state. GC safety proved under assumption A1. B1 (no age bound on a resent commit) checked as a 6-step counterexample. No `sorry`; standard axioms only |
| [Command delivery](reliable-channels/pilot/) | Stateright | FleetDO → nestd commands: send, BrokerDO resolution, hello, ack, restarts | main loses an acked command in 8 steps with no fault. Both fix shapes hold (7.4M and 12.5M states), and the model showed which extra pieces each fix needs |

## Real bugs found

On `main` (`edf6829`), unless marked. "Confirmed" means a checker trace, a test run, or the lead's own reading of the code; reproduction sketches are in the owning doc.

| Bug | Where | Consequence | Found by | Doc |
|---|---|---|---|---|
| Fleet commands lost. A later batch can be sent before an earlier one that is awaiting BrokerDO or hello's resend. nestd has no gap check, so the cumulative ack deletes the earlier batch | `fleet.ts:699-723`, `:762-778`, `:1169-1171`; `fleet.rs:394-404` | An `agent_start`, `agent_attach`, `agent_detach`, `fence` or `sandbox_destroy` is never run and never answered | two inventories independently; Stateright (8 steps) | [reliable-channels/pilot/](reliable-channels/pilot/) |
| A dirty incarnation's work is deleted. Retire first resends an unanswered commit; its `stale_epoch` refusal ends retire before the salvage is prepared | `host.rs:2052-2058`, `:1193` | Uncommitted work lost after a nestd restart or a timed-out commit | inventory; TLC (MCBB1) | [nestd-incarnations/](nestd-incarnations/) |
| Salvage refused after a no-capacity rollback. leaseLost finds no host and rolls the epoch back to the lost one, so the old holder's salvage hits the stale branch | `sandbox.ts:312`, `:575`, `:585` | Uncommitted work lost, contradicting "no agent work is silently lost" | inventory; TLC (18 steps, no faults); vitest | [sandbox-lease/](sandbox-lease/) |
| Destroy during a placement resurrects the sandbox | `sandbox.ts:304-319`, `:507-519` | A destroyed sandbox comes back, maybe running; its generations become GC roots again | inventory; TLC (7 steps); vitest | [sandbox-lease/](sandbox-lease/) |
| Double run after a lapse. A `sandbox_create` executed after the host's lease lapsed runs unfenced, and STONITH counts `shutting-down` as dead | `host.rs:1066-1072`, `:1404-1490`; `ec2.ts:45` | Two VMs of one sandbox until the instance stops; commits stay safe | TLC | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| Stuck sandboxes: a late placement answer adopts a lost host; a reassignment is dropped by `INSERT OR IGNORE` | `sandbox.ts:466-473`; `fleet.ts:1849-1850` | The sandbox never runs again without an operator | TLC (L1, L2) | [sandbox-lease/pilot/](sandbox-lease/pilot/) |
| A resent commit has no age bound against the GC grace | `host.rs:2052`; `sandbox.ts:552`; `gc.rs:97` | A generation can name deleted chunks; every later GC pass then fails closed | inventory; Lean counterexample | [commit-gc/](commit-gc/) |
| A host terminated outside FleetDO counts toward `max_hosts` until idle retirement | `fleet.ts:1443-1446` | Explains the ~10 min wait in the open watch item | inventory | [hosts/](hosts/) |
| Brain record (branch): six design holes, then 38 divergences across five heads (D1-D13, N1-N25) | `deferred/brain-record` | Two brains acting, or a wedged agent or healthy host. Each was adopted as an amendment or fixed, except the lows and N25 (mixed-window availability) | TLC; conformance | [agent-brain/conformance/](agent-brain/conformance/) |

The inventories list more suspected bugs, each with what would confirm it.

**Docs and code disagree** on four points; each needs an owner decision, not just an edit:
1. "An epoch is never retried" vs. the no-capacity rollback (`sandbox.ts:312`).
2. Hands-call journaling (`call_status`, `executed: false`) is a settled decision but isn't built.
3. "A gap closes the socket" holds for FleetDO's receivers, not nestd's or the runner's.
4. The single `isRestoreSource` predicate doesn't exist in code.

## What the methods would and wouldn't have caught

- **Caught in these pilots:** split brain across moves, stale epochs accepted, retries that stop, pruning of needed data, and reordered delivery. Each needed the model to split DO handlers at every `await` and to include resets and lost replies.
- **Not caught by any model:** a fake collaborator hiding a binding error (lesson 8) and a guessed wire encoding (lesson 5).
- **The models are hand translations:** a model that is wrong about the code proves nothing about it. The brain conformance check found transitions the model lacked: a start's error result, and an expiry split by an `await`. Both broke S.
- [methods/](methods/#past-bug-classes) maps each past bug class to the tools that catch it.

## Layout

- **Specs:** in [`verification/`](../../verification/README.md) at the repo root, because they need builds and pinned tools: `tla/` (TLC configurations with expected outcomes), `lean/` (a Lake project), `stateright/` (a standalone crate outside the workspace), and `repro/` (vitest reproductions, not in the suite).
- **Docs:** each pilot's report sits next to the inventory it checks.

## Open questions

- **Spec language:** TLA+ (the pilots) or Quint (the survey) for the long run? This depends on the model-based-testing harness. See [roadmap/](roadmap/).
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
| [nestd-incarnations/](nestd-incarnations/) | Inventory |
| [roadmap/](roadmap/) | What to model next, CI, assertions and tests to add now |

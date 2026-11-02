---
name: nest-control-plane
description: Use when changing nest's control plane in control-plane/ (the Worker and its API routes in src/index.ts; FleetDO, SandboxDO, AgentDO, BrokerDO, CatalogDO or WorkstreamDO; src/lib; a Durable Object's SQLite schema; wrangler.jsonc) or its vitest suite, even for a one-line fix. Covers await interleaving, alarms, rollback-safe schema changes, the model-checked one-brain rule, and how to prove the change.
---

# Changing the control plane

**Where things are:** the code map is [control-plane/README.md](../../../control-plane/README.md); the design is [docs/control-plane/](../../../docs/control-plane/README.md), one directory per DO under `durable-objects/`; stored data is [docs/data/](../../../docs/data/README.md). A wire change also follows the `nest-wire` skill. `src/index.ts`, `src/do/broker.ts`, `wrangler.jsonc` and several `src/lib/` files are `CODEOWNERS` paths.

## Durable Object rules (each was a real bug here)

1. **A DO interleaves at every `await` that isn't its own storage:** another DO's RPC, `fetch`, BrokerDO, EC2, the Cloudflare API. Never check, await, then act on the check. Re-read the guard and write in the same synchronous step (N1: the tick expired a host from a snapshot read before an await; AgentDO's `unchanged(snap)` after each await is the pattern).
2. **Never call synchronously back into a DO that is awaiting you** (AgentDO → SandboxDO → AgentDO deadlocked). Record the notice and deliver it from your own alarm.
3. **Arm the alarm in the same synchronous step as the transition** (`Deadlines` in `src/lib/reliable.ts`). A reset between the two strands the work.
4. **Cross-DO notices:** delete the row only after the receiver acknowledges, retry from the alarm, and match the row by epoch or cmd so a stale ack can't delete a newer row.
5. **One durable record decides; everything else is an index derived from it.** AgentDO's brain record decides where a brain runs; FleetDO's `host_agents` is an index. Don't add a second copy that can disagree.
6. **`answered_by = 'fleet'`** means FleetDO answered a command itself. It is not evidence that the host ran it.
7. **Stored enums:** write through TypeScript unions and read through `storedEnum` (`src/lib/stored.ts`).

## Schema and rollback

A failed deploy smoke test runs `wrangler rollback`, and Cloudflare rolls back code, not data ([upgrades](../../../docs/control-plane/README.md#upgrades)). So every release must also run under the previous Worker:
- **Expand only:** `CREATE TABLE IF NOT EXISTS`, and FleetDO's `addColumn` (checks `PRAGMA table_info`, then `ALTER TABLE … ADD COLUMN`). Make the column nullable or give it a default, so old rows read as "unknown" or "off". Backfill once, in the constructor. Don't rename or drop anything in the same release.
- **Keep writing what the previous release reads,** for one release. Stored JSON tolerates old shapes: new fields are optional, with defaults.
- **A rename takes two releases (expand/contract):** read both names and write the old one; switch the writes next release; drop the old reads the release after. The host roles are the worked example ([dev/deploy.md](../../../dev/deploy.md#host-role-names-expandcontract)).
- **A DO class change** (new, renamed or deleted; a `migrations` tag in `wrangler.jsonc`) **is one-way:** it ships alone, and recovery is a forward revert.
- **Test the migration on the old shape:** in `runInDurableObject`, create the table as the previous release did, insert a row, run the migration, and assert. The pattern is in `test/agent-seams.test.ts` ("rows keyed by agent alone"). That migration rebuilt a table, an exception to expand-only: don't copy it without checking the rollback.
- **Write a rollout rule for ordering constraints** in [dev/deploy.md](../../../dev/deploy.md): what deploys first, what happens in the gap, and what a `wrangler rollback` does with the rows this release wrote.

## The one-brain rule is model-checked

Changes to any of these need a conformance check against [the model](../../../verification/tla/agent-brain/AgentBrain.tla):
- AgentDO's brain record (start, condemn, kill, escalation, release, `onExited`, `onHostLost`);
- FleetDO's brain index, host expiry, loss, wedge, `issueCommands`' start refusals, or brain placement;
- nestd's runner link.

1. Read [the conformance doc](../../../docs/verification/agent-brain/conformance/README.md). Keep every guard it lists and the tests behind them: the per-host re-read before expiry (N1); `onHostLost` bounded by epoch and re-checking `lost` on delivery (C6); `brain_epochs` gating; the `wedged_ms` exclusion; the refusals of starts to expired, dead, unknown or previous-release hosts. Its "untested load-bearing lines" list is a list of tests worth adding.
2. Add a dated section to that doc for your head: each changed action → `file:line` → conforms (yes, partly, no).
3. If the change adds a transition the model lacks, model it first (the `nest-verification` skill).

## Tests (vitest in workerd)

- **Run:** `cd control-plane && npm ci && npm run typecheck && npm test; echo "exit $?"`. One file: `npx vitest run test/fleet.test.ts`; one test: add `-t '<name>'`.
- **Trust the exit code, not the counts.** A DO RPC rejection asserted as `await expect(stub.x()).rejects…` can be reported as an unhandled rejection: every test passes, the summary shows `Errors 1 error`, and the run exits 1. Wrap it: `await expect(Promise.resolve().then(() => stub.x())).rejects.toThrow(…)`. Dozens of `uncaught exception` lines in a passing run are workerd's own logging, not failures.
- **Isolation:** tests share the DO namespaces, so each test makes its own cell (`uniqueCell()`) and ids and never reads another test's objects.
- **Real alarms run in the pool.** Assert eventual outcomes, and tolerate an alarm that fires early. To fire one now, use `runDurableObjectAlarm`; to read or plant rows, use `runInDurableObject`.
- **A test that passes alone and fails under load** usually asserts an intermediate state or waits too briefly. Find the root cause; don't just raise the timeout.
  - A fixed `sleep` before asserting what a socket or another DO delivers (a segment received, a close code, a deadline `webSocketClose` arms) is the usual culprit: wait for the thing itself. `test/helpers.ts` has `eventually` (poll for a truthy value, 10 s), `received` (segment bytes at AgentDO), `sessionGone` (a runner's close landed), `inboundSettled` (FleetDO finished a hello's work, which goes on after `hello_ack`) and `Ws.whenClosed`.
  - To run a deadline a test made due (`at = 0`), use `runDue(stub)`, not `runDurableObjectAlarm`. The latter runs only an alarm that is scheduled and not already running, and a row a test wrote arms none.
  - A sleep before acting can also make a test pass without testing anything: the interleaving it set up never happened. A held call reports when it is held (`holdFleet`'s `reached`), and a hook sets a flag the test waits for. A sleep stays only to give something that must *not* happen room to happen.
  - To observe a DO's RPC method, patch the class prototype and restore it in `finally`: RPC doesn't see a method set on the instance (it then fails with "does not implement the method").
  - When two DOs write in turn (SandboxDO destroys, then AgentDO records it), wait on the later write.
  - The pool's per-test timeout is 15 s (`vitest.config.ts`): CI's first ~30 s overlap the other workers' module imports. A test whose deliberate waits (batch windows, call timeouts) approach it sets its own, naming the timer.
- **A fake collaborator hides binding errors** ([review lesson 8](../../../dev/review-lessons.md)): one test per injected global runs the real default.
- **Mutation-check fixes:** revert the guard, run its file, watch the named test fail, restore.
- A change to an admin view (`protocol/admin/view.ts`) also needs the dashboard: `cd dashboard && npm ci && npm run typecheck && npm test && npm run build`.

## Done

- Typecheck and the full suite exit 0.
- Any migration has a test on the old shape, and the release still runs under the previous Worker.
- Conformance is updated if a brain-rule path changed.
- The owning doc under `docs/control-plane/` records the decision, and `dev/deploy.md` has the rollout rule if there is one.
- `e2e/run.sh` passed if hosts are involved (the `nest-host` skill).
- After the merge, the deploy is watched and the cloud checked (the `nest-infra` skill).

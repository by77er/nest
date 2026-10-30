---
name: nest-verification
description: Use when a nest change touches a modelled protocol or state machine (sandbox leases, placement, fencing, STONITH, the one-brain rule, the fleet channel, commit chain and GC, nestd incarnations), when designing a new protocol or concurrent handler, or when working in verification/ (TLA+ specs and expect.tsv, the Lean project, the Stateright crates, Kani, conformance docs). Says when to model first, how to run and extend the models, and what a result can claim.
---

# Formal verification

**Where things are:**
- **The study, inventory and pilots:** [docs/verification/](../../../docs/verification/README.md), one directory per machine. Each has an inventory with states, transitions at `file:line` and properties.
- **Sources:** [verification/](../../../verification/README.md):
  - `tla/<spec>/` (the spec, `MC_*.cfg`, `expect.tsv`);
  - `lean/`;
  - `stateright/` (the command-delivery pilot on old `main`);
  - `nestd/check/` and `nestd/fuzz/` (nestd's real cores; the `nest-host` skill);
  - `repro/`.
- **The CI proposal for TLC and Lean:** [dev/verification.md](../../../dev/verification.md). Only the nestd jobs run in CI today: `verify-nestd`, `kani-nestd` and `fuzz-nestd`. TLC and Lean run by hand.

## When to model first

- **Model before coding** when a change adds or reorders transitions across actors (AgentDO, FleetDO, SandboxDO, nestd, the runner, the gateway), adds a fault path (reset, lost reply, partition, crash, lapse), or splits a handler at a new `await`. Every TLA+ pilot found real bugs within hours, and all of them were of this kind.
- **Check conformance** when a change touches a handler a model cites: walk the changed actions against the spec, `file:line` by `file:line`, and add a dated section to the machine's conformance doc. The brain rule's is [agent-brain/conformance/](../../../docs/verification/agent-brain/conformance/README.md). Keep the guards that doc names.
- **Put new nestd decision logic in a pure core** and check the core itself (the `nest-host` skill). Use TLA+ for design exploration; it isn't the source of truth for that code.
- **Use Lean** for unbounded proofs of data invariants once TLC has found them (GC safety, chain shape), not to find bugs.

## Running

- **Everything at the CI tier:** `verification/run.sh`. This runs the TLC configs marked `ci`, the Lean build (refusing `sorry`, `admit` and `native_decide`) and the Stateright pilot.
- **One spec's TLC configs:** `verification/run.sh --only tla --spec sandbox-lease` (or `agent-brain`). Set `TLC_WORKERS=4` and `TLC_JAVA_OPTS=-Xmx3g` on a shared machine. Each `ci` config finishes in under 3 min, but a whole tier takes 8-20 min or more. The `full` tier (`--all`) takes hours, and its state queues reach gigabytes.
- **One config by hand:** `cd verification/tla/<spec> && java -XX:+UseParallelGC -Xmx4g -cp ../../.tools/tla2tools-1.7.4.jar tlc2.TLC -workers 4 -metadir /var/tmp/tlc-<tag> -config <cfg> <Spec>.tla`. `run.sh` fetches the pinned jar on first use.
- **Lean:** `verification/run.sh --only lean`.
- **Stateright pilot:** `verification/run.sh --only stateright`, about 30 s once built.
- **Resources:** run one heavy job at a time. `run.sh` keeps TLC's state queues in `verification/.tlc-states/` (gitignored, deleted after each config). By hand, put `-metadir` and Cargo targets under `/var/tmp`, never `/tmp`.
- **Read a FAIL before believing it:** check TLC's exit code, and its output for the expected violation line. `run.sh` once reported false FAILs: a long counterexample overflowed a pipe into `grep -q` under `pipefail`.

## Writing and changing models

- **Every config has an expected outcome** in `expect.tsv`: `<Spec.tla> <cfg> <holds|violates:Name> <ci|full>`. Bug reproductions are asserted to keep failing; a fix becomes a toggle, so turning it off reproduces its counterexample. When a fix lands in code, relabel or delete the config that modelled the old behaviour.
- **Split DO handlers at every `await`,** and include resets and lost replies. The bugs were in those interleavings.
- **Results are exhaustive only within their bounds,** so state the bounds (hosts, epochs, faults, queue sizes) with every result. A depth-bounded or time-cut run is partial: say "no violation through depth N", not "holds".
- **Rule out vacuity:**
  - a single-fault or no-fault run can pass because the interesting state is never reached;
  - add a reachability check (a TLC invariant expected to be violated, or a Stateright `sometimes`) showing the fault path happens;
  - mutate the spec or the fix and confirm the property fails.
- **A model is a hand translation.** Keep the action → `file:line` table in the spec header or the pilot doc. A PR that changes a modelled handler updates the spec or the conformance table in the same PR.
- **Replay counterexamples as tests against the real code:** vitest for DOs (start from `verification/repro/`), step tests for nestd cores. A model result is evidence about the design; a claim about the code needs conformance or a test.

## Done

- The affected configs were run with their expected outcomes, and the bounds are stated.
- New properties were shown non-vacuous and mutation-checked.
- The conformance doc has a dated section for the head checked.
- Counterexamples that reached code have regression tests.
- Open questions are recorded in the owning doc and in [docs/README.md](../../../docs/README.md).

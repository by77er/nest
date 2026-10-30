# agent-brain TLA+ model

`AgentBrain.tla` models the one-brain rule across AgentDO, FleetDO, nestd and the agent runner. It covers the single-record design (`RECORD = TRUE`, `BRAIN-RECORD-DESIGN.md` with amendments A1-A6) and `origin/deferred/agent-epoch` at 65bf6ef (`RECORD = FALSE`, every fix off). Each fix and amendment is a toggle, so turning one off reproduces its counterexample. The report is [docs/verification/agent-brain/pilot/](../../../docs/verification/agent-brain/pilot/README.md).

| Toggle | Meaning |
|---|---|
| `FIX_H1` | nestd keyed by (agent, epoch); the runner keeps a tombstone (review H1) |
| `RECORD` | one brain record, no separate `awaiting_exit` (H2) |
| `FIX_H3` | a condemned brain's session is never current (H3) |
| `FIX_H4` | FleetDO expires any silent host (H4) |
| `FIX_DRAIN` | a drained host still indexing brains isn't dead by fiat |
| `A1` | the kill is part of the condemn, re-sent until FleetDO stored it |
| `A2` | release when FleetDO reports the host lost; `onHostLost` retried until acked |
| `A3` | a start never outlives a lapse or an expiry |
| `REFUSED_WAITS` | A4: a refused start's exit waits until older brains have deregistered |
| `A5` | the `onHostLost` ack deletes the row only at the epoch it was sent for |
| `A6` | "lost" means expired or confirmed dead, never a drain's "dead" |
| `LOSS_EPOCH` | host loss releases only a record at or below its epoch (`AgentDO.onHostLost`); a previous-release host's epoch-less row is exempt |
| `LOST_RECHECK` | host loss releases only while FleetDO still reports the host lost, else the row stays (`onHostLost` re-checks `hostGone`). Both guards are on in the current design; with both off: C6 (`MC_c6`) |
| `START_FAIL` | a refused start's command error releases via `startFailed` (a38d3c0, D1) |
| `SPLIT_EXPIRE`, `EXPIRE_RECHECK` | the tick's expiry split at its await (N1, 6073da7), and its fix |
| `NO_REISSUE` | 82396b3: a start while a non-condemned brain exists answers `none`; an operator restart (`ROpRestart`, under `ALLOW_STOP`) condemns and keeps the intent |
| `NO_ADOPT` | 82396b3: the runner never adopts; a registered brain is ended and the new start registers after it |
| `OLD_HOST` | `NoHost`, or a host running the previous release: seeded with a live brain, drained on sight, never started on, released only on loss, wedged at the 15 min cap (`ROldCap`, 36b60d5) |
| `WAIT`, `TOMBSTONE`, `F`/`E` | mutations |
| `ALLOW_*`, `MaxFaults` | which faults, and how many |

`expect.tsv` lists every config with its expected outcome and whether it is `ci` (under ~3 min with 4-8 workers) or `full`; `verification/run.sh` reads it and fetches the pinned TLC v1.7.4 into `verification/.tools/`. Every `ci` line was run with v1.7.4 and gave the expected result:

```
java -XX:+UseParallelGC -Xmx4g -cp verification/.tools/tla2tools-1.7.4.jar tlc2.TLC -workers 4 -metadir <dir> -config <cfg> AgentBrain.tla
```

v1.7.4 writes no trace spec by default and rejects `-noGenerateSpecTE`; the 2026.10.24 nightly needs that flag to avoid writing `AgentBrain_TTrace_*.tla` next to the spec. For a liveness violation, v1.7.4 prints `Temporal properties were violated.` without naming the property, so match that line for the `violates:Stable*` configs.

Liveness is checked as `StableTurnsDrain` / `StableNoWedge`: L under the premise that lease lapses eventually stop. A lapse with no fault behind it (a host merely slow to heartbeat) is free in the model, so plain `TurnsDrain` fails on a host that lapses and expires forever.

Bounds used by the `MC_e2_*`, `MC_built_*`, `MC_n1_*`, `MC_nr_*` and `MC_old_*` configs: 2 hosts (symmetry, except `MC_old_*`), agent epochs ≤ 2, one turn, `F = 1 < E = 2`, queues ≤ 2/2/3 (`SmallBounds`), one fault of one kind (`MC_nr_restart_wedge`: two). The counterexample configs use epochs ≤ 3 and `Bounds` (3/3/4). `MC_e3_*` use epochs ≤ 3 and `E3Bounds` (`SmallBounds`, and never every host lapsed or expired at once).

Families: `MC_tip_*` = 65bf6ef; `MC_rec_*` = the record design with one fix off; `MC_e2_*` = fully amended (A1-A6); `MC_built_*` = a model variant with an unguarded host-loss release (no epoch bound, no re-check: not the code, which has both guards); `MC_nr_*` = the current design, 82396b3 / main (no re-issue, never adopt, N1 fixed, host loss epoch-bounded and re-checked); `MC_c6` = the current design with both host-loss guards off; `MC_old_*` = the current design with a previous-release host; `MC_e3_*` = the current design at epochs ≤ 3.

Not confirmed to completion (marked in `expect.tsv`): `MC_nr_drain` (no violation through BFS depth ~40, 72.2M states); the `MC_e3_*` sweep and the two single-guard configs (no violation through depth ~34-44); `MC_nr_live` and `MC_old_live` (no violation in the explored part); and `MC_nr_live_crash` / `_lost`, which haven't been run.

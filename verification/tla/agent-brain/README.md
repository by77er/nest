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
| `LOSS_EPOCH` | host loss releases only at or above `brain.epoch` (off = as built at 6073da7) |
| `START_FAIL` | a refused start's command error releases via `startFailed` (a38d3c0, D1) |
| `SPLIT_EXPIRE`, `EXPIRE_RECHECK` | the tick's expiry split at its await (N1, 6073da7), and its fix |
| `NO_REISSUE` | 82396b3: a start while a non-condemned brain exists answers `none`; an operator restart (`ROpRestart`, under `ALLOW_STOP`) condemns and keeps the intent |
| `NO_ADOPT` | 82396b3: the runner never adopts; a registered brain is ended and the new start registers after it |
| `OLD_HOST` | `NoHost`, or a host running the previous release: seeded with a live brain, drained on sight, never started on, released only on loss, wedged at the 15 min cap (`ROldCap`, 36b60d5) |
| `WAIT`, `TOMBSTONE`, `F`/`E` | mutations |
| `ALLOW_*`, `MaxFaults` | which faults, and how many |

`expect.tsv` lists every config with its expected outcome and whether it is `ci` (under ~3 min with 8 workers) or `full`; `verification/run.sh` reads it. Every `ci` line was run with TLC v1.7.4 (`tla2tools.jar` 1.7.4) and gave the expected result:

```
java -XX:+UseParallelGC -Xmx6g -cp tla2tools.jar tlc2.TLC -workers 8 -metadir <dir> -config <cfg> AgentBrain.tla
```

v1.7.4 writes no trace spec by default and rejects `-noGenerateSpecTE`; the 2026.10.24 nightly needs that flag to avoid writing `AgentBrain_TTrace_*.tla` next to the spec. For a liveness violation, v1.7.4 prints `Temporal properties were violated.` without naming the property, so for `violates:TurnsDrain` / `violates:NoWedge` match that line.

Bounds used by the `MC_e2_*`, `MC_built_*`, `MC_n1_*`, `MC_nr_*` and `MC_old_*` configs: 2 hosts (symmetry, except `MC_old_*`), agent epochs ≤ 2, one turn, `F = 1 < E = 2`, queues ≤ 2/2/3 (`SmallBounds`), one fault of one kind (`MC_nr_restart_wedge`: two). The counterexample configs use epochs ≤ 3 and `Bounds` (3/3/4). `MC_e3_*` use epochs ≤ 3 and `E3Bounds` (`SmallBounds`, and never every host lapsed or expired at once).

Families: `MC_tip_*` = 65bf6ef; `MC_rec_*` = the record design with one fix off; `MC_e2_*` = fully amended (A1-A6); `MC_built_*` = 6073da7 (host-loss release ignores the epoch); `MC_nr_*` = the current design, 82396b3 (no re-issue, never adopt, N1 fixed); `MC_old_*` = the current design with a previous-release host; `MC_e3_*` = the current design at epochs ≤ 3.

Not yet confirmed (marked in `expect.tsv`): `MC_nr_drain` (no violation through BFS depth ~40, 72.2M states, not finished), `MC_old_part`, `MC_old_crash`, `MC_old_live`, the `MC_e3_*` sweep, and the three liveness configs.

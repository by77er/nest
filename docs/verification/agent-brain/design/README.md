# The single-record design (2026-10-25)

The design of the one-brain rule that the [pilot model](../pilot/) checked and the [conformance check](../conformance/) compared against the code, with the amendments TLC counterexamples led to. A dated record: the behaviour as built is stated in [the AgentDO doc](../../../control-plane/durable-objects/agent/), and where they differ, that doc and the code win. "Remove" lines name fields of the earlier `deferred/agent-epoch` design that this one drops.

Invariant S: at most one brain per agent can act (on AgentDO or through a hands binding).
Liveness L: a queued turn eventually runs or fails; an agent never wedges; a healthy host is never wedged.

## AgentDO state (the only authority for "where is this agent's brain")
- `agent_epoch`: counter, the highest epoch ever issued. Bumped only when a start is issued.
- `brain: {host, epoch, phase: "starting" | "live" | "condemned", since_ms} | null`.
- `intent: {host_hint?, avoid?, reason} | null`: a start someone wants (operator, wake, drain). `wake()` and the
  alarm both go through `intent`; nothing else stores start arguments.
- Remove: `host` (derive from `brain`), `awaiting_exit`, `pending_start`, `stop_requested`, the separate
  `inflightStart` bookkeeping beyond a plain in-memory single-flight of the alarm/handler body.

## Rules
1. A session/socket is current iff `brain` is set, `brain.phase != condemned`, and the socket's epoch == `brain.epoch`.
   Everything (hello, tool_call, hands_resolve, events, platform calls after each await) checks this.
2. Start (from `intent`):
   - `brain == null` -> pick host (hint, else the previous host if healthy for a warm session, else any; never `avoid`),
     bump `agent_epoch`, set `brain = {host, epoch, starting}`, issue `agent_start{epoch}`.
   - `brain.host == target` and not condemned -> same-host restart: bump epoch, `brain = {host, new, starting}`,
     issue start (the host's runner serializes; nestd's tombstone/epoch keying covers the old one).
   - otherwise -> condemn: `brain.phase = condemned, since = now` (this fences it at once by rule 1), send
     `agent_stop{kill, epoch: brain.epoch}` once, keep `intent`, return `{waiting_for: host}`.
   - A start with no hint never moves a live brain just to follow its sandbox (brains don't follow sandboxes).
3. Release: `agent_exited{host, epoch}` or host loss (dead/expired) matching `brain.host` with `epoch >= brain.epoch`
   (an epoch-less exit from an old nestd: fill from FleetDO's index row) -> `brain = null`, then run `intent` from the
   alarm. Exits/losses that don't match `brain` are ignored. That is the only way `brain` is cleared, apart from a
   same-host restart replacing it.
4. Escalation for a condemned brain (alarm at since+60 s): ask FleetDO whether the kill command was processed
   (has a result). Not processed -> the host isn't processing commands -> `hostWedged(host)` (stop acking its
   heartbeats; it self-fences at 20 s; expired at 30 s). Processed but no exit -> if FleetDO's index has no row for
   (agent, host, epoch <= brain.epoch) the brain is gone -> release; otherwise keep waiting (old nestd finishing a
   graceful turn) and re-check every 60 s up to a cap (15 min), then wedge. Document the blast radius of a wedge.
5. FleetDO: expire any silent host after 30 s (not only ones with leases or the controller role). A drained/idle
   host that still indexes brains is not "dead by fiat": its brains are killed and released by exit or lease expiry.
6. nestd: brains keyed by (agent, epoch); `AgentStarted` and exits carry the epoch; an event below the entry's epoch
   never removes it; `kill()` never answers "not running" for a brain it merely lost track of. The kill epoch is
   forwarded to the runner, which keeps a tombstone and refuses to register a start at or below it.

## Amendments after model checking (TLC counterexamples, 2026-10-26)
A1 (fixes "healthy host wedged" when the kill is lost before FleetDO stores it): the kill is part of the condemn
   transition, not a one-shot side effect. `brain.phase = condemned` records `kill_cmd: null`; an alarm issues
   `agent_stop{kill, epoch}` idempotently (dedupe key agent+epoch in FleetDO) and records the stored command id;
   it retries until FleetDO has stored it. Rule 4 then distinguishes: no kill stored -> (re)send, never wedge;
   stored but not processed by since+60 s -> wedge; processed -> rule 4's index check.
A2 (fixes "agent waits forever" when onHostLost is lost): rule 4 (and every start) first asks FleetDO for
   brain.host's status; dead or expired (or unknown host row) -> release immediately. And host-loss delivery to
   AgentDO is reliable: FleetDO deletes a host_agents row only after AgentDO acknowledged onHostLost for it,
   retrying from its alarm (origin/deferred/retention-enums dede063 already built this for hostAgentsLost; reuse
   its semantics in brainsLost).
A3 (fixes S violated: an expired host comes back and runs a start issued before its loss was announced; a delayed
   onHostLost then releases the record while that brain lives — TLC, 25 steps, no fault but a slow host):
   a start never outlives a lease lapse or a host expiry.
   (a) nestd refuses, with an agent_exited, every start it holds when its lease lapses and any start that arrives
       while lapsed; the runner drops any registration still waiting.
   (b) FleetDO fails a host's undelivered/unanswered agent_start commands when it expires the host, so the index row
       goes and AgentDO hears (as an exit / startFailed for that epoch).
   (c) issueCommands refuses an agent_start for an expired host, as it does for a dead one.
   Checked: no S violation in 36M distinct states with A1+A2+A3 under host faults (bounded, not exhaustive).
   Alternative not taken: host incarnation numbers on loss notices.
A4 (contract, from the implementer): agent_exited at epoch e from host H means no brain of the agent at or below e
   runs on H; a refused start's exit is held until older brains deregistered.
A4' (TLC: S violated via a lapsed-lease refusal of a same-host restart while the older brain is still exiting):
   A4 covers EVERY refused start — tombstone refusals, A3(a) lapsed-lease refusals, and the runner's no-lease /
   forbidden-tool refusals: a refused start's exit is held until every older brain of the agent on that host has
   deregistered. (TLC: no violation in 67.1M states with A4 on all paths; partial.)
A5 (TLC: S violated, 31 steps): FleetDO's delete-after-ack of a host_agents row is conditional on the row's epoch
   (or cmd) still matching the acknowledged loss notice; a stale ack never deletes a newer start's row.
A6 (same trace): "brain.host is dead" releases only on confirmed death (EC2 terminated / STONITH confirmed) or lease
   expiry; a drain or idle retirement that sets status dead without either is not confirmed death and releases
   nothing (rule 5: drained hosts are not dead by fiat). Prefer a distinct status/flag over trusting the column.
D1 confirmed by TLC: a refused start's command result must not release (answer ok or a non-releasing "refused").

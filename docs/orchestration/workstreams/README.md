# Workstreams (pattern)

A workstream is a **convention**, not a platform object: a goal plus the resources an agent sets up for it. The platform never sees a workstream, only labels.

A captain running workstream `auth` typically creates:
- a channel `ws/auth` holding the goal, the spec and the task board (keyed messages), plus progress;
- sandboxes and workers labeled `workstream=auth`, owned by the captain;
- subscriptions from itself to those workers' and sandboxes' `events`, filtered to the kinds it acts on and batched;
- an egress policy on those sandboxes;
- a budget, carved from its own into each worker's spawn spec (`budget`).

**Stopping a workstream** means listing what it owns with that label, then stopping the agents and destroying the sandboxes.

**The captain decides between attach and fork; the platform imposes neither:**
- **Same sandbox:** a reviewer watching an implementer, a tester hitting a live dev server, or me pairing with an agent. (A captain that reads their output becomes tainted.)
- **Fork:** independent attempts, risky experiments, or anything that might be thrown away.

Any other grouping works the same way, since labels are free-form.

## The interim workstream channel

**Decision (2026-10-26): WorkstreamDO is the interim implementation of the workstream channel `ws/<label>`, not a platform object.** Channels (ChannelDO) aren't built, and today's agents, sandboxes and egress policy still group by a `ws_` id, so it stays until channels replace it; nothing new is built on it.

- **What it is:** a channel keyed by the workstream label, with a log of events (`progress`, `blocked`, `pr_opened`, `needs_input`, …, from agents' `emit`, asks and sandboxes' host events), one **subscriber** woken with a batch of decision events (the design's subscription with a batch window), and the user-notification queue (the `user` channel's stand-in).
- **No roles in it:** the subscriber is whichever agent subscribed: one spawned from a template with `subscribe: [workstream]` (the seeded `captain`), or one I set (`PUT /v1/workstreams/<id>/subscriber`, which must name an agent). The previous release's `captain` field and route are read as the subscriber for one release.
- **Evidence for keeping it:** ChannelDO, subscriptions and wake envelopes aren't built ([control-plane/](../../control-plane/durable-objects/channel/)); the `workstream` egress policy layer, sandbox events and BrokerDO's per-workstream injection secrets all key on the `ws_` id, so removing it now would leave events and asks with nowhere to go.
- **Path to channels:** when ChannelDO lands, `ws/<label>` becomes an ordinary channel; the subscriber becomes a subscription; `emit` and `needs_input` become posts with a `kind`; the notification queue becomes `user`; `escalate_to: workstream` names the channel; `ws_` ids become `workstream=<label>` labels ([pending contract changes](../../interfaces/#pending-contract-changes)), and WorkstreamDO goes. The catalog's values that name it (`escalate_to: workstream`, `subscribe: [workstream]`) and agents' stored specs then need a data migration to the channel's name.

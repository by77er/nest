# Workstreams (pattern)

A workstream is a **convention**, not a platform object: a goal plus the resources an agent sets up for it. The platform never sees a workstream, only labels.

A captain running workstream `auth` typically creates:
- a channel `ws/auth` holding the goal, the spec and the task board (keyed messages), plus progress;
- sandboxes and workers labeled `workstream=auth`, owned by the captain;
- subscriptions from itself to those workers' and sandboxes' `events` (decision kinds only, batched);
- an egress policy on those sandboxes;
- a budget, carried by the grant limits it gives its workers.

**Stopping a workstream** means listing what it owns with that label, then stopping the agents and destroying the sandboxes.

**The captain decides between attach and fork; the platform imposes neither:**
- **Same sandbox:** a reviewer watching an implementer, a tester hitting a live dev server, or me pairing with an agent. (A captain that attaches reads untrusted content and becomes tainted.)
- **Fork:** independent attempts, risky experiments, or anything that might be thrown away.

Any other grouping works the same way, since labels are free-form.

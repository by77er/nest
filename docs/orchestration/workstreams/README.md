# Workstreams

A workstream has a goal, a spec, a branch and a budget. It owns a set of agents and sandboxes. Its authority is [WorkstreamDO](../../control-plane/durable-objects/workstream/).

**Normalized events:** `started`, `progress`, `needs_input`, `blocked`, `pr_opened`, `completed`, `failed`, `budget_exceeded`, `quota_parked`, `orphaned_work`, `egress_denied`, `egress_alert`, `port_opened`, `port_exposed`. They carry `(sandbox, epoch)` when they come from a sandbox. The authoritative list is `WorkstreamEventKind` in `crates/nest-protocol/src/model.rs`.

**The captain decides between attach and fork; the platform imposes neither:**
- **Same sandbox:** a reviewer watching an implementer, a tester hitting a live dev server, or me pairing with an agent. (Captains inspect through `delegate`, never by attaching.)
- **Fork:** independent attempts, risky experiments, or anything that might be thrown away.

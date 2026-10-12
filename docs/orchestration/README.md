# Orchestration

Captains and workstreams, built from the four primitives (sandbox, agent, attach, fork). The model is inspired by Capy's Captain/Build split: one agent plans and delegates, and others build in parallel sandboxes. Here, though, captains are long-lived, driven by events, and manage several workstreams.

- [captains/](captains/): assistants that manage workstreams and escalate to me
- [workstreams/](workstreams/): units of work, with their events
- [scheduling/](scheduling/): treating subscription quota as a resource

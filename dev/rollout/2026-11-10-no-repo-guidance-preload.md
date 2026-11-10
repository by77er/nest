# The runner no longer pre-loads a repo's CLAUDE.md (2026-11-10)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Ordering constraint.** The runner's `SessionStart` hook stops reading the sandbox's `CLAUDE.md` through hands and passing it to the model: nest loads none of a repo's guidance, which is the client's to ask for. A client whose agents relied on the pre-load must first tell them to read the repo's guidance themselves (in its template's prompt, or each task), and that change must be live before hosts take this release. The projects app is such a client: its manager and worker prompts must tell agents to read the repo's guidance when a session starts, a resumed one included (a worker that resumes in its clone got the guidance from the pre-load), and that change ([#223](https://github.com/by77er/nest/pull/223)) merges and deploys before this one merges.

- **Not a one-way deploy.** No stored state, wire field, route or DO method changes. `SessionStart` still answers in the same shape (now always `{}`), and the managed settings give its hook 10 s instead of 20 s.
- **Hosts one release behind:** an old runner still pre-loads `CLAUDE.md`; a new one doesn't. An agent told to read the guidance itself reads it either way, so the order above is the only constraint.
- **What a rollback does:** the previous runner reads `CLAUDE.md` again at each brain start. An agent then sees the guidance twice (pre-loaded, and read on its client's instruction): harmless.
- **Cloud check:** start an agent with hands on a repo with a `CLAUDE.md`. Its first turn's transcript has no `SessionStart` context naming `CLAUDE.md`, and the gateway's log has no hands call before the turn's first tool call.

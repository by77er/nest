# An end's destroy_sandbox reaches what its ender may destroy (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, route or host change. `SandboxDO.release` takes an optional third argument, `by`. An agent's `ended` record gains an optional `destroy_asked: true` when the ender asked for `destroy_sandbox` itself.
- **In the gap after the deploy:** if AgentDO is new and SandboxDO still old, the old SandboxDO ignores `by` and applies today's rule: only a sandbox made for the agent is destroyed. If SandboxDO is new and AgentDO still old, the old AgentDO sends no `by`, with the same result.
- **Ends recorded before this release:** they have no `destroy_asked`, so finishing one sends no `by`. These ends also keep today's rule.
- **What a rollback does:** the previous release ignores `destroy_asked` and sends no `by`. Ends finished after the rollback keep today's rule, and a sandbox already destroyed stays destroyed. Nothing stored is read differently.

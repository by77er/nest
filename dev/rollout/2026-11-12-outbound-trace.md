# Outbound requests on the live trace (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No table, column, route or host wire field. The live trace gains one event type, `outbound`: AgentDO writes one into its existing ring for each request a brokered action or a remote MCP tool sends.

- **Trace clients:** a client that doesn't know `outbound` skips it. The projects app's trace view renders nothing for an unknown type.
- **The ring's capacity:** the 1,000-event bound is unchanged, so an agent that makes many such requests keeps less of its older history in the ring. That history stays readable through the trace history, which reads the transcript.
- **What a `wrangler rollback` does with what this release wrote:** the previous release writes no more `outbound` events. It replays the ones already in the ring to trace sockets as they are stored, and its history seam reads only the transcript's types. Nothing breaks.
- **No shim to drop.**

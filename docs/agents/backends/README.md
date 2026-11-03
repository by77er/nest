# Brain backends

```ts
interface Backend {
  runTurn(agent: AgentRef, input: TurnInput, ctx: TurnContext): AsyncIterable<CanonicalEvent>;
  interrupt(agentId: string, turnId: string): Promise<void>;
}
// ctx.executeTool(name, input, callKey) → the shared registry in the DO
// callKey = (agent, turn_id, per-turn sequence) → idempotency
```

| Backend | Inference | Runs | Billing | Status |
|---|---|---|---|---|
| [claude-code/](claude-code/) | Claude Code, run by the agent runner | A [brain host](../../compute/brain-hosts/), with or without hands | Subscription (flat) | **Current** |
| [api-loop/](api-loop/) | Messages API tool loop | Inside AgentDO; any agent, with hands through the [gateway](../../sandbox/gateway/) | API key (per token) | Designed; deferred until the API credits are picked up |

- **Chosen per agent** in the spawn spec (`backend`), along with model and effort.
- **Mixing is just two agents:** for example, a cheap `api-loop` triage agent decides whether to post to a `claude-code` agent's inbox.
- **Rules that keep `api-loop` possible:**
  - Tool handlers, prompts and templates live only in the control plane. The host side is a dumb runner plus a generic MCP bridge.
  - One tool registry, defined once; both backends use the same schemas and handlers.
  - Continuity lives in memory (read by key), not in the backend's history. A backend's own session (a Claude Code JSONL file or a Messages API journal) is a cache. Switching backends starts a fresh session; histories are never translated.
  - **Canonical events:** each backend maps its output to `turn_started`, `assistant_text`, `tool_call`, `tool_result`, `turn_completed`, `rate_limited`, `error`, `usage`. Transcripts, state tracking, owner events and the scheduler consume only those.
  - Backend concerns stay inside backends: context management, thinking and effort, credentials, quota vs budget.
- **Conformance test:** the same scripted scenario (mock model, scripted tool calls, hands calls through a gateway) runs against both backends and must produce the same canonical events and DO state.

# Captain backends

```ts
interface CaptainBackend {
  runTurn(captain: CaptainRef, input: TurnInput, ctx: TurnContext): AsyncIterable<CanonicalEvent>;
  interrupt(captainId: string, turnId: string): Promise<void>;
}
// ctx.executeTool(name, input, callKey) → the shared registry in the DO
// callKey = (captain, turn_id, per-turn sequence) → idempotency
```

| Backend | Inference | Runs | Billing | Status |
|---|---|---|---|---|
| [claude-code/](claude-code/) | Claude Code with no tools, run by the agent runner | Controller host | Subscription (flat) | **Current** |
| [api-loop/](api-loop/) | Messages API tool loop | Inside AgentDO | API key (per token) | Future, for pure Cloudflare |

- **Chosen per captain** with `backend: claude-code | api`, plus model and effort settings.
- **Mixing is possible:** for example, a cheap API triage step that decides whether to wake a `claude-code` captain at all.
- **Conformance test:** the same scripted scenario (mock model, scripted tool calls) runs against both backends and must produce the same canonical events and DO state.

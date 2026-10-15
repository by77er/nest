# api-loop backend (future: pure Cloudflare)

A hand-written Messages API tool loop running inside the agent's AgentDO, authenticated with an API key held by the control plane. The terms require an API key for custom loops. Only agents without hands can use it: their tools all run in the control plane, so no host is needed.

```
loop: messages.stream(system=<spawn spec prompt>, tools=registry ∩ grants, messages=journal)
      → append response to the journal (DO storage) → run tool_use blocks via ctx.executeTool → append results
until end_turn
```

- **Durable:** every model response and tool result is journaled *before* the next step. After an eviction the loop resumes from the last step. Use a hand-written loop rather than the SDK's Tool Runner, which keeps its state in memory.
- **The history must be append-only.** Newer models reject edited earlier turns (preserved thinking), and the journal is append-only by construction.
- **Context:** server-side compaction, context editing (clearing old tool results), and DO-backed memory.
- **Caching:** a frozen system prompt and tool list. Use a 1-hour TTL, since wakes are often more than 5 minutes apart.
- **Refusals:** server-side refusal fallback (`fallbacks: "default"`) on by default.
- **Cost (rough, a busy captain-style agent at ~30 wakes/day and ~40k tokens of context):**

| Model | Approximate cost per month |
|---|---|
| Opus 5.5 | ~$300 |
| Sonnet 5.5 | ~$150 |
| Haiku 5.5 | ~$10 |

Narrow subscription filters, delegating reading, and a triage agent all cut this substantially. This cost is why `claude-code` is the current backend.

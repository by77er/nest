# api-loop backend (deferred: pure Cloudflare)

A hand-written Messages API tool loop running inside the agent's AgentDO, authenticated with an API key held by the control plane. The terms require an API key for custom loops. Any agent can use it: platform tools run in the control plane, and hands go from the DO to the sandbox's [gateway](../../../sandbox/gateway/) over the network, so the brain needs no host at all.

**Status:** designed, not scheduled. It waits until the API credits are picked up; the gateway, the tunnel and brain hosts come first.

```
loop: messages.stream(system=<spawn spec prompt>, tools=registry ∩ grants, messages=journal)
      → append response to the journal (DO storage) → run tool_use blocks via ctx.executeTool → append results
until end_turn
```

- **Durable:** every model response and tool result is journaled *before* the next step. After an eviction the loop resumes from the last step. Use a hand-written loop rather than the SDK's Tool Runner, which keeps its state in memory.
- **The history must be append-only.** Newer models reject edited earlier turns (preserved thinking), and the journal is append-only by construction.
- **Hands:** `ctx.executeTool('Bash', input)` opens one outbound WebSocket per call to the gateway (an upgrade `fetch`, then `accept()`; [Workers WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets/)), sends the binding and then the hands frames, and closes to cancel. A 16 MiB hands frame fits under the 32 MiB a Worker or Durable Object accepts per message, so nothing is chunked. Outgoing WebSockets do not hibernate, and an open one keeps the object in memory for up to 15 min ([WebSockets in Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)); hands calls are capped at 10 min, under that hold. At 128 MB billed while active, with 400,000 GB-s a month included and $12.50 per million GB-s past that ([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)), an agent spending two hours a day inside hands calls uses about 27,000 GB-s a month, inside the included amount. A Worker invocation may have six connections awaiting response headers at once, and an open WebSocket stops counting after its handshake ([limits](https://developers.cloudflare.com/workers/platform/limits/)), so parallel hands calls are bounded by the guest's admission caps, not by the DO. Background tasks are the way to run long work. The DO's hands client is the TypeScript half of one library with the runner's Rust crate, tested against the same fixtures ([gateway contract](../../../interfaces/gateway/)). A hibernating variant, where the gateway dials AgentDO so the DO sleeps between frames, is the fallback if DO duration ever shows in the bill: it inverts the seam, since the sandbox system would learn the agent's DO, and the saving rounds to zero.
- **Context:** server-side compaction, context editing (clearing old tool results), and DO-backed memory.
- **Caching:** a frozen system prompt and tool list. Use a 1-hour TTL, since wakes are often more than 5 minutes apart.
- **Refusals:** server-side refusal fallback (`fallbacks: "default"`) on by default.
- **Cost (rough, a busy captain-style agent at ~30 wakes/day and ~40k tokens of context):**

| Model | Approximate cost per month |
|---|---|
| Opus 5.5 | ~$300 |
| Sonnet 5.5 | ~$150 |
| Haiku 5.5 | ~$10 |

Fewer wakes, delegating reading, and a triage agent all cut this substantially. This cost is why `claude-code` is the current backend.

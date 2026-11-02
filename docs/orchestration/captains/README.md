# Captains (pattern)

A captain is a long-lived agent without hands, a brain on a [brain host](../../compute/brain-hosts/) with no sandbox, that manages other agents and asks me when it must. **It isn't a platform concept:** it's an agent spawned from the `captain` template, and everything that makes it a captain is in that template's prompt, grants and budget.

## The `captain` template

```yaml
launch:
  system_prompt: {mode: replace, text: <captain prompt, stored in the control plane>}
  builtin_tools: []                  # web access comes from the `web` capability
hands: null
backend: claude-code                 # api-loop once it lands (deferred)
capabilities:                        # on resources it owns; see agents/capabilities/
  - coordination                     # an MCP integration: messaging, a shared log, a board (principle 9)
  - spawning{budget: {depth: 2, concurrent: <the brain concurrency cap>, spawns: 20/day}}
  - sandboxes                        # egress_policy is a sink: approve when tainted
  - authority                        # granting sinks: approve when tainted
  - transcripts
  - memory
  - schedules                        # its own wakes (wake_at)
priority: high
credential: claude_oauth_token:captain   # revocable separately from workers
```

**Built so far:** the seeded `captain` template ([CatalogDO](../../control-plane/durable-objects/catalog/)): the interim `transcripts`, `sandboxes`, `brokered`, `management` and `memory` capabilities (most of their tools answer `not_implemented`; see [tools](../../agents/tools/)), a replaced prompt with no built-ins, `hands: forbidden` and `credential: claude_oauth_token:captain`; a new catalog's also lists `spawning` (`agent_spawn` from `worker`, `agent_stop` on what it spawned: [lifetimes](../../agents/#lifetimes)), and a worker it spawns `ephemeral` ends itself when its task's turn is done. The other capabilities above aren't built.

## Conventions in its prompt

- **One agent first.** Multi-agent setups win on parallel, read-heavy work and lose on sequential work: one study measured +81% on parallelizable tasks and −39% to −70% on sequential ones ([2025-12](https://arxiv.org/abs/2512.08296)), and Anthropic calls its multi-agent research design a poor fit for most coding ([2025-06](https://www.anthropic.com/engineering/multi-agent-research-system)). The captain spawns more agents only for independent, mostly read-only work.
- **One writer per sandbox.** Parallel writers still fail; what works is single-threaded writes plus forks ([Cognition, 2026-04](https://cognition.com/blog/multi-agents-working)).
- **A reviewer with a clean context** checks finished work. Agents grade their own work too kindly ([Anthropic, 2026-03](https://www.anthropic.com/engineering/harness-design-long-running-apps)), and missing verification is the largest failure class in [MAST](https://arxiv.org/abs/2503.13657).
- **Every spawn prompt says when the work counts as done,** since not knowing when to stop is a top failure mode (MAST).
- **Grouping its work:** per piece of work, a shared log in its coordination app, plus the sandboxes and workers it owns; workers report there (blocked, PR open, done), and the app delivers what needs the captain to its inbox, batched. Stopping the work means stopping the agents it owns for it and destroying their sandboxes.
- **Attach or fork is its call:** the same sandbox for a reviewer watching an implementer or a tester hitting a live dev server (a captain reading their output becomes tainted); a fork for independent attempts and anything that might be thrown away.
- **Staying clean:** a captain that reads worker output becomes [tainted](../../agents/tools/#taint-and-sinks), and its sink calls then need my approval. It can stay clean on **quarantined reports** (a `report_schema` of enums, numbers and ids). How it gets details beyond those is its own call: nothing ships for it, though read-only forks and report schemas exist.
- **Continuity:** its memory, read by key at each wake. The Claude Code session is a cache, so a fresh session or a backend switch loses nothing.
- **Escalation:** it answers its workers' questions itself when it holds the grant they ask for and is untainted, and asks me otherwise.

## Safeguards

- A captain acts only through tool calls bounded by its grants, its budget and its taint; all three are bounded by mine.
- Its workers get only grants and budget it holds; the `worker` template gives agents with hands no management capabilities (no `spawning`, `sandboxes` or `authority`).
- It can use a separate setup token from workers (`credential` above).
- `priority: high` reserves subscription headroom for it.

Its backend is per agent. See [../../agents/backends/](../../agents/backends/).

# Orchestration (patterns)

> **Leaving the platform (stages 2 and 3):** the channels, WorkstreamDO and `notify`/`ask`/`emit` these patterns use become external integrations over MCP and the public API ([principle 9](../README.md#principles)); the task ledger already left. The patterns stay; their tools move.

**Orchestration isn't a platform layer.** Captains, workstreams, review loops, pipelines and swarms are patterns: agents build them from the [primitives](../README.md#primitives) by spawning, granting, posting and subscribing. The platform ships **templates** (named spawn specs) that seed the common patterns, and no code knows about any of them.

**Why:** hand-coded orchestration ages badly as models improve ([the bitter lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)). A structure in a prompt changes when I edit text, or when an agent decides to; a structure in code needs a release. Anthropic's harness work found the same: "every component in a harness encodes an assumption", and components were removed as models improved ([2026-03](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**What the platform keeps:** primitives, plus the hard limits a structure can't talk its way past: grants, budgets, taint, and loop guards on channels.

## Example structures

| Structure | Built from |
|---|---|
| Captain running workstreams | An agent without hands (`captain` template). Per workstream: a channel, sandboxes, and workers labeled `workstream=<name>` whose events it subscribes to |
| Reviewer watching an implementer | Two agents attached to one sandbox; the reviewer subscribes to the implementer's `events` |
| Pipeline | Agent A posts results to `stage-1`, which agent B subscribes to |
| Swarm | N workers on forks of one sandbox, taking tasks from a shared board: an external tracker they all reach over MCP, where each worker claims an unassigned task with a compare-and-set (so two never take the same one) and moves its own, or a captain assigns instead. Without an oracle splitting the work, swarms pile onto the same problem ([Anthropic's C compiler, 2026-02](https://www.anthropic.com/engineering/building-c-compiler)) |
| Me pairing with an agent | Its inbox (from Discord), and `nest attach` to its sandbox |
| Triage in front of an expensive agent | A cheap agent subscribed to a busy channel, posting only what matters to the other's inbox |
| Monitor | A long-lived agent with memory, subscribed to the channels or events it watches (CI hooks, a sandbox's ports), or polling a feed with `wake_at`, posting to `user` or a captain when something needs attention |
| Personal assistant | A long-lived agent with memory, bridged to Discord, that answers me and spawns ephemeral workers for tasks |
| Repo maintenance | A maintainer spawning a worker per task and a clean-context reviewer per PR, merging through the repo's own gates, with a monitor watching what ships |

## Components

- [captains/](captains/): the `captain` template, and the conventions in its prompt
- [workstreams/](workstreams/): a convention for grouping work under a label
- [repo-maintenance/](repo-maintenance/): agents that propose, review and merge changes to a repo and watch what ships
- [scheduling/](scheduling/): subscription quota as a resource. This one is platform mechanism.

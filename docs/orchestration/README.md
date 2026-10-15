# Orchestration (patterns)

**Orchestration isn't a platform layer.** Captains, workstreams, review loops, pipelines and swarms are patterns: agents build them from the [primitives](../README.md#primitives) by spawning, granting, posting and subscribing. The platform ships **templates** (named spawn specs) that seed the common patterns, and no code knows about any of them.

**Why:** hand-coded orchestration ages badly as models improve ([the bitter lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)). A structure in a prompt changes when I edit text, or when an agent decides to; a structure in code needs a release.

## Example structures

| Structure | Built from |
|---|---|
| Captain running workstreams | An agent without hands (`captain` template). Per workstream: a channel, sandboxes, and workers labeled `workstream=<name>` whose events it subscribes to |
| Reviewer watching an implementer | Two agents attached to one sandbox; the reviewer subscribes to the implementer's `events` |
| Pipeline | Agent A posts results to `stage-1`, which agent B subscribes to |
| Swarm | N workers on forks of one sandbox, sharing a board: a channel read by key |
| Me pairing with an agent | Its inbox (from Discord), and `nest attach` to its sandbox |
| Triage in front of an expensive agent | A cheap agent subscribed to a busy channel, posting only what matters to the other's inbox |

## Components

- [captains/](captains/): the `captain` template, and the conventions in its prompt
- [workstreams/](workstreams/): a convention for grouping work under a label
- [scheduling/](scheduling/): subscription quota as a resource. This one is platform mechanism.

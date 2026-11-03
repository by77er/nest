# Orchestration (patterns)

**Orchestration isn't a platform layer.** Captains, task boards, review pipelines, swarms and any other structure are built by **external apps** that agents reach over MCP and that drive agents through the public API ([principle 9](../README.md#principles)). The kernel gives them [primitives](../README.md#primitives): sandboxes, agents (spawning, ownership, the inbox, lifecycle), the credential broker and egress policy, MCP tool attachment, approvals, and scoped [API clients](../control-plane/api/clients/) with labels and events to the owner. No kernel code knows about any structure. The platform seeds **templates** (named spawn specs) for the common ones.

**Why:** hand-coded orchestration ages badly as models improve ([the bitter lesson](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)). A structure in a prompt or an app changes without a platform release. Anthropic's harness work found the same: "every component in a harness encodes an assumption", and components were removed as models improved ([2026-03](https://www.anthropic.com/engineering/harness-design-long-running-apps)).

**What the kernel keeps:** the hard limits a structure can't talk its way past: grants, budgets, taint and approvals.

## How an app plugs in

- **Tools:** the app is a remote MCP server; a [capability](../agents/capabilities/mcp/) attaches its tools to an agent's spec, with credentials from BrokerDO.
- **Delivery:** the app reaches an agent through its inbox (`POST /v1/agents/<id>/inbox`), which wakes it, and reads what it needs over the API (transcripts, turns, the live trace).
- **Hearing back:** agents the app creates as an API client report to it by webhook (turns completed, exits, asks, errors: [events to the owner](../control-plane/api/clients/#events-to-the-owner)). An agent that spawns agents hears nothing from them automatically: its tasks say where to report.
- **Grouping:** the app keeps its own records of which agents and sandboxes belong to what; the kernel's grouping is ownership (an agent or client owns what it creates) and labels.

## Example structures

| Structure | Built from |
|---|---|
| Captain | An agent without hands (`captain` template) that spawns and stops workers it owns, coordinating through an app (a shared log, a board) |
| Reviewer watching an implementer | Two agents attached to one sandbox; the app tells the reviewer when there is something to review |
| Pipeline | An app's queue that delivers each result to the next agent's inbox |
| Swarm | N workers on forks of one sandbox, taking tasks from an app's board with a compare-and-set claim, or assigned by a captain. Without an oracle splitting the work, swarms pile onto the same problem ([Anthropic's C compiler, 2026-02](https://www.anthropic.com/engineering/building-c-compiler)) |
| Me pairing with an agent | Its inbox (over the API, or through an app), and `nest attach` to its sandbox |
| Monitor | A long-lived agent with memory, fed what it watches by an app (CI webhooks into its inbox) or polling with `wake_at` |
| Repo maintenance | A maintainer spawning a worker per task and a clean-context reviewer per PR, merging through the repo's own gates |

## Components

- [captains/](captains/): the `captain` template, and the conventions in its prompt
- [repo-maintenance/](repo-maintenance/): agents that propose, review and merge changes to a repo and watch what ships
- [scheduling/](scheduling/): subscription quota as a resource. This one is platform mechanism.

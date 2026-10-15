# Capabilities

A capability is a **named, pluggable bundle**: the tools an agent gets, the grants those tools need, and a short prompt section on using them. Spawn specs and templates list capabilities, and the platform expands them into the agent's tool list, its grants (attenuated against the spawner's) and its system prompt. Messaging, channels, spawning and memory are all capabilities, so a template is a composition, not code.

**Why:** grants say what's allowed, not what an agent is equipped and told to do. A bundle keeps the three together, so turning messaging on is one line, and the same unit plugs into any template. It's the shape of Claude Code's plugins and skills: tools plus instructions.

## Definition

```yaml
capability: messaging
params:  {peers: label:<key> | tree | any}
tools:   [message]                          # from the platform tool registry, or Claude Code built-ins
grants:  [post on agent{<peers>}/inbox]     # expanded from params
prompt:  |                                  # added to the system prompt
  To reach a peer, use `message`. …
```

- **Data, not code:** capabilities are stored in the control plane and edited by me, like templates. Composing existing tools into a capability is data; a new tool needs code (the tool registry).
- **Attenuation:** a spawn spec can enable a capability only if the spawner holds every grant it expands to, with parameters no wider than its own.
- **Always present, not capabilities:** an agent's own inbox and `events`, and posting questions to its escalation channel.
- **Prompt sections** are part of the launch config, so edits reach resumed brains (`--system-prompt-snapshot off`, see [runner](../runner/)).

## Built-in capabilities

| Capability | Tools | Grants it expands to |
|---|---|---|
| `hands{sandbox}` | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskOutput`, `TaskStop` | `attach` on that sandbox |
| `messaging{peers}` | `message` | `post` on the peers' inboxes |
| `channels` | `channel_create`, `post`, `read`, `subscribe`, `unsubscribe` | its own channels; others by extra grants |
| `memory` | `post` and `read` on its private keyed channel | that channel; the key index is injected at session start |
| `spawning{budget}` | `agent_spawn`, `agent_stop`, `adopt`, `list` | spawning within the budget |
| `sandboxes` | `sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy` | its own sandboxes |
| `authority` | `grant`, `revoke` | granting what it holds; sink grants are `approve` when tainted |
| `transcripts` | `read_transcript` | agents it owns |
| `brokered{actions}` | e.g. `github.create_pr` | each action, scoped by its binding |
| `web` | `WebSearch`, `WebFetch` (Claude Code built-ins) | none; results set [taint](../tools/#taint-and-sinks) |

**Templates compose them.** For example:

```yaml
worker:  [hands, messaging{peers: label:workstream}, memory, web, brokered{actions: [github.create_pr]}]
captain: [channels, messaging{peers: tree}, spawning{budget}, sandboxes, authority, transcripts, memory]
```

## Messaging

`message(agent, text, await_reply_s?, interrupt?)` posts to the agent's inbox. It's `post` addressed by agent id, so replies (`reply_to`), `await_reply_s`, taint, wake envelopes and loop guards all work as for any [channel](../../channels/).

- **Default reach is the label group.** With `peers: label:<key>`, an agent can message its owner and every agent with the same value of `<key>` (e.g. everyone with `workstream=auth`). The template picks the key. `tree` (owner and children) and `any` (every agent it knows the id of) are the alternatives.
- **Labels set reach,** so the spawner sets them at spawn time, and changing an agent's labels needs a grant on it.
- **Injection spread is a group, not a tree:** a tainted agent can reach its whole group. Every message carries the sender's taint, wake envelopes carry no bodies, and loop guards and rate limits bound the traffic.

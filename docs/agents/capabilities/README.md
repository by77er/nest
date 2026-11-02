# Capabilities

A capability is a **named, pluggable bundle**: the tools an agent gets, the grants those tools need, and a short prompt section on using them. Its tools come from the platform, from an **MCP server**, or from an **API** with read-only or read-write access, and they all reach the agent the same way: as tools. Spawn specs and templates list capabilities, and the platform expands them into the agent's tool list, its grants (attenuated against the spawner's) and its system prompt. Messaging, channels, spawning and memory are all capabilities, so a template is a composition, not code.

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

- **Data, not code:** capabilities are stored in the control plane ([CatalogDO](../../control-plane/durable-objects/catalog/)) and edited by me, like templates. Adding an MCP server or an API is data too; only a new *platform* tool needs code (the tool registry).
- **Attenuation:** a spawn spec can enable a capability only if the spawner holds every grant it expands to, with parameters no wider than its own.
- **Parameters (designed, not built):** a capability declares the parameters its tools read; the template gives defaults and the operator gives values at spawn, and the agent's spec records them. The only one built, the task ledger's `ledger`, left with it ([principle 9](../../README.md#principles)).
- **Always present, not capabilities:** an agent's own inbox and `events`, and posting questions to its escalation channel.
- **Prompt sections** are part of the launch config, so edits reach resumed brains (`--system-prompt-snapshot off`, see [runner](../runner/)).
- **Built so far:** `builtin` tools, with channel grants on the capability (`grants`, [CatalogDO](../../control-plane/durable-objects/catalog/)), the `mcp` source ([mcp/](mcp/): a bearer token, the allowlist, idempotency overrides, the trust flag and per-server caps; AgentDO is the MCP client, and a connector per server shares the tool list and admits calls) and the `brokered` source ([brokered/](brokered/): GitHub actions scoped to repos, `http.request` profiles). `api` isn't built. The seed has `channels`, `messaging-tree` (`messaging{peers: tree}`), `egress` and `spawning`; no parameter is built (`peers: label:<key>`, `any`), so a wider reach is a capability with a wider pattern (`post` on `agt_*/inbox`).

## Sources

Every capability's tools run in the control plane or behind it, so credentials stay in BrokerDO, calls go through one pipeline, and both backends (`claude-code`, `api-loop`) get the same tools.

| Source | Tools it surfaces | Credentials | Sinks |
|---|---|---|---|
| `builtin` | Platform tools from the registry (below) | None | Per tool |
| `mcp{url, auth, tools?, idempotent?, read_only?, trusted?, when_tainted?, max_concurrent?, per_minute?}` | A remote MCP server's tools ([Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)), listed by the control plane and filtered by an allowlist; see [mcp/](mcp/) | A bearer token or [OAuth](mcp/#oauth) tokens in BrokerDO; the control plane is the MCP client | A tool is a sink unless the operator marks it `read_only`, or a `trusted` server marks it `readOnlyHint` ([tool annotations](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), which clients must treat as untrusted from an untrusted server); see [mcp/](mcp/#sinks) |
| `api{base_url, mode, paths?, auth}` | One tool, `<capability>_request(method, path, query?, body?)` | In BrokerDO; the control plane attaches it to each request | `mode: ro` allows only `GET` and `HEAD` and isn't a sink; `mode: rw` is |
| `brokered[{action, repos? \| profile…, when_tainted?, per_hour?}]` | One tool per granted action (`github_comment`, `http_request`, …) and `brokered{action, args}`; see [brokered/](brokered/) | The GitHub App (`github_app`) mints a token per call's repo; a profile's `http:<name>` secret is attached by the control plane | GitHub writes are sinks: `allow` when tainted if scoped to repos, `approve` if not (the defaults); a profile is a sink unless it allows only `GET`/`HEAD` |

```yaml
capability: github_ro
source: api{base_url: https://api.github.com, mode: ro, paths: [/repos/me/], auth: cap:github_ro}
prompt: Read-only GitHub REST access to my repos, through `github_ro_request`.

capability: tracker
mcp: {url: https://mcp.example.com/mcp, auth: cap:tracker, tools: [list_issues, get_issue, create_comment], read_only: [list_issues, get_issue]}
prompt: The issue tracker: read freely; comment only when asked.
```

- **Same pipeline as brokered actions:** every call checks the grant and taint, rate-limits, scans arguments for secrets, gets approval if it's a sink from a tainted session, and is journaled.
- **Results are untrusted:** every result from an `mcp` or `api` tool sets [taint](../tools/#taint-and-sinks), like web results, unless the operator marks the capability `trusted: true`. An untrusted `mcp` server's tool list taints too: its descriptions reach the model ([mcp/](mcp/#taint)).
- **`ro` means no state changes, not no leaks:** requests go only to the configured base URL and path prefixes, so data can reach only that API's operator.
- **Attenuation:** a spawner can pass on a narrower version of a capability (fewer tools, `ro` instead of `rw`, fewer paths), never a wider one.
- **MCP servers are remote only.** Hosts never run third-party MCP servers, and neither do guest agents: brains reach these tools only through `nest mcp` → AgentDO → the server. A server that has to run locally (a browser, a database client) runs as a service in a sandbox and is exposed through [ingress](../../sandbox/networking/ingress/) as an `mcp{url}` endpoint. Tools appear to Claude Code as `mcp__nest__<capability>_<tool>`, and the allowlist keeps a large server from flooding the context.

## Built-in capabilities

| Capability | Tools | Grants it expands to |
|---|---|---|
| `hands{sandbox}` | `Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TaskOutput`, `TaskStop` | `attach` on that sandbox |
| `messaging{peers}` | `message` | `post` on the peers' inboxes |
| `channels` | `channel_create`, `post`, `read`, `subscribe`, `unsubscribe` | its own channels; others by extra grants |
| `memory` | `post` and `read` on its private keyed channel | that channel; the key index (at most 200 keys) is injected at session start, and a weekly wake asks for consolidation. **Only for long-lived agents** (see [continuity](../#continuity)) |
| `spawning{budget}` | `agent_spawn`, `agent_stop`, `attach`, `adopt`, `list` | spawning within the budget. Built as the seeded `spawning` (`agent_spawn`, `agent_stop`); the templates it spawns from are its `spawn` list (`worker`), and fixed depth and live-children caps stand in for the budget ([spawning](../#spawning)) |
| `sandboxes` | `sandbox_create`, `sandbox_fork`, `sandbox_destroy`, `checkpoint`, `expose_port`, `egress_policy` | its own sandboxes; built: `egress_policy` on the bound sandbox, seeded alone as `egress` (no seed template lists it) |
| `authority` | `grant`, `revoke` | granting what it holds; sink grants are `approve` when tainted |
| `transcripts` | `read_transcript` | agents it owns |
| `hooks` | `hook_create(channel, verify, filter?, map?)` → URL, `hook_delete`, `list` | hooks posting to channels it can post to; it never sees their secrets (see [sources](../../channels/sources/)) |
| `schedules` | `wake_at(at \| every, note)` → id, `wake_cancel(id)` | waking itself, within its turn budget |
| `brokered{actions}` | e.g. `github.create_pr` | each action, scoped by its binding; built as the `brokered` source ([brokered/](brokered/)) |
| `web` | `WebSearch`, `WebFetch` (Claude Code built-ins) | none; results set [taint](../tools/#taint-and-sinks) |
| `metrics` | `metrics_query(sql)` over nest's own [runtime metrics](../../control-plane/metrics/) | reading them; results hold only numbers, enums and ids, so they don't taint |

**Templates compose them,** with any `mcp` or `api` capability alongside. For example:

```yaml
worker:    [hands, messaging{peers: label:workstream}, web, github_ro, brokered{actions: [github.create_pr]}]   # ephemeral: no memory
captain:   [channels, messaging{peers: tree}, spawning{budget}, sandboxes, authority, transcripts, memory, schedules, hooks]
monitor:   [channels, messaging{peers: tree}, memory, schedules, hooks, web]   # long-lived: watches hooks, channels or the web; add `metrics` to watch nest itself
assistant: [channels, messaging{peers: tree}, spawning{budget}, memory, schedules, web]  # long-lived: talks to me through `user`
```

## Messaging

`message(agent, text, await_reply_s?, interrupt?)` posts to the agent's inbox. It's `post` addressed by agent id, so replies (`reply_to`), `await_reply_s`, taint, wake envelopes and loop guards all work as for any [channel](../../channels/).

- **Default reach is the label group.** With `peers: label:<key>`, an agent can message its owner and every agent with the same value of `<key>` (e.g. everyone with `workstream=auth`). The template picks the key. `tree` (owner and children) and `any` (every agent it knows the id of) are the alternatives.
- **Labels set reach,** so the spawner sets them at spawn time, and changing an agent's labels needs a grant on it.
- **Injection spread is a group, not a tree:** a tainted agent can reach its whole group. Every message carries the sender's taint, wake envelopes carry no bodies, and loop guards and rate limits bound the traffic.

## Schedules

`wake_at(at | every, note)` queues a turn on the agent itself: once at a time, or repeating at an interval. It's how monitors keep their own cadence and how assistants remind me of things. `wake_cancel(id)` stops one.

- **Durable:** wakes are AgentDO alarms, so they survive restarts and moves, and cost nothing while waiting.
- **A due wake is a wake envelope** carrying the note, and it starts a brain like any other wake (see [continuity](../#continuity)).
- **Taint travels:** a wake carries the taint of the session that set it, so an injected note can't launder itself into a clean fresh session.
- **Bounded:** scheduled wakes count against the agent's turn budget and the per-agent wake cap.

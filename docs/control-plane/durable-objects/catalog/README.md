# CatalogDO

One instance (`catalog`): the [templates and capabilities](../../../agents/capabilities/) I edit, stored as data. Spawning reads it; nothing else does.

- **Capability:** `{tools, rules, prompt}`: platform tools from the registry (`platform-tools.json`), the runner's permission rules they need (the per-tool rules grants will replace), and a prompt section.
- **Template:** `{capabilities, launch, hands: required | forbidden | optional, credential, escalate_to, subscribe}`. `credential` names a Claude setup token in [BrokerDO](../broker/) (`claude_oauth_token` or `claude_oauth_token:<name>`, nothing else: its value goes to a brain host). `subscribe: [workstream]` makes the new agent its workstream channel's subscriber.
- **Seeded once** with `worker` and `captain`, equal to what the roles were: the same tools, launch, rules and setup token. An entry I delete stays deleted.
- **Checked on write:** a capability names only registry tools, a template only existing capabilities, each once; a capability a template lists can't be deleted. Routes: `GET /v1/admin/catalog`, `PUT|DELETE /v1/admin/capabilities/<name>`, `PUT|DELETE /v1/admin/templates/<name>`.
- **Expansion is a pure function** (`lib/spec.ts`, unit- and property-tested): the template's hands rule against whether a sandbox is given; tools as the union of its capabilities' (in registry order), narrowed by `overrides.tools` and never widened; rules as the capabilities' in order, each once (or `overrides.rules`); the system prompt as the template's text followed by each capability's prompt (or `overrides.launch`); `credential` and `escalate_to` from the template unless overridden.
- **AgentDO stores the expanded spec** at spawn, so editing a template changes only later spawns.
- **Escalation, until channels exist:** `escalate_to` is `workstream` (a question becomes a `needs_input` event on the [workstream channel](../../../orchestration/workstreams/#the-interim-workstream-channel), which wakes its subscriber) or `user` (the user-notification queue). The design's default, the spawner's inbox, waits for `agent_spawn`.

**Not built:** `mcp` and `api` sources, capability parameters (`messaging{peers}`, `spawning{budget}`), grants and their attenuation against a spawner's (no agent spawns yet), backend, budget, priority and labels in a template.

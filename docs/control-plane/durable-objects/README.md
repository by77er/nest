# Durable Objects

Each entity has exactly one DO, and that DO is the only writer for it.

| DO | Owns |
|---|---|
| [fleet/](fleet/) | Hosts of both kinds, enrollment and tunnels, leases, sandbox placement, drains, STONITH, desired versions, the binding verification key, base generations, command delivery |
| [sandbox/](sandbox/) | Placement claims and epochs, the generation chain (pins, retention, losses), attachments and bindings (`attach`, `resolve`, `detach`), activity and holds, policy, ports |
| [agent/](agent/) | Turn queue and inbox, scheduled wakes, brain placement and the agent epoch, hands setup through SandboxDO, session stream, state, spec, grants, taint and budget, tool relay |
| [broker/](broker/) | Claude setup tokens, injected secrets, capability credentials, GitHub App token minting |
| [catalog/](catalog/) | Templates and capabilities (data I edit), and expanding a spawn spec against them |
| [mcp-connector/](mcp-connector/) | One remote MCP server and credential (and API client namespace): the shared tool list, its change notices to agents, and call admission |
| [client/](client/) | One API client: its record, grant and token hash, and the registry of its subtree (what its maximums count and it lists); plus the directory of client names |

## Conventions

- **SQLite holds metadata only:** heads, indexes, current state. Bulk data goes to R2 (through bindings) or S3 (written by hosts).
- **Secret values live only in BrokerDO** (platform keys are Worker secrets). Other DOs store and pass secret *references* (`$nest-secret:<name>`). FleetDO resolves them when it sends a command to a host, so stored command bodies and the resend queue never hold a token or key.
- **Everything from a host carries `(sandbox, epoch)`** and is checked against the current lease: the reporting host must hold it at that epoch. Stale or foreign reports are dropped.
- **Reliable delivery is at least once and strictly in order.** Each inbound message is the next seq (processed and acked), a duplicate (re-acked), or a gap. A gap, or a failure while processing, closes the connection; the peer reconnects and resends after the last acked seq. A later message's ack never covers an earlier failed one. A new peer process (`instance_id`) starts a new lineage.
- **No lost updates across awaits.** A DO's input gate opens while it awaits R2 or another DO, so state is never saved from a copy loaded before an await: mutations load, apply and save synchronously. Inbound WebSocket messages are processed one at a time per channel.
- **Timers are alarms,** several deadlines multiplexed onto one. A deadline is removed only after its handler succeeds; a failing handler is retried. A key whose handler is running counts as unarmed, so a re-arm made meanwhile (even for the time being run) survives it, and each due key is read again just before it runs, so one cleared or moved by an earlier handler doesn't run.
- **Repair loops:** every transient state carries an alarm deadline, and when it fires the DO re-derives the state from durable facts. An unreachable peer means defer, never destroy.
- **Hosts connect over hibernatable WebSockets:** one control connection per host to FleetDO, plus one per active agent from a brain host's runner to its AgentDO. Hands bytes never pass through a DO: they go from the brain to the sandbox host's gateway. A new connection supersedes the old one only after a valid hello.
- **Bounded growth:** finished commands, tool calls, reply waits and turns are pruned.

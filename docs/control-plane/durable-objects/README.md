# Durable Objects

Each entity has exactly one DO, and that DO is the only writer for it.

| DO | Owns |
|---|---|
| [fleet/](fleet/) | Hosts, enrollment, leases, placement, STONITH, command delivery |
| [sandbox/](sandbox/) | Epoch and placement, generation head, attachments, idle state, policy, ports |
| [agent/](agent/) | Turn queue, deliveries, scheduled wakes, session stream, state, spec, grants, taint and budget, hands journal, tool relay |
| [channel/](channel/) | Message log, subscriptions and cursors, fan-out |
| [hook/](hook/) | One webhook: verification (through BrokerDO), mapping, dedup, posting to its channel |
| [broker/](broker/) | Claude setup tokens, injected secrets, hook secrets, capability credentials, GitHub App token minting |

## Conventions

- **SQLite holds metadata only:** heads, indexes, current state. Bulk data goes to R2 (through bindings) or S3 (written by hosts).
- **Secret values live only in BrokerDO** (platform keys are Worker secrets). Other DOs store and pass secret *references* (`$nest-secret:<name>`). FleetDO resolves them when it sends a command to a host, so stored command bodies and the resend queue never hold a token or key.
- **Everything from a host carries `(sandbox, epoch)`** and is checked against the current lease: the reporting host must hold it at that epoch. Stale or foreign reports are dropped.
- **Reliable delivery is at least once and strictly in order.** Each inbound message is the next seq (processed and acked), a duplicate (re-acked), or a gap. A gap, or a failure while processing, closes the connection; the peer reconnects and resends after the last acked seq. A later message's ack never covers an earlier failed one. A new peer process (`instance_id`) starts a new lineage.
- **No lost updates across awaits.** A DO's input gate opens while it awaits R2 or another DO, so state is never saved from a copy loaded before an await: mutations load, apply and save synchronously. Inbound WebSocket messages are processed one at a time per channel.
- **Timers are alarms,** several deadlines multiplexed onto one. A deadline is removed only after its handler succeeds; a failing handler is retried.
- **Hosts connect over hibernatable WebSockets:** one control connection per host to FleetDO, plus one per active agent to its AgentDO. A new connection supersedes the old one only after a valid hello.
- **Bounded growth:** finished commands, tool calls, reply waits and turns are pruned; channel messages follow their channel's retention.

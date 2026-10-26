# Data placement

**Each piece of data lives next to its main reader.**

| Store | Contents | Main reader | Credentials |
|---|---|---|---|
| DO SQLite | Heads, epochs, agent epochs, leases and placement claims, segment and generation indexes (with pins and loss records), the base-generation index, current state, grants, channel messages (up to about 32 KB) and cursors, tunnel ids per sandbox host and the three desired versions per cell (FleetDO) | Control plane | — |
| R2 | Session segments (native Claude Code session files), large and older (7+ days) channel message bodies, audit logs (egress, credential issuance), UI artifacts (diffs, screenshots), exported journals | DOs, UI, agents, me | DO bindings only |
| S3, per cell (Express One Zone for hot data) | Disk chunks, memory pages, generation manifests, including base generations | Hosts | Instance role |

- **Cross-cloud traffic is small text:** transcripts from brain hosts to Cloudflare, session files back from R2 when a brain starts on a new host, and hands frames between a brain and its sandbox's gateway over the tunnel. No bulk data crosses.
- **Bindings are verified, not stored.** SandboxDO signs them with the cell's binding key, which FleetDO holds and pushes to each sandbox host's gateway; nothing records an issued binding. See [../sandbox/gateway/](../sandbox/gateway/).
- **Egress audit** is JSONL of `EgressAuditRecord` at `audit/<sandbox>/<YYYY-MM-DD>/<epoch>-<host>-<ts_ms>-<digest>.jsonl` (UTC day of each record; the digest is of the content, so a resent batch overwrites itself). One sandbox's history sits under one prefix whichever hosts served it, each incarnation's records apart. FleetDO keeps the records a host sends for an epoch it held the sandbox at: its lease, an incarnation recorded as stale there, or a command sent to it for that epoch. So a host cut off at its own epoch still delivers what it buffered once it reconnects, and so does one whose incarnation FleetDO has since destroyed (the `sandbox_destroy` it sent counts), for as long as FleetDO keeps commands (24 h). Later than that, records for an epoch FleetDO no longer knows the host held are dropped.
- **Audit retention is 90 days:** long enough to look back at an incident, bounded in cost. It is an R2 lifecycle rule on `audit/` that the `edge` stack (`deploy/lean/Edge/`) sets on its apply; until then nothing expires. Objects written before the per-sandbox key (`audit/<host>/…`) fall under the same rule.
- **R2 is the one global store for the control plane.** Each cell has its own S3-compatible store. See [../sandbox/state/object-store/](../sandbox/state/object-store/).

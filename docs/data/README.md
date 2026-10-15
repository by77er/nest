# Data placement

**Each piece of data lives next to its main reader.**

| Store | Contents | Main reader | Credentials |
|---|---|---|---|
| DO SQLite | Heads, epochs, leases, segment and generation indexes, current state, grants, channel messages (up to about 32 KB) and cursors | Control plane | — |
| R2 | Session segments (native Claude Code session files), large channel messages, audit log, UI artifacts (diffs, screenshots), exported journals | DOs, UI, agents, me | DO bindings only |
| S3, per cell (Express One Zone for hot data) | Disk chunks, memory pages, generation manifests | Hosts | Instance role |

- **Cross-cloud traffic is small text in one direction only:** transcripts from AWS to Cloudflare. No bulk data crosses.
- **R2 is the one global store for the control plane.** Each cell has its own S3-compatible store. See [../sandbox/state/object-store/](../sandbox/state/object-store/).

# Data placement

**Each piece of data lives next to its main reader.**

| Store | Contents | Main reader | Credentials |
|---|---|---|---|
| DO SQLite | Heads, epochs, leases and placement claims, segment and generation indexes (with pins and loss records), the base-generation index, current state, grants, channel messages (up to about 32 KB) and cursors | Control plane | — |
| R2 | Session segments (native Claude Code session files), large and older (7+ days) channel message bodies, audit log, UI artifacts (diffs, screenshots), exported journals | DOs, UI, agents, me | DO bindings only |
| S3, per cell (Express One Zone for hot data) | Disk chunks, memory pages, generation manifests, including base generations | Hosts | Instance role |

- **Cross-cloud traffic is small text:** transcripts from AWS to Cloudflare, and session files back from R2 when a brain starts on a new host. No bulk data crosses.
- **R2 is the one global store for the control plane.** Each cell has its own S3-compatible store. See [../sandbox/state/object-store/](../sandbox/state/object-store/).

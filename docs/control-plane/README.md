# Control plane

Cloudflare Workers plus Durable Objects. This layer holds all authoritative metadata, routes every event, runs every durable timer, and wakes things up. It never handles bulk bytes and never runs harnesses.

**Why Cloudflare:** it scales to zero. Durable Objects give one writer per entity with SQLite storage, alarms work as durable timers, and hibernatable WebSockets let hosts dial out so they need no inbound ports.

## Plan

**Decided: Workers Paid ($5/mo).** It removes the 10 ms CPU cap and gives enough DO duration for several streaming agents. The free-tier limits below are for reference.

| Limit | Free | Notes |
|---|---|---|
| Requests | 100k/day | Hosts batch every 1–2 s. Incoming WebSocket messages count 20:1. |
| CPU per invocation | 10 ms | Paid removes the cap. Cap WebSocket messages at about 64 KB. |
| DO duration | 13k GB-s/day | A continuously active DO uses about 10.8k GB-s/day (billed at 128 MB). |
| DO SQLite writes | 100k rows/day | Metadata only; each `setAlarm()` counts as one write |

When a daily limit is exceeded, operations **fail** until 00:00 UTC, so hosts must buffer and retry.

## Rules

- **No bulk bytes.** Transcripts pass through the control plane and are stored in R2. Sandbox state never comes through it, and neither do hands calls: a brain talks to a sandbox host's [gateway](../sandbox/gateway/) directly, and the control plane only issues the binding and resolves the hostname. See [../data/](../data/).
- **No S3 credentials.** The only AWS credential is a scoped IAM user for EC2. See [../compute/provisioning/](../compute/provisioning/).
- **Durability means DO storage plus alarms.** Not Workflows or Queues: on Paid their retention is fine (30 days and 14 days), but a long-lived opaque process (Claude Code) doesn't fit a step function, and either would be a second authority next to the entity's DO ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)). Queues stay an option for channel fan-out at scale.
- **Point-in-time recovery:** DO SQLite can be restored to any point in the last 30 days ([SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). Each DO takes a bookmark before migrating its own schema, so a bad migration can be undone object by object.
- **DOs restart** about once or twice a day and on every deploy, which drops every socket, hibernating ones included. Hosts reconnect with jittered backoff, and nothing assumes a socket outlives a deploy ([Oct 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-10-12-longer-runtime-update-grace-period/)).
- **Storage:** 10 GB of SQLite per DO ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Storage billing (over 5 GB, $0.20/GB-month) was announced; whether it has started is unverified.

## Upgrades

A deploy restarts every DO and drops every socket (above). Cloudflare can roll a Worker back to any of its 100 most recent versions, but it rolls back code, not data, and never across a Durable Object class change ([rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)). So:

- **Schema changes are expand-only.** Add tables and columns with defaults, and never rename or drop in the same release; old code ignores what it doesn't know. A later release drops what's unused, once no version that needs it can be rolled back to.
- **Wire formats stay compatible one version back.** DO-to-DO RPC and the host protocol take only additive, optional fields, so hosts can lag the control plane by a release.
- **A DO class change (new, renamed or deleted) is one-way.** It can't be rolled back, so it ships alone.
- **Deploy at 100%, not gradually.** With DOs, a gradual deployment pins each object to one version until the next deployment, so old and new objects would talk to each other for the whole rollout ([docs](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)).
- **Host reconnection is a free canary:** every host connected before a deploy should reconnect and renew its leases within about 2 minutes, even with no other traffic.

Hosts upgrade by replacement, brain hosts before sandbox hosts, each kind behind a canary and a probe; a sandbox-host release that changes the [restore ABI](../sandbox/state/memory/#restore-abi) resumes dormant memory generations disk-only. See [provisioning](../compute/provisioning/#upgrades).

## Components

- [durable-objects/](durable-objects/): one DO per entity (fleet, sandbox, agent, channel, hook, broker)
- [api/](api/): HTTP API, dashboard, auth, webhook and email routes, user surfaces
- [dashboard/](dashboard/): the read-only page of a cell's hosts, sandboxes, brains and images, a Worker of its own
- [activator/](activator/): turns "X is needed" into "X is running"
- [metrics/](metrics/): runtime metrics in Workers Analytics Engine, read through the `metrics` capability

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

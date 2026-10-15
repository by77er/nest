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

- **No bulk bytes.** Transcripts pass through the control plane and are stored in R2. Sandbox state never comes through it. See [../data/](../data/).
- **No S3 credentials.** The only AWS credential is a scoped IAM user for EC2. See [../compute/provisioning/](../compute/provisioning/).
- **Durability means DO storage plus alarms.** Not Workflows or Queues: on Paid their retention is fine (30 days and 14 days), but a long-lived opaque process (Claude Code) doesn't fit a step function, and either would be a second authority next to the entity's DO ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)). Queues stay an option for channel fan-out at scale.
- **Point-in-time recovery:** DO SQLite can be restored to any point in the last 30 days ([SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). Take a bookmark before every schema migration.
- **DOs restart** about once or twice a day and on every deploy, which drops every socket, hibernating ones included. Hosts reconnect with jittered backoff, and nothing assumes a socket outlives a deploy ([Oct 2026 changelog](https://developers.cloudflare.com/changelog/post/2026-10-12-longer-runtime-update-grace-period/)).
- **Storage:** 10 GB of SQLite per DO ([limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Storage billing (over 5 GB, $0.20/GB-month) was announced; whether it has started is unverified.

## Components

- [durable-objects/](durable-objects/): one DO per entity (fleet, sandbox, agent, channel, broker)
- [api/](api/): HTTP API, dashboard, auth, triggers, user surfaces
- [activator/](activator/): turns "X is needed" into "X is running"

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

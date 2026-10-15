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
- **Durability means DO storage plus alarms.** Don't use Cloudflare Workflows (3-day retention on free) or Queues (24 h retention on free).

## Components

- [durable-objects/](durable-objects/): one DO per entity (fleet, sandbox, agent, channel, broker)
- [api/](api/): HTTP API, dashboard, auth, triggers, user surfaces
- [activator/](activator/): turns "X is needed" into "X is running"

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

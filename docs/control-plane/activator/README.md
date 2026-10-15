# Activator

Turns "something needs X" into "X is running."

```
turn for agent A → AgentDO → SandboxDO:
  running on H          → dispatch to H
  suspended on H        → resume on H (memory or disk-only)
  archived              → FleetDO places it → restore from S3
  no capacity           → stays unplaced; its alarm retries placement every 30 s (the autoscaler that would launch a host isn't built)
```

**External events:** a webhook posts to a channel, and a subscriber's wake starts its brain, which resumes its sandbox if it has one. Nothing runs between events. See [sources](../../channels/sources/).

**Brains:** a turn for an agent whose brain isn't running (it went idle, crashed or lost its host) starts one, resumed or fresh per the [continuity](../../agents/#continuity) rule. See [AgentDO](../durable-objects/agent/).

**Previews:** a request to `<port>-<sandbox>.preview.<domain>` for a suspended sandbox is **held** at the Worker or preview router while the sandbox resumes. Waiting doesn't use CPU time.

**Latency:**

| Situation | Latency |
|---|---|
| Turn for an agent without hands (`claude-code` backend on the controller host) | ~1–2 s (process start plus `--resume`) |
| Memory snapshot in page cache | near-instant |
| Host cold start | 45–90 s |

**To reduce cold starts:** use an idle grace period, and optionally keep a stopped warm host. See [../../compute/autoscaling/](../../compute/autoscaling/).

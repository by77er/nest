# Activator

Turns "something needs X" into "X is running."

```
turn for agent A → AgentDO: no brain running → agent_start on a brain host with capacity (api-loop: the loop in the DO)
                  → for an agent with hands, also SandboxDO (each wake bumps wake_seq), then {hostname, binding} to the runner:
  running on H          → dispatch to H
  paused on H           → unpause on H (milliseconds)
  suspended on H        → resume on H (memory or disk-only)
  unplaced (archived)   → claim (new epoch) → FleetDO places it (memory only on a host that loads its restore ABI) → restore from S3
  no capacity           → stays unplaced while FleetDO launches a sandbox host; its alarm claims again every 30 s
```

**Brains:** a turn for an agent whose brain isn't running (it went idle, crashed or lost its host) starts one, resumed or fresh per the [continuity](../../agents/#continuity) rule. See [AgentDO](../durable-objects/agent/).

**Previews:** a request to `<port>-<sandbox>-preview-nest.<zone>` for a paused or suspended sandbox is **held** at the Worker or the sandbox host's [gateway](../../sandbox/gateway/) while the sandbox resumes. Waiting doesn't use CPU time. While the response is in flight it's an ingress guard, so the sandbox can't be paused under it ([idle rule](../durable-objects/sandbox/#activity-and-idle)).

**Latency:**

| Situation | Latency |
|---|---|
| Turn for an agent whose brain host is up (`claude-code`, with or without hands) | ~1–2 s (process start plus `--resume`) |
| Paused sandbox | milliseconds |
| Memory snapshot in page cache | near-instant |
| Host cold start, either kind | 45–90 s |

**To reduce cold starts:** pause before suspending, use an idle grace period for hosts of both kinds (30 min for brain hosts), and optionally keep a stopped warm host (see [../../compute/autoscaling/](../../compute/autoscaling/)). A new sandbox restores its image's [base generation](../../sandbox/state/memory/#base-generations) instead of booting; there are no warm pools of idle VMs.

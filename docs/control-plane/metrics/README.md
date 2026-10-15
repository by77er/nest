# Metrics

**Decided: nest's runtime metrics go to [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/),** written by the Worker and every DO, and read with SQL. It's on the same platform as the control plane, needs no new service or credential on hosts, and bills only for points written and queries run. Not built.

## Writing

One dataset, `nest_metrics`, bound to the Worker (and so to every DO). Each event or per-minute aggregate is one data point:

| Field | Holds |
|---|---|
| `index1` | The entity: an `agt_`, `sbx_`, `hst_`, `chn_` id, or a route. Sampling groups by it. |
| `blob1…` | `metric` (e.g. `turn.done`), `cell`, `host`, the Worker version id (from the version metadata binding), host version, `outcome` or `kind` |
| `double1…` | Value, count, and extra values per metric (bytes, tokens, cost) |

- **Numbers, enums and platform ids only:** never message text, paths, error strings or anything an outsider can choose. That keeps query results free of injected content, so reading metrics doesn't [taint](../../agents/tools/#taint-and-sinks) a session.
- **Hosts never write directly.** nestd and the runner send a `metrics` frame on the fleet channel every 60 s (pre-aggregated counts, gauges and latency percentiles), and FleetDO writes the points. That's a [pending contract change](../../interfaces/#pending-contract-changes).
- **Limits:** 250 data points per invocation, 20 blobs and 20 doubles per point, a 96-byte index, and 3 months' retention. At high volume, points are sampled per index, so queries weight rows by `_sample_interval` ([limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/), [SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)).
- **Cost:** billed per data point written and per query ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)). The allowance included with Workers Paid is unverified; nest's volume is a few points per turn plus one frame per host-minute.

## What's emitted

| Source | Metrics |
|---|---|
| Worker | Requests by route and status, latency, exceptions |
| FleetDO | Host connects, reconnect time after a deploy, lease renewals (late, missed), expiries, STONITH, placement attempts and failures |
| SandboxDO | Commits (latency, bytes), restores (time, from cache or S3), forks, fences |
| AgentDO | Turns (queued → started latency, duration, outcome, tokens and cost from the stream's `result`), brain starts (resume or fresh), crash restarts, rate limits, wake latency, tool calls by group and outcome, approvals |
| ChannelDO | Posts, deliveries, loop-guard drops, backlog depth |
| HookDO | Deliveries, verification failures, dedup hits |
| Hosts (via FleetDO) | CPU, memory, free hugepages, VM count, proxy allows and denies, hands-call latency p50 and p99, session tail lag |

## Reading

- **The `metrics` [capability](../../agents/capabilities/)** gives `metrics_query(sql)`. The control plane runs the query against the SQL API (`POST …/accounts/<id>/analytics_engine/sql`) with a token that has only Account Analytics Read, stored in BrokerDO as `cap:metrics`. It's a builtin rather than an `api` capability because the SQL API takes `POST`, which `mode: ro` refuses. Results don't taint (see above).
- **Deploy checks** can run the same queries with their own read token.
- **No dashboards or platform alerting.** Noticing a trend is a judgment, so a [monitor agent](../../orchestration/#example-structures) with the `metrics` capability polls with `wake_at` and reports what matters, the same rule as [polling](../../channels/sources/#other-sources).

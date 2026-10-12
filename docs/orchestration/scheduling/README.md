# Quota-aware scheduling

Captains and workers share one Claude subscription. Its advertised limits assume "ordinary, individual usage," so quota is treated as a scheduling resource.

- **Concurrency cap** on active brains, configurable, starting at 2–4.
- **Captains get priority,** with headroom reserved for them.
- **On a rate limit** (`api_retry` with `rate_limit`, or `StopFailure`), park the workstream. This is a durable pause, not a failure.
- **Fallback:** wait for quota.
- **Captains see remaining quota** and plan around it.

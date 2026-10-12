# DNS

- **One resolver in nest-proxy,** reached through the per-sandbox `:53` listeners.
- **Only allowlisted names resolve.** Everything else gets NXDOMAIN and is **never forwarded upstream**, which blocks exfiltration through DNS queries.
- Answers are recorded per sandbox (name → IPs, with TTLs capped). TCP exceptions rely on this record.
- Encrypted DNS (DoH/DoT) can't get around it: DoH endpoints aren't allowlisted, and UDP and port 853 are blocked.
- **Bounded work:**
  - Each sandbox has at most 32 queries in flight. Further UDP queries are dropped (clients retry), and TCP queries wait.
  - Upstream resolution (the host's getaddrinfo, shared by DNS answers and upstream connects) is capped at 64 concurrent lookups across the whole proxy, so one sandbox can't occupy the shared blocking pool.
- **Denied names are aggregated:** one audit record per distinct name per minute, at most 128 per sandbox per minute, and a summary record for what was suppressed (see [../policy/](../policy/)).

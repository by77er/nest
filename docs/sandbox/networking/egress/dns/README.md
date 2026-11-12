# DNS

- **One resolver in nest-proxy,** reached through the per-sandbox `:53` listeners.
- **Only allowlisted names resolve.** Everything else gets NXDOMAIN and is **never forwarded upstream**, which blocks exfiltration through DNS queries.
- **One question per query,** standard opcode; anything else gets NOTIMP. An allowed name answers A and AAAA with what the host resolves (the guest is IPv4-only, so clients use A) and any other type with an empty answer (NODATA).
- **Answers are filtered** (designed, not built): [hard-denied](../policy/#hard-deny) addresses are removed, and if none remain the answer is SERVFAIL (`dns_non_public`). Built: answers pass through unfiltered, and every upstream connect, a TCP exception's included, skips non-public addresses, so an allowed name still can't point a connection at IMDS or a private address.
- **Answers are bounded:**
  - TTLs ≤ 300 s; negative answers ≤ 5 s, so a name approved right after a denial resolves almost at once
  - ≤ 64 records and ≤ 4 KiB per message
  - CNAME chains ≤ 8 hops; a cycle fails

  These are SPACE's values ([reserved_dns.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/reserved_dns.rs), [dns.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/dns.rs)). Built: upstream resolution is the host's getaddrinfo, which hides TTLs and CNAMEs, so answers carry a fixed 60 s TTL (`DNS_TTL_CAP_MS`); the record and size bounds aren't applied.
- **Answers are recorded per sandbox** (name → IPs, with TTLs capped). TCP exceptions rely on this record. A policy change pruning it to the names the new policy still allows is designed, not built ([policy](../policy/#changes)); a TCP exception is checked against the current policy on every connection regardless.
- Encrypted DNS (DoH/DoT) can't get around it: DoH endpoints aren't allowlisted, and UDP and port 853 are blocked.
- **Bounded work:**
  - Each sandbox has at most 32 queries in flight. Further UDP queries are dropped (clients retry), and TCP queries wait.
  - Upstream resolution (the host's getaddrinfo, shared by DNS answers and upstream connects) is capped at 64 concurrent lookups across the whole proxy, so one sandbox can't occupy the shared blocking pool.
- **Denied names are aggregated:** one audit record per distinct name per minute, at most 128 per sandbox per minute, and a summary record for what was suppressed (see [../policy/](../policy/)).

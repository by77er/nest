## Corrections
| docs/interfaces/host-internal/nestd-proxy/README.md (reason table) | `injection_unavailable` verdict deny | audited as `EgressVerdict::Alert`, with an `injection_after_expiry` alert and a 403 | crates/nest-proxy/src/http.rs:413-416 |
| nestd-proxy (reason table) | omits `host_mismatch`, `duplicate_host` | `check_request_host` reasons: deny on plain HTTP, alert over TLS (`host_mismatch` reported as `host_sni_mismatch`) | crates/nest-proxy/src/http.rs:380-385 |
## No drift
ProxyCommand/ProxyEvent/ListenerPurpose/DropReason/AlertKind (crates/nest-protocol/src/host.rs:228-380, fixtures protocol/fixtures/host/proxy_*); ≤32 fds, 1 MiB / 64 KiB packets, SO_SNDBUFFORCE 2× (host.rs:145-151, crates/nestd/src/proxy_link.rs:400); audit ≤1 s / 128 (crates/nest-proxy/src/audit.rs:17,25); fd mismatch → invalid_message (crates/nest-proxy/src/control.rs:114); 172.16.0.1 (crates/nestd/src/net.rs:24); 3128/20000 bases (host.rs); policy_ack not built (no code).
## Drift outside the area
- Check docs/sandbox/networking/egress/ for the same `injection_unavailable` deny wording (sandbox+compute task's area).
STATUS: DONE

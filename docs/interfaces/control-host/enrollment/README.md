# Enrollment

`POST /v1/hosts/enroll` with `EnrollRequest` returns `EnrollResponse`. This happens once per host boot, before the fleet WebSocket opens. It never puts secrets in user-data.

| Field | Meaning |
|---|---|
| `protocol_version` | `model::PROTOCOL_VERSION`; any other value gets `400 unsupported_version` |
| `role` | `burst` (a sandbox host) or `controller` (a brain host); `sandbox` and `brain` are read too, and are what the next release sends ([deploy](../../../../dev/deploy.md#host-role-names-expandcontract)) |
| `cell` | The cell's name, e.g. `use1` ([cells](../../../compute/cells/)). Determines the object store and placement |
| `proof.type = aws_identity_document` | The IMDSv2 instance identity document and its **`rsa2048` signature** (`/latest/dynamic/instance-identity/rsa2048`: RSA-2048 / SHA-256 CMS, with or without PEM armor), both base64. The signature goes in `pkcs7_b64`; the DSA `/pkcs7` signature isn't accepted. FleetDO checks the AWS signature, that **it launched this instance ID** (matching account and region), and that the instance hasn't enrolled before |
| `proof.type = enrollment_token` | A single-use token I mint, for hosts outside AWS |
| `proxy_ca_csr_pem` | CSR for nest-proxy's per-host intermediate CA. The private key is generated on the host and never leaves it. Required from a sandbox host (`400` without it); a brain host runs no proxy and sends none. Fixture: `enrollment_token.brain.json` |

The response contains: `host` (id), `host_token` (a short-lived bearer token, about 1 h) and its `host_token_expires_ms`, `fleet_ws_url`, and, when the request carried a CSR, `proxy_ca` (the intermediate certificate, about 7 days, plus the chain up to the root baked into the image; a brain host of the previous release still sends one and gets one, for one release). Fixture: `enroll_response.brain.json`. A sandbox host's response also carries `tunnel_token` (for the Cloudflare Tunnel the Worker created for this host before answering, with its DNS record; what nestd does with it: [nestd](../../../compute/nestd/)) and `gateway_url` (the `wss://` URL the control plane will tell clients; the host's own `hello.gateway_url` counts only when this is absent). Both are absent for a brain host and on a cell without Cloudflare configuration ([gateway](../../../sandbox/gateway/), [FleetDO](../../../control-plane/durable-objects/fleet/)). Fixture: `enroll_response.tunnel.json`.

**Errors:** `401 unauthorized` (bad proof), `409 forbidden` (instance already enrolled, or token already used), `403 forbidden` (the instance's launch was ended), `400 invalid_message`, `400 unsupported_version`, `502` (the tunnel could not be created; the host retries with the same proof, which is consumed only with the host row; a Cloudflare 401 or 403 instead enrolls the host without a tunnel). A proof already used by a host that never connected (nestd gave up before saving the response) is accepted again, and that host is retired.

**Time budget:** the control plane checks the proof, then makes up to four Cloudflare calls of at most 10 s each (zone lookup once per cell, tunnel, ingress, record) and signs the CSR before it answers, so an enrollment can take about 45 s; nestd waits 60 s for the response (`ENROLL_TIMEOUT` in `crates/nestd/src/enroll.rs`) while its IMDS requests keep 10 s. A client that gives up earlier would leave the proof consumed with nobody holding the host token, and an AWS instance enrolls once.

```
host                                   Worker/FleetDO                      AWS
 │ IMDSv2 identity doc + rsa2048 sig      │                                  │
 │ POST enroll{proof, csr} ─────────────►│ verify rsa2048 with AWS cert      │
 │                                       │ instance ∈ launched-by-us? ───────►│ (record from RunInstances)
 │                                       │ sign CSR with root (≈7 d)          │
 │◄─ {host, host_token, fleet_ws_url, proxy_ca [, tunnel_token, gateway_url]} │
 │ WSS /v1/fleet  (Bearer host_token) ──►│ hello / hello_ack …                │
```

**Rotation:**
- **Host token:** FleetDO pushes `host_token{token, expires_ms}` about 10 minutes before expiry. The host uses the new token for every new connection.
- **Proxy CA:** the host sends `ca_renew{csr_pem}` within 48 h of expiry, and FleetDO answers with `proxy_ca`. The host installs an answer only with the key its certificate names ([nestd](../../../compute/nestd/)).
- **Compromise:** a compromised host is never reissued either one. Its token and intermediate expire on their own.

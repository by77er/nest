# Enrollment

`POST /v1/hosts/enroll` with `EnrollRequest` returns `EnrollResponse`. This happens once per host boot, before the fleet WebSocket opens. It never puts secrets in user-data.

| Field | Meaning |
|---|---|
| `role` | `burst` or `controller` (designed: `kind`, `sandbox` or `brain`) |
| `cell` | e.g. `aws-us-east-1`. Determines the object store and placement |
| `proof.type = aws_identity_document` | The IMDSv2 instance identity document and its **`rsa2048` signature** (`/latest/dynamic/instance-identity/rsa2048`: RSA-2048 / SHA-256 CMS, with or without PEM armor), both base64. The signature goes in `pkcs7_b64`; the DSA `/pkcs7` signature isn't accepted. FleetDO checks the AWS signature, that **it launched this instance ID** (matching account and region), and that the instance hasn't enrolled before |
| `proof.type = enrollment_token` | A single-use token I mint, for hosts outside AWS |
| `proxy_ca_csr_pem` | CSR for nest-proxy's per-host intermediate CA. The private key is generated on the host and never leaves it |

The response contains: `host` (id), `host_token` (a short-lived bearer token, about 1 h), `fleet_ws_url`, and `proxy_ca` (the intermediate certificate, about 7 days, plus the chain up to the root baked into the image). A sandbox host's response also carries `tunnel_token` (the Cloudflare Tunnel the Worker created for this host before answering, with its DNS record; nestd keeps it in its credentials file and hands it to cloudflared through the environment, never a command line) and `gateway_url` (the `wss://` URL the control plane will tell clients; the host's own `hello.gateway_url` counts only when this is absent). Both are absent for a `controller` host and on a cell without Cloudflare configuration ([gateway](../../../sandbox/gateway/), [FleetDO](../../../control-plane/durable-objects/fleet/)). Fixture: `enroll_response.tunnel.json`.

**Errors:** `401 unauthorized` (bad proof), `409 forbidden` (instance already enrolled), `400 invalid_message`.

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
- **Proxy CA:** the host sends `ca_renew{csr_pem}` within a day of expiry, and FleetDO answers with `proxy_ca`.
- **Compromise:** a compromised host is never reissued either one. Its token and intermediate expire on their own.

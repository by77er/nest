## Corrections
| docs/interfaces/control-host/enrollment/README.md | request table omits `protocol_version` | `EnrollRequest.protocol_version` required; mismatch → `unsupported_version` 400 | crates/nest-protocol/src/control.rs:37, control-plane/src/index.ts:202-204 |
| enrollment | response omits `host_token_expires_ms` | `EnrollResponse.host_token_expires_ms` required | crates/nest-protocol/src/control.rs:67 |
| enrollment | errors: 401, 409, 400 invalid_message, 502 | also 409 for a used enrollment token, 403 forbidden for an ended launch, 400 unsupported_version | control-plane/src/do/fleet.ts:521,540,543; control-plane/src/index.ts:203 |
## Confirmed (no drift)
ENROLL_TIMEOUT 60 s and IMDS 10 s (crates/nestd/src/enroll.rs:161,164); host token TTL 1 h (fleet.ts:581); rotate 10 min before (fleet.ts:231); CA TTL 7 d (fleet.ts:847); ca_renew 48 h (crates/nestd-core/src/ca.rs:14); Cloudflare call timeout 10 s (control-plane/src/lib/cloudflare.ts:15); CSR required from sandbox host 400 (fleet.ts:496); 502 from CloudflareError (cloudflare.ts:88); Cloudflare 401/403 → no tunnel (fleet.ts:637).
## Unconfirmed
- "about 45 s" total enrollment (enrollment:17): arithmetic estimate, not a constant.
## Outside-area drift
STATUS: DONE

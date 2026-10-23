# TLS

## CA chain

```
root (AWS KMS, ECC_NIST_P256, never exported)  ── in the image ──►  guests trust it
 └─ per-host intermediate (key made on the host, pathLen 0, ~7 days)
     └─ leaf per SNI (≤ 24 h, never past the intermediate)
```

- **No revocation:** the certificates carry no CRL or OCSP pointers, and guests check none, so a certificate's lifetime is the only bound on a leaked key. Every level is short-lived or unextractable.
- **Root:** a non-exportable `ECC_NIST_P256` signing key in AWS KMS ([key specs](https://docs.aws.amazon.com/kms/latest/developerguide/asymmetric-key-specs.html): the private key never leaves KMS unencrypted). FleetDO builds each intermediate certificate, hashes it and calls KMS `Sign` (`ECDSA_SHA_256`) with the control plane's IAM user, which may sign with this one key only. CloudTrail logs every call ([Sign events](https://docs.aws.amazon.com/kms/latest/developerguide/ct-sign.html)), so each issuance is on record. Signing happens only at host enrollment and renewal, so KMS is off every hot path. The root certificate is baked into the image (plus `NODE_EXTRA_CA_CERTS` for tools that need it).
- **Built:** the cell stack creates the key (alias `alias/nest-<cell>-proxy-root`) and grants the control plane only `kms:Sign` and `kms:GetPublicKey` on it, with theorems in `deploy/lean/Cell/Test.lean`. The root certificate is self-signed through KMS once (`POST /v1/admin/root-ca/kms`), stored as `ROOT_CA_CERT_PEM` beside `ROOT_CA_KMS_KEY_ID`, and baked into the guest image. FleetDO verifies each intermediate against the root before handing it out. Not built: the intermediate's extended key usage.
- **Cost:** $1/month for the key, and $0.15 per 10,000 `Sign` requests; asymmetric requests aren't in KMS's free tier ([pricing](https://aws.amazon.com/kms/pricing/)). That's about $1/month for nest.
- **Per-host intermediate:** each host generates its own P-256 key and sends a **fixed-shape CSR**: PKCS#10 v1 over a P-256 key, self-signed with ecdsa-with-SHA256, exactly the expected subject, no attributes or extension requests. FleetDO refuses anything else rather than ignoring it, and **sets every certificate field itself**: subject, validity, `CA:TRUE` with **pathLen 0** (it signs leaves only), key usage `keyCertSign`, extended key usage `serverAuth`. The CSR checks follow [SPACE's csr.rs](https://github.com/perplexityai/space/blob/main/crates/libs/credential/mgr/server/src/intermediate_ca/csr.rs).
- **Intermediate lifetime:** about 7 days. nestd renews it (new key, new CSR) when less than 48 h remain ([nestd](../../../../compute/nestd/)). A compromised host's intermediate expires on its own and is never reissued.
- **Leaves:** ECDSA P-256, minted on the fly, valid ≤ 24 h and never past the intermediate's expiry.

## Shared-proxy fairness

One proxy serves every sandbox on the host, so TLS work is bounded globally and per sandbox. One sandbox can't starve the others.

| Bound | Value |
|---|---|
| Handshakes in progress, whole proxy (both legs) | 256, with a FIFO wait of ≤ 5 s for a slot |
| Handshakes in progress, per sandbox | 64 |
| Time per handshake | 10 s |
| Leaf signing per sandbox | ≤ 4 at once, ≤ 32 per second |
| Leaf cache | shared LRU of 4,096 leaves, keyed by SNI |

- Over a bound, a handshake waits within its budget, then fails with `handshake_limit`.
- **Leaves minted only to deliver a 403** (a denied name) count against the sandbox's signing budget and aren't cached, so a guest can't evict allowed hosts' leaves by cycling names.
- The pool, wait, handshake time and signing bounds are SPACE's per-gateway limits ([admission.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/tls_interception/admission.rs), [tls.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/tcp_proxy/tls.rs), [certificates/client.rs](https://github.com/perplexityai/space/blob/main/crates/libs/net/gateway/server/src/certificates/client.rs)). SPACE runs one gateway per sandbox; nest runs one proxy per host, so it adds the per-sandbox handshake cap and shares one leaf cache.

## Upstream

- **Verification:** the proxy validates server certificates against the standard public roots (webpki-roots) and **fails closed**. Sandboxes depend on it for this.
- **Addressing:** the proxy **re-resolves the SNI name** for the upstream connection, never using the IP the guest dialed, and never connects to a [hard-denied](../policy/#hard-deny) address.
- **Protocols:** the client is offered the same ALPN the upstream negotiated, so HTTP/1.1, h2, gRPC and WebSocket upgrades all work. HTTP/3 is refused at the netns, so clients fall back to TCP at once ([steering](../steering/)).
- **Pinned clients** go on the SNI-passthrough list. They get no injection and no inspection, and passthrough is SNI-only ([policy](../policy/)).
- What the proxy checks inside decrypted requests: [inspection/](../inspection/).

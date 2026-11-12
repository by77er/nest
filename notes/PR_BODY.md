Docs-only check of `docs/sandbox/` and `docs/compute/` against the code on `main`. Code is the truth for what is built; docs are the truth for design intent. Unbuilt designs stay and are marked not built, and nothing is marked built without its code. Where the code breaks a stated decision, both are left alone and the gap is listed below as a suspected code bug.

All 26 READMEs in scope were read in full. Besides those docs, only summary lines in `docs/README.md` (2 lines) and `docs/architecture/README.md` (1 row) changed. No code, config, tests, `docs/security/`, `dev/` or `deploy/` changes. No CODEOWNERS paths are touched.

**Biggest finding:** several egress protections are documented as built but are not in `crates/nest-proxy` or `crates/nestd`:
- routing-override stripping and the request-smuggling checks;
- the TLS fairness bounds and the fixed-shape CSR checks;
- the kernel backstop on the proxy's uid and DNS answer filtering;
- injection's method and path scope and its refusal of an upgrade after a substitution.

They are now marked designed, not built. `docs/security/` likely repeats some of them; see "Drift outside the area".

## Corrections

| Doc | Said | Code says | Evidence |
|---|---|---|---|
| sandbox/README | after a fork the guest reseeds via VMGenID and resyncs via VMClock | nestd's `resume` on a fork's first boot: clock step to host time, 64 B of host entropy (`RNDADDENTROPY`), new machine-id and hostname; no VMGenID/VMClock code | crates/nestd/src/host.rs:1778-1780, guest.rs:297-302; crates/nest-guest/src/sys.rs:38,43-88 |
| drivers/README | nestd refuses "either driver" unless `unconfined_driver`; driver ops listed without status; gVisor row unmarked | refuses the process driver and Firecracker without `jailer_bin`/`jailer` (static enrollment exempt); `Vm` has create/start/pause/resume/stop/`snapshot_memory`; no memory restore or restore-ABI descriptor; no gVisor | crates/nestd/src/config.rs:332-343, driver/mod.rs:37-87, driver/firecracker.rs:332-336 |
| drivers/gvisor, drivers/lambda-microvm | no status | not built (no driver) | crates/nestd/src/driver/ |
| drivers/firecracker | VMGenID reseeds after a fork, guest reconnects; "pinned by binary digest" and the digest is part of the restore ABI, read as built | memory forks aren't built, and nestd initiates every connection. The release's `SHA256SUMS` pins the binaries (no version or digest is in the repo), and the restore ABI isn't built | scripts/publish-release.sh:3-5,17,47-53; deploy/host/install.sh:29-40 |
| guest-agent | `resume` after a restore; hands `busy` "while frozen" | `resume` only on a fork's first boot (restores cold-boot); nothing is ever frozen | crates/nestd/src/host.rs:1778-1780; crates/nest-guest/src/control.rs:107,115 |
| fencing | `sandbox_destroy` "once the sandbox lives elsewhere" | once the lease is no longer that (host, epoch), unplaced included | control-plane/src/do/fleet.ts:1194-1210 |
| fencing | STONITH = terminate and wait for EC2 | also proven by a reconnected host fencing every expired lease; a silent host with no live lease gets none; SandboxDO issues the new epoch | control-plane/src/do/fleet.ts:1497-1511,2874-2907,2967-3011; lib/host-lifecycle.ts:47-54 |
| fencing | every STONITH records each sandbox's loss; `PreToolUse` gate blocks a stale-epoch `git push` | both not built (`leaseLost` writes no loss; no epoch hook; the gateway refuses stale bindings) | control-plane/src/do/sandbox.ts:862-891; crates/nest-gateway/src/verify.rs:117 |
| fencing | idempotency key `(repo, head_sha)`; a stale-epoch commit fences; reconnect fences epochs below current | `pr:repo:head:base`; `stale_epoch` or `parent_mismatch` fences; FleetDO fences every reported VM its lease doesn't honour | control-plane/src/lib/brokered.ts:367-378; crates/nestd/src/host.rs:2886-2888; fleet.ts:1126-1148 |
| gateway | a connection without upgrade+`bind` in 5 s "is dropped"; jail grant and unit hardening unverified on a host | after the upgrade it's refused `bad_request`; the 256-slot hold lasts until `bound`; file access verified on a host 2026-11-06 (network restrictions still unverified) | crates/nest-gateway/src/server.rs:29-30,81-83,118-134,266-310; dev/rollout/2026-11-05-instance-store-hosts-come-back.md:6-11; dev/measure-cut/results-probe-i-0705fb9b9898f4f2f.json |
| networking/README | VM starts only after the proxy acknowledges its policy; ingress unmarked | boots right after the push (ack designed); only the hands route is built | crates/nestd/src/host.rs boot path; crates/nest-gateway/src/server.rs:236-241 |
| egress/README | "refused twice" (proxy + kernel rule); pipeline holds ≤30 s for an ack, strips overrides, rejects smuggling, re-checks open connections; fairness bounds | proxy check only; no policy → 403 at once; no stripping/smuggling checks; each request re-decided, closing denied connections designed; fairness not built | crates/nest-proxy/src/http.rs:390-394,840-846; tls.rs:24-28 |
| egress/steering | kernel backstop (`meta skuid` reject rule) as built; accept list | not built (no such rule anywhere); the netns also redirects 53 to any address and accepts 80/443; port ranges 3128–3191, 20000–20999 | crates/nestd/src/net.rs:30-32,204-230 |
| egress/dns | only A/AAAA (class IN), else NOTIMP; AAAA always empty; answers filtered of hard-denied addresses (`dns_non_public`); ≤64 records/4 KiB | NOTIMP only for a non-Query opcode or ≠1 question; A and AAAA answered from getaddrinfo, other types NODATA; no filtering (connects refuse non-public addresses); no record cap; 60 s TTL | crates/nest-proxy/src/dns.rs:36-72; state.rs:24; http.rs:113-129,840-846 |
| egress/inspection | routing overrides stripped; smuggling checks → 400 `invalid_headers`; ≤128 headers/32 KiB, ≤32 h2 streams; `limits.max_inspected_body_mb` | none of the stripping or smuggling checks exist (Host/SNI match, duplicate Host, hop-by-hop stripping and `te: trailers` do); hyper defaults; `max_inspected_body_bytes` | crates/nest-proxy/src/http.rs:46-56,95,227-230,375-388,472-477,553-575,693-710; crates/nest-protocol/src/model.rs:393 |
| egress/tls | fixed-shape CSR refused otherwise; FleetDO sets every field incl. subject; key usage `keyCertSign`, EKU `serverAuth`; fairness bounds and 403 leaves uncached | `signIntermediate` parses and verifies the CSR, copies its subject and key, sets 7 d (`PROXY_CA_TTL_MS`), pathLen 0, keyCertSign+cRLSign, no EKU; only the 10 s handshake and a 4,096-leaf map (cleared when full, 403 leaves cached) | control-plane/src/lib/ca.ts:85-121; do/fleet.ts:847; crates/nest-proxy/src/tls.rs:24-102 |
| egress/policy | changes apply to open connections; YAML lacks `read_repos`, wrong limit names; non-public refused "before policy"; DNS answers hard-denied; kernel rule; hard-deny test; `policy_pending` hold; tap bandwidth shaping; 7 audit reasons emitted | per-request re-decision only; `read_repos`; `max_connections`/`bandwidth_mbps`/`max_inspected_body_bytes` fixed defaults; refused at dial; DNS/kernel/hold/shaping not built; only `is_public` and `private_upstream_addresses_are_refused` tests; those 7 reasons never emitted | crates/nest-proxy/src/http.rs:369-375,497,840-846,1131-1145; state.rs:331-339; dns.rs:46,55-72; control-plane/src/do/sandbox.ts:42,69-82,1190 |
| egress/injection | `methods`/`path_prefix` scope and `injection_out_of_scope`; `wildcard: true` and reserved headers for every binding; `injection_upgrade` refusal | no method/path fields or checks; wildcard opt-in and reserved headers only for API clients' bindings; h1 Upgrade forwarded after a substitution; added `credential_requires_tls` | crates/nest-protocol/src/model.rs:286-293,346-352; crates/nest-proxy/src/inject.rs:50-71, http.rs:408-424,467-535; control-plane/src/lib/client-secrets.ts:65-70,90-93; do/sandbox.ts:75 |
| networking/ingress | terminal attach, port-forward, ingress guards, 60 s detach unmarked; fallback 172.16.0.2 | `/pty` and `/ingress/*` answer 501; no ingress guards; a dropped PTY gets SIGHUP; fallback also `::1` | crates/nest-gateway/src/server.rs:236-241; crates/nest-guest/src/ingress.rs:63,246 |
| state/README | generation `{…, restore_abi?, session?, state, at}`; reasons `periodic, pressure, pause, spot`; chunks 4 MB/2 MB; reflink cut "not deployed"; rollback notice, rebalance polling, `/scratch` volumes unmarked | `GenerationRecord {id, sandbox, parent?, epoch, kind: disk_only\|checkpoint, disk_manifest, mem_manifest?, reason, created_ms, cut_ms?}`; reasons `turn_end, timer, dirty_threshold, suspend, drain, spot_notice, checkpoint, fork, salvage, archive`; 4 MiB/2 MiB; M2 and M3′ built; the rest not built | crates/nest-protocol/src/model.rs:678-719; control-plane/src/protocol/model.ts:354; crates/nestd/src/storage.rs:21-23; enroll.rs:68 |
| state/disk | 4 MB chunks; "as before"/"used to"/"now" tombstones; AL2023 6.12 kernel; M3′ "draft, not merged"; option 1 commit reads only changed chunks; `nest diff` unmarked; reason `spot`; option 3 clone 2.2–2.7 s | 4 MiB BLAKE3, zero chunks `null`; kernel-6.18 AMI; M3′ merged (#159), `disk_cut: auto` picks it; `commit_cut` reads the whole shadow; `nest diff` not built; `spot_notice`; 1.6–2.7 s | crates/nestd/src/storage.rs:4-5,20-21; deploy/lean/Cell/Stack.lean:479; crates/nestd/src/host.rs:2357-2363,2925-2944; dev/measure-cut/results-m3-i-04d122795c13dafcf.json |
| state/object-store | M2 "built, not deployed"; "no longer go into the local cache" | M2 built (the disk doc: "deploys on merge"); committed chunks skip the cache | crates/nestd/src/s3.rs:469-482 |
| compute/nestd | refusal exemptions; nestd installs the kernel backstop; M2 "built, not deployed" | static enrollment exempt; backstop not built; M2 built | crates/nestd/src/config.rs:332-335; net.rs:204-245 |
| compute/autoscaling | "This changed on 2026-11-04: before, …" (tombstone); idle = "no lease and no agent" | dropped; busy = any unsuspended lease, a brain, or an incarnation awaiting salvage | control-plane/src/do/fleet.ts:2356-2362 |
| compute/provisioning | the host image has gVisor (`runsc`) | not installed | deploy/host/install.sh:18,35-47 |
| docs/README.md | TLS: fixed-shape CSRs (no status); injection: opt-in wildcards for every binding | shape check designed; wildcards opt-in for API clients' bindings | control-plane/src/lib/ca.ts:85-92; lib/client-secrets.ts:90-93 |
| architecture/README.md | self-fence "pauses VMs"; agent told "what was lost" | freezes then stops VMs, disks kept for salvage; loss reporting designed | crates/nestd/src/host.rs:1288-1445 |

## Unconfirmed claims (left as written)

- **compute/README "Approximate prices":** c8i.large spot ~$0.033/hr, DigitalOcean $42/mo, Lambda MicroVM ~$0.25/hr, on-demand ≈ 1.5× DO, spot 60–70% less. The repo has only on-demand prices (deploy/lean/Cell/Cells.lean:28-29).
- **compute/autoscaling evidence (2026-10-17):** zero → running sandbox → zero, and the FIS spot run in "about 90 s". No record in dev/cloud-checks/, dev/measure-cut/ or e2e/FINDINGS.md.
- **compute/autoscaling sizing:** "each host is capped so a forced drain finishes in about 90 s at its measured upload bandwidth". The cap (Cells.lean:21) is set by disk and memory; no bandwidth measurement found. Also "warm host about $2/mo": no record.
- **compute/provisioning and drivers/firecracker:** "Firecracker from the 1.17 line" and "v1.17.0 … the line nest pins": no version is recorded in the repo. Two more claims with no record: "a rebooted EC2 host reconnected without re-enrolling", and "the first turn-end commit hit its 60 s timeout".
- **drivers/firecracker:** "Built and verified (EC2 c8i-flex.large, Firecracker 1.17.0, 2026-10-18)" and the `init_on_free` boot stall. Only a code comment backs the stall (crates/nestd/src/config.rs:439-441).
- **gateway:** tunnel "verified on AWS 2026-10-23" and Access "since 2026-10-24": backed only by docs/README.md spike item 13. Cloudflare's 7844/QUIC is an external fact.
- **state/README and state/disk, "33–39 s" M1 pause:** restated only in dev/rollout/2026-11-02-…-m1.md:9 and 2026-11-03-…-m2.md:29, with no measurement record.
- **state/README and state/disk, other figures:** the first commit uploading "about 700 MB, roughly 30 s"; disk "$0.085" (computed, run length unrecorded); the RefluXFS CVE fix in the host kernel (external).
- **state/object-store:** Express One Zone and Standard prices and the cost table (external pricing, not re-fetched).
- **fencing:** "t≈35 s new claim" (estimate). "Salvage holds the sandbox lock only while chunking" rests on a code comment (crates/nestd/src/host.rs:1362).
- **egress/policy:** "no client rule allows what the operator's policy refuses" (the operator layer has no deny rules); what a client reads of the policy; the details of the operator binding's GraphQL exception.
- **egress/injection:** the two "2026-11-02" dates. Whether h2 sends `set_sensitive` headers never-indexed depends on the h2 crate.
- **compute/nestd:** the runner's one WebSocket per agent to AgentDO was not traced in nest-runner, and neither were the finer process-tree membership rules.

## Suspected code bugs (docs left as the decision)

- **nest-proxy runs as root.** compute/nestd ("Privilege split"), egress/README ("unprivileged") and docs/README.md ("the proxy is unprivileged") state otherwise. `nest-proxy.service` has no `User=` and the proxy drops no privileges (deploy/host/install.sh:90-104; crates/nest-proxy/src/main.rs).
- **The agent runner runs as root.** `nest-runner.service` has no `User=` and sets `HOME=/root` (install.sh:190-215).
- **The gateway runs as `nest-gw` only when nestd reports `gateway-user`.** Otherwise it runs as root with `CAP_DAC_OVERRIDE` (install.sh:60-72).
- **Denied guest traffic is dropped, not rejected.** steering step 2, networking/README ("UDP/443 rejected, so HTTP/3 falls back at once") and docs/README.md ("rejected, not dropped") state otherwise. The netns `input` and `forward` chains are `policy drop` with no reject rule (crates/nestd/src/net.rs:218-227).
- **An upgrade after a credential substitution is forwarded, and its stream spliced unmasked** (crates/nest-proxy/src/http.rs:467-535). The injection doc decides it is refused.
- **Operator-layer bindings skip the `wildcard` opt-in and the reserved-header check.** They can inject into `host`, `transfer-encoding` or `Fastly-*`, or onto `*.` hosts (control-plane/src/do/sandbox.ts:75 vs lib/client-secrets.ts:65-93).
- **Security-relevant designs not built** (marked so in the docs; flagged here because security relies on them): routing-override stripping and the smuggling checks; the kernel backstop, so only the root-running proxy's own check guards IMDS; DNS answer filtering, where non-public answers are visible to the guest although connects refuse them; the fixed-shape CSR checks; and per-sandbox TLS fairness.

## Drift outside the area (not edited)

- **docs/security/ (CODEOWNERS):** check its claims about proxy hardening (override stripping, smuggling, kernel backstop, unprivileged proxy, CSR shape) against the list above.
- **docs/interfaces/host-internal/nestd-proxy/README.md:** the reason table lists `injection_unavailable` as a deny; the proxy audits it as an alert (crates/nest-proxy/src/http.rs:416).
- **docs/README.md, open question on M2/M3′:** it still asks "which M3′ to build", but option 1 is merged (#159). That is the map task's line; this PR leaves it.
- **docs/setup/README.md:113:** repeats "Firecracker from the 1.17 line, pinned by digest" (unconfirmed, above).
- **crates/nest-gateway/README.md:18:** `verify` ends at "guest version"; the code adds a final step, a paused VM answering `busy` with reason `paused` (crates/nest-gateway/src/verify.rs:432-466).
- **Stale code comments:**
  - `crates/nestd/src/driver/firecracker.rs:3` says "2 MiB hugetlbfs memory"; hugepages are off by default.
  - `crates/nest-protocol/src/model.rs:244`: the `SuspendMode::Memory` comment.
  - `control-plane/src/do/fleet.ts:268-270` cites a nonexistent `SALVAGE_TIMEOUT` of 600 s.
  - `control-plane/src/lib/client-secrets.ts:61-63,82` claims nest-proxy strips routing overrides, and that operator bindings need `wildcard`.
  - `crates/nestd/src/host.rs:14`: brains and fences.

## Docs with no drift

- **compute/cells:** checked against control-plane/src/lib/cells.ts:1-64, do/fleet.ts:2842-2843 and deploy/lean/Cell/Stack.lean:598,602.
- **compute/brain-hosts:**
  - cells.ts:16-33: 30 min idle, 3 hosts.
  - placement.ts:101,108-111: 2 brains per vCPU.
  - control.ts:13-15: 5 s, 20 s and 30 s lease timings.
  - nest-runner config.rs:59: 120 s idle exit.
  - agent.ts:84,327: 30 s retry, up to 5 min.
  - Stack.lean:99: `t3a.medium`, then `t3.medium`.
- **compute/README:** the 8i launch types, the role names (crates/nest-protocol/src/model.rs:192-199) and the on-demand prices (Cells.lean:17-29).
- **state/memory:** the whole design is already marked not built. The facts it gives as built hold:
  - the 128 MiB VMM overhead (crates/nestd/src/config.rs:450);
  - `OOMScoreAdjust=-900`;
  - `drop_caches` in `prepare_snapshot` (crates/nest-guest/src/sys.rs:105-110).
- **Leaf docs whose remaining claims were checked and hold** (only the rows above changed):
  - state/object-store: S3 options (s3.rs:34-57), GC constants and routes (fleet.ts:285-292, index.ts:611-671);
  - guest-agent: vsock CID check, retention, environment and ingress order;
  - compute/nestd: every constant listed in the audit notes;
  - drivers/firecracker: jail layout, modes, cache and I/O engine, guest kernel and rootfs pins (images/guest/build.sh:22-27).

## Checks

- `python3 -I scripts/check-doc-links.py`: 0
- `python3 -I scripts/check-fences.py`: 0
- `python3 -m unittest discover -s scripts/tests`: see below
- `git diff --name-only origin/main...HEAD`: only Markdown under docs/sandbox/ and docs/compute/, plus docs/README.md and docs/architecture/README.md
- Tombstone grep: no hits
- Independent review: see below

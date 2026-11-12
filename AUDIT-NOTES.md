# Audit notes (scratch; becomes the PR body, deleted before the PR)

## Corrections
| doc | said | code says | evidence |
|---|---|---|---|
| compute/provisioning/README.md | the host image contains gVisor (`runsc`) | install.sh installs no runsc (and the doc's own last bullet says gVisor isn't built) | deploy/host/install.sh:18,35-47 |
| compute/autoscaling/README.md | tombstone "This changed on 2026-11-04: before, only the first type went on demand" | (history; dropped) | AGENTS.md no-tombstones rule |
| compute/autoscaling/README.md | idle grace: host with "no lease and no agent" | busy = any lease not `suspended`, a brain, or an incarnation awaiting salvage | control-plane/src/do/fleet.ts:2356-2362 |
| sandbox/README.md | after a fork the guest reseeds via VMGenID and resyncs via VMClock | nestd's `resume` on a fork's first boot: clock step to host wall clock, 64 B host entropy (RNDADDENTROPY), new machine-id and hostname; no VMGenID/VMClock code | crates/nestd/src/host.rs:1778-1780, guest.rs:297-302, crates/nest-guest/src/sys.rs:43-88 |
| sandbox/drivers/README.md | nestd refuses "either driver" unless `unconfined_driver`; listed snapshot/restore/fork as the driver interface without status | refuses the process driver and Firecracker without `jailer_bin`/`jailer`; trait has create/start/pause/resume/stop/snapshot_memory; no memory restore | crates/nestd/src/config.rs:332-343, crates/nestd/src/driver/mod.rs:37-87, driver/firecracker.rs:332-336 |
| sandbox/drivers/README.md | gVisor row without status | no gVisor driver | crates/nestd/src/driver/ (firecracker.rs, process.rs only) |
| sandbox/drivers/gvisor, lambda-microvm | no status | not built | crates/nestd/src/driver/ |
| sandbox/drivers/firecracker/README.md | VMGenID reseeds after a fork; guest agent reconnects | memory forks not built; nestd's `resume` sends 64 B of entropy mixed via RNDADDENTROPY; connections are host-initiated by nestd | crates/nestd/src/guest.rs:297-302, crates/nest-guest/src/sys.rs:38,43-88 |
| sandbox/guest-agent/README.md | `resume` after a restore; hands `busy` "while frozen" | `resume` only on a fork's first boot (restores cold-boot); nothing is ever frozen | crates/nestd/src/host.rs:1778-1780, crates/nest-guest/src/control.rs:107,115 |

## Unconfirmed
- compute/provisioning/README.md: "Firecracker from the 1.17 line" and sandbox/drivers/firecracker (same): the repo records no Firecracker version (release carries the binaries; scripts/publish-release.sh checks SHA256SUMS). "Evidence: a rebooted EC2 host reconnected without re-enrolling": no record. "on EC2 the first turn-end commit hit its 60 s timeout" (compressed guest image rationale): no record.
- compute/autoscaling/README.md: "Evidence: on EC2 (use1, 2026-10-17) a cell went from zero hosts to a running sandbox and back to zero" and the FIS spot run "within about 90 s of the notice": no record in dev/cloud-checks/, dev/measure-cut/ or e2e/FINDINGS.md. Also "each host is capped so a forced drain finishes in about 90 s at its measured upload bandwidth": no measurement or cap found tying `maxSandboxesPerHost` (Cells.lean:21, by disk and memory) to upload bandwidth.
- compute/autoscaling/README.md: stopped warm host "about $2/mo for EBS": no record.
- compute/README.md:49-52 prices: c8i.large spot ~$0.033/hr, DigitalOcean $42/mo, Lambda MicroVM ~$0.25/hr, "on-demand ~1.5× DO", "spot 60-70% less": no record in the repo (only on-demand prices in deploy/lean/Cell/Cells.lean:28-29).

## Suspected code bugs
- **nest-proxy runs as root on cell hosts.** docs/compute/nestd/README.md (Privilege split: "nest-proxy, the gateway and the agent runner run unprivileged"), docs/README.md:183 ("the proxy is unprivileged") and the egress docs state it; `deploy/host/install.sh:90-104` writes `nest-proxy.service` with no `User=`/`CapabilityBoundingSet=`, and `crates/nest-proxy/src/main.rs` drops no privileges. Docs left as the decision.

## Drift outside the area

## Docs with no drift
- compute/README (8i types Cells.lean:17-18; role names model.rs:192-199, Stack.lean:296-297; c8i.large $0.094 Cells.lean:28 93710 µ$; t3a.medium 37600 µ$/h ≈ $27/mo)
- compute/cells (cells.ts:1-64, fleet.ts:2842-2843, index.ts:639,674, Stack.lean:598,602)
- compute/brain-hosts (cells.ts:16-33 idle 1_800_000 and max_hosts 3; placement.ts:101,108-111 2 per vCPU; control.ts:13-15 5 s/20 s/30 s; nest-runner config.rs:59 120 s; agent.ts:84,327 30 s→5 min; Stack.lean:99 t3a/t3.medium). Prices already marked unverified.

## Docs done
- compute/provisioning (23 h resume grace credentials.rs:22-23; IMDSv2 hop 1 Stack.lean:518; 7844 Stack.lean:114-115,426-428; lifecycle policy Stack.lean:532-548; SandboxTypesOnly/ArnEqualsIfExists Stack.lean:347-370; cloudflared pin install.sh:17,81-87; Claude pin install.sh:13,74-79)
- compute/autoscaling (numbers confirmed: placement.ts:155-160 backoff 60 s→15 min/5 min brain, 30 min decay; enroll-breaker.ts:8-11 3, 30 min, 6 h; fleet.ts:197 1 min image cache, :264 brain waits 12 min; cells.ts:44-48 idle 10 min, enroll 10 min, :28-31 brain 3 hosts, 30 min; host.rs:1473 spot poll 5 s)
- sandbox/drivers/gvisor, lambda-microvm, sandbox/guest-agent (the rest confirmed: vsock ports and CID 2 check transport.rs:63; retention output.rs:18-21; env exec.rs:21-46; ingress order ingress.rs:63; exact protocol_version nestd guest.rs:276; busy before configure state.rs:124; SIGHUP on drop ingress.rs:246; 200 ms drain hands/bash.rs:141)

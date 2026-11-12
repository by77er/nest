# Audit notes (scratch; becomes the PR body, deleted before the PR)

## Corrections
| doc | said | code says | evidence |
|---|---|---|---|
| sandbox/README.md | after a fork the guest reseeds via VMGenID and resyncs via VMClock | nestd's `resume` on a fork's first boot: clock step to host wall clock, 64 B host entropy (RNDADDENTROPY), new machine-id and hostname; no VMGenID/VMClock code | crates/nestd/src/host.rs:1778-1780, guest.rs:297-302, crates/nest-guest/src/sys.rs:43-88 |
| sandbox/drivers/README.md | nestd refuses "either driver" unless `unconfined_driver`; listed snapshot/restore/fork as the driver interface without status | refuses the process driver and Firecracker without `jailer_bin`/`jailer`; trait has create/start/pause/resume/stop/snapshot_memory; no memory restore | crates/nestd/src/config.rs:332-343, crates/nestd/src/driver/mod.rs:37-87, driver/firecracker.rs:332-336 |
| sandbox/drivers/README.md | gVisor row without status | no gVisor driver | crates/nestd/src/driver/ (firecracker.rs, process.rs only) |
| sandbox/drivers/gvisor, lambda-microvm | no status | not built | crates/nestd/src/driver/ |
| sandbox/drivers/firecracker/README.md | VMGenID reseeds after a fork; guest agent reconnects | memory forks not built; nestd's `resume` sends 64 B of entropy mixed via RNDADDENTROPY; connections are host-initiated by nestd | crates/nestd/src/guest.rs:297-302, crates/nest-guest/src/sys.rs:38,43-88 |
| sandbox/guest-agent/README.md | `resume` after a restore; hands `busy` "while frozen" | `resume` only on a fork's first boot (restores cold-boot); nothing is ever frozen | crates/nestd/src/host.rs:1778-1780, crates/nest-guest/src/control.rs:107,115 |

## Unconfirmed

## Suspected code bugs

## Drift outside the area

## Docs with no drift
- compute/cells (cells.ts:1-64, fleet.ts:2842-2843, index.ts:639,674, Stack.lean:598,602)
- compute/brain-hosts (cells.ts:16-33 idle 1_800_000 and max_hosts 3; placement.ts:101,108-111 2 per vCPU; control.ts:13-15 5 s/20 s/30 s; nest-runner config.rs:59 120 s; agent.ts:84,327 30 s→5 min; Stack.lean:99 t3a/t3.medium). Prices already marked unverified.

## Docs done
- sandbox/drivers/gvisor, lambda-microvm, sandbox/guest-agent (the rest confirmed: vsock ports and CID 2 check transport.rs:63; retention output.rs:18-21; env exec.rs:21-46; ingress order ingress.rs:63; exact protocol_version nestd guest.rs:276; busy before configure state.rs:124; SIGHUP on drop ingress.rs:246; 200 ms drain hands/bash.rs:141)

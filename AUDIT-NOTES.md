# Audit notes (scratch; becomes the PR body, deleted before the PR)

## Corrections
| doc | said | code says | evidence |
|---|---|---|---|
| sandbox/drivers/README.md | nestd refuses "either driver" unless `unconfined_driver`; listed snapshot/restore/fork as the driver interface without status | refuses the process driver and Firecracker without `jailer_bin`/`jailer`; trait has create/start/pause/resume/stop/snapshot_memory; no memory restore | crates/nestd/src/config.rs:332-343, crates/nestd/src/driver/mod.rs:37-87, driver/firecracker.rs:332-336 |
| sandbox/drivers/README.md | gVisor row without status | no gVisor driver | crates/nestd/src/driver/ (firecracker.rs, process.rs only) |
| sandbox/drivers/gvisor, lambda-microvm | no status | not built | crates/nestd/src/driver/ |
| sandbox/drivers/firecracker/README.md | VMGenID reseeds after a fork; guest agent reconnects | memory forks not built; nestd's `resume` sends 64 B of entropy mixed via RNDADDENTROPY; connections are host-initiated by nestd | crates/nestd/src/guest.rs:297-302, crates/nest-guest/src/sys.rs:38,43-88 |
| sandbox/guest-agent/README.md | `resume` after a restore; hands `busy` "while frozen" | `resume` only on a fork's first boot (restores cold-boot); nothing is ever frozen | crates/nestd/src/host.rs:1778-1780, crates/nest-guest/src/control.rs:107,115 |

## Unconfirmed

## Suspected code bugs

## Drift outside the area

## Docs with no drift

## Docs done

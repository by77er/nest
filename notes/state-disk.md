# state-disk audit: docs/sandbox/state/disk/README.md

Checked against crates/nestd/src/{storage,s3,host,config,recovery}.rs, driver/, crates/nestd-core/src/{checkpoint,shadow,incarnation}.rs, crates/nest-guest/src/{control,sys}.rs, crates/nest-cli, deploy/host/bootstrap.sh, deploy/lean/Cell/*.lean, dev/measure-cut/results-*.json, on-host.sh, dev/rollout/.

## Corrections

The earlier, cut-off run's edits (in the `git diff origin/main` output) were each checked again, and all hold. The last row is new in this run.

| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| disk:3 | 4 MB chunks | 4 MiB, BLAKE3, all-zero chunks `null` and never stored | crates/nestd/src/storage.rs:4-5,20-21,252-261 |
| disk:12 | past the 64 MiB budget, uploaded "at once, as before" | uploaded while the VM is paused | crates/nestd/src/host.rs:3105-3109 (HOLD_BACK_BYTES = 64<<20), storage.rs:202-205 |
| disk:43 | "used to mark the disk clean ... Fixed" (tombstone) | leaves the disk dirty; retire salvages (`Sbx::runs`) | host.rs:169, 2386, 2794 |
| disk:54 | "no longer go into ... write-through cache"; "restores still cache" | committed chunks aren't cached; `keep_local` for same-host forks | crates/nestd/src/s3.rs:469-482, storage.rs:36-39 |
| disk:55 | AL2023's 6.12 kernel | host AMI is al2023-ami-kernel-6.18 (measured hosts 6.18.56) | deploy/lean/Cell/Stack.lean:479; dev/measure-cut/results-*.json `kernel` |
| disk:72, 179, 194 | "now" tombstones | the harness records `vm_running`, `vm_log`; boots a fresh root, writes aged disk as /dev/vdb | dev/measure-cut/on-host.sh:170,201,218 |
| disk:80 | M3′ "draft, not merged" | merged (#159, e5963c9); `disk_cut: auto` picks Shadow where `shadow_cut_works` | host.rs:2925-2944; storage.rs:521 |
| disk:127 | option 1 commit reads only changed chunks (implied built) | not built: `commit_cut` reads the whole shadow (`scan_file_keeping`) | host.rs:2357-2363 |
| disk:232 | `nest diff` with no status | designed, not built (no code) | crates/nest-cli/src: no diff command |
| disk:237 | today nestd "reads the disk while the VM is paused, as in M1" | it cuts in the pause (M2/M3′), or reads (M1 fallback) | host.rs:2041-2048, 2925-2944 |
| disk:244 | reason `spot` | wire name `spot_notice` | crates/nest-protocol/src/model.rs:685-697 (snake_case) |
| disk:174 | option 3 hint: clone 2.2–2.7 s in each case | 1.6–2.7 s (first run of each ~1.6 s) | dev/measure-cut/results-m3-i-04d122795c13dafcf.json `hint_0/1m/4m.ms` |

Confirmed without change: DiskCut {auto, read, locked_copy, sim_shadow} (config.rs:114-129), cut_clone_ns_per_extent 15_000, cut_read_bytes_per_s 180_000_000, shadow_pre_copy_min_ranges 4096 (config.rs:102-112), disk_cut_verify; extent_count via fsx_nextents / FIEMAP (storage.rs:412-427); guard only for whole clones (host.rs:2195-2207); cut-<n>.img, shadow-a/b.img, is_cut_file incl. shadows and .tmp (incarnation.rs:203-209, recovery.rs:185); log line fields "checkpoint: disk cut into a shadow" (host.rs:2283-2290); pause_quiesces_disk (firecracker true, process !mount_disk); reflink_works probe, warn without reflink; bootstrap: mkfs.xfs reflink=1, /srv/nest, nofail + 10 s device timeout, RequiresMountsFor drop-ins for nestd/nest-proxy/nest-gateway, 0711/0700 modes, InaccessiblePaths (deploy/host/bootstrap.sh:72-111); 8 GB/sandbox (deploy/lean/Cell/Cells.lean:19-22); all named tests exist (crates/nestd/tests/host.rs, host.rs, nestd-core/shadow.rs, scripts/tests/test_bootstrap.py); exhaustive test 512*1024 pairs (shadow.rs:341); Kani six steps (shadow.rs:393-401); model 8 steps (shadow.rs:17); guest `prepare_snapshot` = sync() (nest-guest/src/sys.rs:106-108); no guest flush request, no rate limiter (driver has no rate_limiter) -> "designed, not built" correct; M3 (base.json) has no code -> "designed, not built" correct; ublk not built.

Measured numbers: all tables and bullets in M2 (results-i-08370229efb01aa08.json), M3′ 2026-11-03 (results-m3-i-04d122795c13dafcf.json), 2026-11-04 m8id (results-m3-i-0fd14be72de7081ed.json), 2026-11-06 (results-i-0d9df429072b40932.json: pause p50 662/max 678 over 28, 19 of 28 with stall 651–686 ms, executor 2.25/2.32 s, 6.9–7.2 s, shadow-making stalls 4.58–4.82 s, M2 5.01–5.05 s, M1 31.1 s/9.7 GB, residue 36.6/39.9 MB, ~2,960 ranges), probe (results-probe-i-0705fb9b9898f4f2f.json) match the records.

## Parent summary lines to update

- docs/sandbox/state/README.md:10 — `disk: 4 MB    memory: 2 MB (one hugepage)` -> `disk: 4 MiB    memory: 2 MiB (one hugepage)` (storage.rs:20-23).
- docs/sandbox/state/README.md:34 — `([disk](...); built, not deployed)` for the reflink cut; the disk doc says M2 "Built; deploys on merge" (merged #138) and M3′ merged #159. Suggest `built: M2's reflink and M3′'s shadow cut` and drop "not deployed" unless a deploy record says otherwise.
- docs/sandbox/state/README.md:122 — `reflink cuts in a brief pause (built, not deployed), extent diffs (designed)` -> `reflink and shadow cuts in a brief pause (built), extent diffs (designed)`.
- docs/sandbox/state/README.md:88 — "A turn dirties whole 4 MB chunks" -> "4 MiB".
- docs/README.md:164-166, 215-222: consistent with the disk doc. No change needed.

## Unconfirmed claims

- disk:5 (and state/README.md:34, docs/README.md:220) — "33–39 s per turn-end checkpoint in production". Only restated in dev/rollout/2026-11-02-checkpoints-pause-only-to-read-m1.md:9 and 2026-11-03-checkpoint-cuts-m2.md:29. No record in measure-cut, cloud-checks or e2e/FINDINGS.md.
- disk:26 — "v1.17.0 ..., the line nest pins". No Firecracker version pin in the repo: scripts/publish-release.sh:17 carries the binary between releases.
- disk:14 — the mtime-before-data assumption. The doc already marks it unverified.
- disk:55 — the RefluXFS fix (CVE-2026-64600) is in the host kernel. External; not checked.
- disk:110 — 8 GB covers two cut intervals. The doc already marks it unverified.
- disk:205 — "$0.085" for about 38 min at $0.13052/h. Computed; no record of the run's duration.
- disk:48 — #160/#161 history and the 2026-11-06 probe: matches the probe JSON and dev/rollout/2026-11-05-instance-store-hosts-come-back.md.
- disk:161 — `fsx_nextents` 0.01 ms on the fresh row. The record says 0.0 (rounded).

## Suspected code bugs

None found.

## Drift outside the area

- docs/sandbox/state/README.md: the 4 MB / 2 MB units and the "not deployed" status (above).

## Docs with no drift

- docs/README.md lines 164-166 and 215-222.

# firecracker doc audit

Files: docs/sandbox/drivers/firecracker/README.md, docs/sandbox/drivers/README.md. The edits already on the branch (drivers/README.md:3, :8, :13, :14; firecracker/README.md:6) were re-checked against the code and hold: `Driver`/`Vm` in driver/mod.rs; `unconfined_driver_refusal` in config.rs:332-342 (refuses `jailer_bin` or `jailer` missing); bootstrap.sh:54-59; `RESUME_ENTROPY_BYTES = 64` and `RNDADDENTROPY` in crates/nest-guest/src/sys.rs:16,38,90.

## Corrections

| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| docs/sandbox/drivers/firecracker/README.md:9 | "pinned by binary digest, patch level included ... The digest is part of the restore ABI", which reads as built | Neither the Firecracker/jailer version nor a digest is in the repo. The binaries are carried by hand from release to release: publish-release.sh refuses a carried file whose SHA-256 differs from the current release's SHA256SUMS, and install.sh runs `sha256sum -c` before installing. So the release pins the digest, not the repo. The restore ABI descriptor is not built. Kept the decision; added "(not built)" for the restore ABI and one sentence on what is built | scripts/publish-release.sh:3-5,17,47-53; deploy/host/install.sh:29-40; images/guest/build-on-ec2.sh (no Firecracker fetch); docs/sandbox/drivers/README.md:3 (restore ABI descriptor not built) |

## Parent summary lines to update

None strictly wrong. The decision holds, since the release's SHA256SUMS pins it. Optional clarifications:
- docs/README.md:157: "Firecracker is pinned by binary digest, ..." could become "Firecracker is pinned by binary digest (the release's `SHA256SUMS`; the repo records no version), ...".
- docs/compute/provisioning/README.md:7 and docs/setup/README.md:113 say "Firecracker from the 1.17 line, pinned by (binary) digest". These are not my files. No repo record confirms 1.17 (see below).

## Unconfirmed claims

- firecracker/README.md:9: "the 1.17 line". No version string appears anywhere in the repo (grepped crates, deploy, scripts, images, dev, e2e). Firecracker comes in as an opaque carried release file.
- firecracker/README.md:14: "Built and verified (EC2 c8i-flex.large, nested, Firecracker 1.17.0, 2026-10-18) ... boots in seconds ... restored on epoch 2". No record in dev/measure-cut/, dev/cloud-checks/ or e2e/FINDINGS.md. The 2026-10-18 date also appears in the comment at config.rs:439-441 (init_on_free), which backs line 5 only.
- firecracker/README.md:5: init_on_free stall "past a minute (soft lockups in pgdatinit, 2026-10-18)". Backed only by the code comment at config.rs:439-441. No measurement record.
- firecracker/README.md:16: date "2026-10-24". The behaviour itself is confirmed (bootstrap.sh:122-130 sets nr_hugepages=0 and `huge_pages: false`; memory.max = declared + 128 MiB at firecracker.rs:180-187 and config.rs default_vm_overhead_mib).
- External: "6.18 is kernel.org's current longterm line" was not fetched. I curled the Firecracker README (8i is supported only on 6.1/6.18 host kernels), kernel-policy.md (guest 6.18 from v1.16.1, end 2028-06-01; guest 6.1 end 2026-09-02), hugepages.md (50%, UFFD, balloon, dirty-page tracking), v1.17.0 block-io-engine.md (Async not production-ready) and CHANGELOG 1.17.0 (`huge_pages` on snapshot load, `sync_snapshot_files`). All agree with the doc. network-for-clones.md returns 200. I did not check the SPACE link (perplexityai/space).

## Suspected code bugs

- None found. Note: the comment at the top of crates/nestd/src/driver/firecracker.rs (lines 3-5) says "Boots a microVM ... 2 MiB hugetlbfs memory". The code only does that when `huge_pages` is set. The default is off (config.rs:245-248), and bootstrap writes `false`. The comment is stale, but it is code, so I did not edit it.

## Drift outside the area

- crates/nestd/src/driver/firecracker.rs:3: stale "2 MiB hugetlbfs memory" in the module doc (above).
- crates/nest-protocol/src/model.rs:244: `SuspendMode::Memory` is documented as a "Full hugepage memory snapshot". Hugepages are off by default and the control plane only ever sends `disk_only` (control-plane/src/do/fleet.ts:2422, do/sandbox.ts:1277).

## Docs with no drift

- docs/sandbox/drivers/README.md. Every claim checked: bootstrap refusal (bootstrap.sh:48-59); `instanceInitiatedShutdownBehavior := "terminate"` (deploy/lean/Cell/Stack.lean:561,583); `enroll_timeout_ms` defaults to 600_000 (control-plane/src/lib/cells.ts:48) and holds the launch intent (fleet.ts:2116); `launch_types_sound` (deploy/lean/Cell/Test.lean:122); `refused_sandbox_role` (dev/cloud-checks/new_host_check.py:34); e2e sets `unconfined_driver` (e2e/run.py:288); static enrollment is exempt (config.rs:333). Relative links resolve.
- docs/sandbox/drivers/firecracker/README.md, apart from line 9. Checked: jailer `--netns`; `tap0` (net.rs:27, tap owner net.rs:107-110); jail id `<sandbox with _→->-<random hex>`, uid/gid 900 (bootstrap.sh:129, install.sh:54); stale jails removed at start (host.rs:539); modes 0660/0710/0600 and disk 0600 (firecracker.rs:106-123,219-228); `gateway_access`; default `Unsafe` cache and `Sync` engine (boot_requests sets neither); `pause_quiesces_disk`; no rate limiter or ublk in the driver; base copy grown offline with resize2fs (host.rs:1724-1732, 3245-3264); kernel `vmlinux-6.18.54` and `ubuntu-24.04.squashfs` pinned by SHA-256 from Firecracker CI (images/guest/build.sh:22-27); apt packages; GitHub placeholder; init exports /etc/environment and brings up eth0 (images/guest/init); EC2 builder (build-on-ec2.sh); disk-only generations in practice (only `disk_only` is sent). All anchors exist.

# Checkpoints pause only to read, M1 (2026-11-02)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** Only nestd changes, and it reaches hosts through the release and the host AMI pipeline as they are replaced ([disk](../../docs/sandbox/state/disk/)). No wire type, `meta.json` field or manifest format changes, so it is compatible one release back in both directions:
- **The Worker** sees the same `commit_request`s. A checkpoint's VM now runs while its commit is answered, and a commit of a disk nothing wrote since the last one carries the same manifest as that one, as identical manifests already could.
- **A previous-release nestd** on a host that ran this one finds only its own files. The sentinel left on a disk's modification time means nothing to it; it reads every disk it commits.
- **Rollback:** republishing the previous release as `releases/current` reaches hosts as they are replaced; nothing to undo.
- **Cloud check after the first deploy:** a turn-end checkpoint on a sandbox host logs `checkpoint: VM resumed ... paused_ms=` well under the old 33–39 s for a turn that changed little, and `commit: disk read ... reused=true bytes_read=0` for a turn that wrote nothing; no hands call fails during it.
- **Cloud check of the trust assumption** (every write moves the disk file's mtime before its data lands; [open question](../../docs/README.md#open-questions-and-watch-items)): on a sandbox host, write in the guest (`echo x >> /workspace/probe && sync`) and confirm the next turn-end commit logs `reused=false`; then, after a turn that wrote nothing logged `reused=true`, fork the sandbox (the child restores that generation) and compare its files with the parent's (`sha256sum`). A mismatch means turning the check off (`pause_quiesces_disk` false) before anything else.
- **M2 and M3 will need their own rules:** the cell stack and bootstrap put sandbox state on instance-store XFS with `reflink=1`, and `cut_ms` is additive on the wire.

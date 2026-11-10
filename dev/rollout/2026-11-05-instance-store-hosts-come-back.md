# Instance-store hosts come back (2026-11-05)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and nothing by hand.** `use1`'s `launchTypes` return to `c8id.large, m8id.large, r8id.large`, then the EBS-only `c8i-flex.large, c8i.large, m8i.large`, undoing #160's mitigation.
- **Why it's safe now:** #161 mounts the instance store at `/srv/nest`, outside the `/var/lib/nest` the gateway's unit hides, and the gateway's drop-in hides only the state, kernel and images. On 2026-11-06 (UTC) a real `c8id.large` ran `dev/measure-cut/probe-instance-store.sh`, with results in `dev/measure-cut/results-probe-i-0705fb9b9898f4f2f.json` (from #159).
  - It mounted the store as XFS at `/srv/nest` and built a jail with nestd's modes.
  - As `nest-gw`, under `systemd-run` with the unit's file-access properties, it connected to a unix socket in that jail: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and `InaccessiblePaths` from the AMI's unit plus the drop-in's paths.
  - The same connect under the old `/var/lib/nest/data` layout failed with `Permission denied`, as in production, and `/srv/nest/state` stayed hidden.
  - cloudflared, as `nest-cf`, entered its home under the state directory and ran `--version`.
- **Seen in production (2026-11-06 UTC):** the first host after the deploy was a `c8id.large` spot instance, `i-0996f50b291351fba` (`hst_01m6q7q25w47254j1wbvx2fys3`). It passed `hands_probe_check.py`: its real gateway, under its real unit, bound to a VM over the tunnel (`bound`, guest protocol 1). Unconfirmed: that its state was on `/srv/nest` rather than bootstrap's root-volume fallback. Bootstrap logs that choice (`/var/log/nest-bootstrap.log`, through cloud-init), but the line wasn't in the 64 KB of console output AWS returned for that host, and the check would pass the same way on the fallback.
- **Not yet proven:** that the instance store was used (above), and a reboot or stop/start of an instance-store host.
- **Who it affects:** only new hosts. Running hosts don't change. On-demand still tries the EBS-only types first (cheapest first).
- **After the deploy:** as soon as the first instance-store host enrolls, run `dev/cloud-checks/hands_probe_check.py`. It can't pick a host, so the run counts only when its `instance_type` is `c8id`, `m8id` or `r8id`; otherwise run it again. FleetDO places real sandboxes on the host from enrollment, so don't wait.
- **What a rollback does:** the launch types go back to EBS-only, so no new instance-store host launches. A running one stays in service, since there's no drain route. If its hands calls fail, save its console and logs, then terminate it (the owner's call). Its sandboxes cold-boot elsewhere from their generations.

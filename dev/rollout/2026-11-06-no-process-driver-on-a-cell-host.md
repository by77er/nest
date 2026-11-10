# No process driver on a cell host (2026-11-06)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and nothing by hand.** No Durable Object class, wire type or stored format changes; nestd.json gains an optional `unconfined_driver` (default false), which only the e2e harness sets. The sandbox launch template's user data stops falling back to the process driver: without `/dev/kvm`, Firecracker or the jailer it fails, enables nothing, never enrolls and shuts the instance down ([drivers](../../docs/sandbox/drivers/)). The release's nestd refuses the process driver and an unjailed Firecracker unless `unconfined_driver` is set.
- **Order:** the cell stack applies the new user data first; hosts then pick up the release as they are replaced. Every mix is safe: a new nestd under the previous release's user data refuses the process-driver config that user data wrote only on a host without KVM, which is the host this release retires anyway; the previous nestd under the new user data never sees one.
- **Nothing changes on a host with KVM,** which is every type `use1` launches (`launch_types_sound`). A host without KVM shuts itself down, and FleetDO ends its launch at the enroll timeout (10 min), holding scale-up meanwhile. If every launch is refused (KVM lost at run time), the cell gets no sandbox host until that is fixed: `new_host_check.py` reports `refused_sandbox_role`.
- **Rollback:** a forward revert of `bootstrap.sh` and `config.rs`. A `wrangler rollback` doesn't touch either.

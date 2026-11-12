# Sandbox

**A sandbox is a machine:** a filesystem, processes and a network. The platform makes no assumptions about what runs inside it. Everything in a sandbox shares one trust domain.

## Operations

- **Create** from an image: cold-boot it. Today the one image is `nest-base` ([firecracker](drivers/firecracker/)); restoring a [base generation](state/memory/#base-generations) instead is designed, not built.
- **Attach** agents (bind their [hands](../agents/hands/)) or humans (terminal): `attach` configures the client's slot in the guest and issues a signed binding, which the client presents to the [gateway](gateway/) from wherever it runs. They share files, services and ports, and conflicts are accepted, like two people on one machine.
- **Fork.** This is the *only* isolation primitive. A fork is an independent copy of the work, whatever kind of work it is.
- **Pause, suspend and resume. Archive.** When each happens is SandboxDO's [idle rule](../control-plane/durable-objects/sandbox/#activity-and-idle).
- **Link** (not designed yet): an opt-in path through the proxy so one sandbox can reach a port in another.

## Lifecycle

```
running ⇄ paused (on host H, memory kept)
running, paused → suspended (on H; disk-only or with memory) → running
suspended → archived (S3 only) → restore in the cell: disk on any host, memory only on a host that loads its restore ABI
```

## Fork

| Type | How | Cost |
|---|---|---|
| Disk-only (default) | Epoch-flip commit; the child's head is the same disk manifest; copy-on-write chunks | Writing a manifest plus a ~1 s cold boot |
| Live (designed, not built) | Pause, write a full memory snapshot, resume the parent; the child restores from the same chunks | 1–2 s pause for 2–4 GB |
| Same host (designed, not built) | The child reads the parent's snapshot from page cache | Near-instant |

**Built in nestd only:** disk-only forks (`sandbox_fork`), which restore on any host in the cell; the control plane doesn't send them yet, so `fork_sandbox` answers `not_implemented`. Live and same-host forks wait with [memory snapshots](state/memory/).

After a fork, nestd's `resume` has the guest agent step its clock to the host's, mix host entropy into its RNG, and set a new machine-id and hostname ([guest agent](guest-agent/)). With memory snapshots (designed), VMGenID and VMClock also reseed and resync the guest kernel. Firecracker calls resuming one snapshot more than once insecure, so a live fork treats userspace RNG state and other process state as duplicated. Forking an agent's conversation is a separate step (`--fork-session`).

**Sizing:** a sandbox's declared memory is a ceiling (its VMM's cgroup limit), not a reservation; hotplug isn't assumed, and the snapshot path's hugetlbfs memory can't be ballooned in the traditional way. Size the sandbox for the agents it will hold; if it gets crowded, fork instead of growing it.

## Components

- [drivers/](drivers/): Firecracker (primary), gVisor (not built), Lambda MicroVM (rejected)
- [state/](state/): generations, restore sources, retention, memory (restore ABI, base generations), disk, object store and GC
- [fencing/](fencing/): leases, epochs, STONITH, loss records (not built), salvage
- [networking/](networking/): identical internal network identity, egress, ingress
- [gateway/](gateway/): the only network door into a sandbox: hands, terminals and previews behind the host's tunnel
- [guest-agent/](guest-agent/): the daemon inside each VM

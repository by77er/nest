# Sandbox

**A sandbox is a machine:** a filesystem, processes and a network. The platform makes no assumptions about what runs inside it. Everything in a sandbox shares one trust domain.

## Operations

- **Create** from an image.
- **Attach** agents (bind their [hands](../agents/hands/)) or humans (terminal). They share files, services and ports, and conflicts are accepted, like two people on one machine.
- **Fork.** This is the *only* isolation primitive. A fork is an independent copy of the work, whatever kind of work it is.
- **Suspend and resume. Archive.**
- **Link** (not designed yet): an opt-in path through the proxy so one sandbox can reach a port in another.

## Lifecycle

```
running ⇄ suspended (on host H; disk-only or with memory) → archived (S3 only) → restore in the cell: disk on any host, memory only on a host with the same restore ABI
```

## Fork

| Type | How | Cost |
|---|---|---|
| Disk-only (default) | Epoch-flip commit; the child's head is the same disk manifest; copy-on-write chunks | Writing a manifest plus a ~1 s cold boot |
| Live | Pause, write a full memory snapshot, resume the parent; the child restores from the same chunks | 1–2 s pause for 2–4 GB |
| Same host | The child reads the parent's snapshot from page cache | Near-instant |

After a fork, the guest agent reseeds randomness (VMGenID), resyncs the clock (VMClock where the guest kernel supports it), and sets a new machine-id and hostname. Firecracker calls resuming one snapshot more than once insecure, so a live fork treats userspace RNG state and other process state as duplicated. Forking an agent's conversation is a separate step (`--fork-session`).

**Sizing:** hugetlbfs memory can't be ballooned in the traditional way, and hotplug isn't assumed. Size the sandbox for the agents it will hold; if it gets crowded, fork instead of growing it.

## Components

- [drivers/](drivers/): Firecracker (primary), gVisor, Lambda MicroVM
- [state/](state/): generations, memory, disk, object store
- [fencing/](fencing/): leases, epochs, STONITH, salvage
- [networking/](networking/): identical internal network identity, egress, ingress
- [guest-agent/](guest-agent/): the daemon inside each VM

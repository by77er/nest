# gVisor driver

- Uses `runsc` on the **systrap** platform, so no KVM is needed. It works on any VPS.
- A user-space kernel sits between the sandbox and the host.
- `runsc checkpoint` / `runsc restore` provide suspend and resume with memory.
- **Used only** for sandboxes in cells without KVM (e.g. a cheap VPS provider). Captains don't use sandboxes at all.
- **Cost:** syscall-heavy workloads (builds, git) run slower than on Firecracker. Benchmark before relying on it for workstreams.
- Uses the same netns and identical-network-identity pattern as Firecracker.

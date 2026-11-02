# nest

Durable Claude Code agents with isolated hands, on your own subscription.

nest runs many long-lived Claude Code agents at once. Each agent's brain is an unmodified Claude Code process on a brain host; its hands (shell and file tools) work over the network inside its own Firecracker microVM on a cheap spot sandbox host, through that host's gateway. The two never share a machine. A Cloudflare control plane holds the state, so agents survive losing their host, can wait days for an event at near-zero cost, and the whole system scales to zero when idle.

## What it does

- **Parallel agents in isolated VMs.** Fork a sandbox to give an agent its own copy of the work.
- **Durable by default.** Sessions and workspaces outlive hosts; idle agents cost nothing and wake when a message arrives.
- **Any agent structure.** Captains, reviewers, pipelines and swarms are built by agents and external apps from the kernel's primitives (sandboxes and agents), not hard-coded.
- **Safe by construction.**
  - The subscription token never enters a VM, and sandboxes hold no secrets.
  - Egress is allowlisted, with credentials injected at the proxy.
  - Authority is grants that only shrink as they're passed on.
  - A session that has read untrusted content needs approval before it can send data out.
- **One owner.** It runs on your own Claude subscription, for personal use.

## Status

Early implementation. The runtime (control plane, host daemon, egress proxy, guest agent, agent runner) exists, is tested locally, and has run on EC2 with Firecracker. The seam of the split into a sandbox system and an agent system (the gateway, bindings, per-host tunnels) is built and verified on AWS (2026-10-23, with Cloudflare Access in front since 2026-10-24), and every brain runs on a brain host (on AWS since 2026-10-29). Templates and capabilities are data; the coordination layer (channels, hooks, grants, scheduled wakes) is designed but not built. The one-brain rule and several other protocols are model-checked, and nestd's fleet link is checked as the shipped code ([verification](docs/verification/README.md)).

## Learn more

- [Architecture](docs/architecture/README.md): how the pieces fit, and a turn end to end
- [Design docs](docs/README.md): goals, principles, primitives, decisions and open questions
- [Setup](docs/setup/README.md): accounts and credentials needed to bring it up
- [End-to-end harness](e2e/README.md): running the real components together locally

## Develop

Rust on hosts and in guests; TypeScript on Cloudflare Workers.

```bash
cargo test --workspace
cd control-plane && npm ci && npm test
e2e/run.sh
```

CI runs these on every pull request; [dev/](dev/README.md) covers CI, deploys and repo settings.

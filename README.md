# nest

Durable Claude Code agents with isolated hands, on your own subscription.

nest runs many long-lived Claude Code agents at once. Each agent's brain is an unmodified Claude Code process on a brain host; its hands (shell and file tools) work over the network inside its own Firecracker microVM on a cheap spot sandbox host, through that host's gateway. The two never share a machine. A Cloudflare control plane holds the state, so agents survive losing their host, can wait days for an event at near-zero cost, and the whole system scales to zero when idle.

## What it does

- **Parallel agents in isolated VMs.** Fork a sandbox to give an agent its own copy of the work.
- **Durable by default.** Sessions and workspaces outlive hosts; idle agents cost nothing and wake on their next input.
- **A microkernel.** The platform keeps sandboxes, agents, credentials, egress policy and MCP attachment, behind a generic API for clients. Captains, task boards and review pipelines are built on that interface by agents and external apps, such as the [projects](projects/README.md) task board.
- **Safe by construction.**
  - The subscription token never enters a VM, and sandboxes hold no secrets.
  - Egress is allowlisted, with credentials injected at the proxy.
  - Authority is grants that only shrink as they're passed on.
  - A session that has read untrusted content needs approval before it can send data out.
- **One owner.** It runs on your own Claude subscription, for personal use.

## Status

Early implementation. The runtime (control plane, host daemon, egress proxy, guest agent, agent runner, gateway) is tested locally and runs on AWS: Firecracker sandboxes on spot sandbox hosts, every brain on a brain host, the two joined only through each sandbox host's gateway behind a Cloudflare Tunnel. Templates and capabilities are data, and external apps use nest as scoped API clients. The one-brain rule and several other protocols are model-checked, and nestd's cores are checked as the shipped code ([verification](docs/verification/README.md)). What is built and what isn't is in [docs/README.md](docs/README.md) and each component's README.

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

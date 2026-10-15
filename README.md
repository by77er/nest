# nest

Durable Claude Code agents with isolated hands, on your own subscription.

nest runs many long-lived Claude Code agents at once. Each agent's brain is an unmodified Claude Code process on a host; its hands (shell and file tools) work over RPC inside its own Firecracker microVM on cheap spot compute. A Cloudflare control plane holds the state, so agents survive losing their host, can wait days for an event at near-zero cost, and the whole system scales to zero when idle.

## What it does

- **Parallel agents in isolated VMs.** Fork a sandbox to give an agent its own copy of the work.
- **Durable by default.** Sessions and workspaces outlive hosts; idle agents cost nothing and wake when a message arrives.
- **Any agent structure.** Captains running workstreams, reviewers, pipelines and swarms are built by agents from three primitives (sandboxes, agents, channels), not hard-coded.
- **Safe by construction.**
  - The subscription token never enters a VM, and sandboxes hold no secrets.
  - Egress is allowlisted, with credentials injected at the proxy.
  - Authority is grants that only shrink as they're passed on.
  - A session that has read untrusted content needs approval before it can send data out.
- **One owner.** It runs on your own Claude subscription, for personal use.

## Status

Early implementation. The runtime (control plane, host daemon, egress proxy, guest agent, agent runner) exists and is tested locally, but nothing has run on real hardware yet. The coordination layer (channels, hooks, grants, capabilities, scheduled wakes) is designed but not built.

## Learn more

- [Architecture](docs/architecture/README.md): how the pieces fit, and a turn end to end
- [Design docs](docs/README.md): goals, principles, primitives, decisions and open questions
- [Setup](docs/setup/README.md): accounts and credentials needed to bring it up
- [End-to-end harness](e2e/README.md): running the real components together locally

## Develop

Rust on hosts and in guests; TypeScript on Cloudflare Workers.

```bash
cargo test --workspace
cd control-plane && npm install && npm test
e2e/run.sh
```

CI runs these on every pull request. How nest ships and maintains itself: [operations](docs/operations/README.md).

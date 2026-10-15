# nest

A personal platform that combines sandboxes with durable agents. Claude Code brains run on hosts using my subscription; their hands work through RPC in Firecracker sandboxes on spot compute; a Cloudflare control plane holds the state; agents coordinate through channels, and structures like captains and workstreams are templates and conventions, not code.

**Status:** early implementation. See the repo map in `docs/README.md`. Test with `cargo test --workspace`, `cd control-plane && npm test`, and `e2e/run.sh`.

**Stack:** TypeScript for the control plane (Cloudflare Workers + Durable Objects, Paid plan); Rust for everything on hosts and in guests.

**Scope:** Claude Code is the only harness for now.

## Design docs

Start at [docs/README.md](docs/README.md): it has the goals, principles, layer map, glossary, settled decisions, open questions and the first spike. [docs/architecture/](docs/architecture/README.md) explains the system end to end.

The docs are **hierarchical**. Each directory's `README.md` summarizes that subsystem and links down to a subdirectory for each subcomponent, recursively:

```
docs/
  architecture/    the system end to end: components, a turn's flow, failures, state, trust boundaries
  control-plane/   Cloudflare Workers + Durable Objects (fleet, sandbox, agent, channel, hook, broker), API (Discord bot), activator
  compute/         cells, controller/burst hosts, nestd, autoscaling, provisioning
  sandbox/         drivers, state (memory, disk, object store), fencing, networking (egress, ingress), guest agent (hands server)
  agents/          backends (pluggable), capabilities (pluggable tool bundles), runner (Claude Code on the host), hands (RPC tools), sessions, state tracking, tools and grants
  channels/        named durable logs: post, read, subscribe (inboxes, events, questions, memory); external sources (webhooks, email)
  orchestration/   patterns, not code: captain and worker templates, workstream conventions; quota-aware scheduling
  security/        model access, identity (credential injection, OIDC), credentials inventory
  data/            what lives in DO SQLite, R2 and S3
  interfaces/      boundary contracts (wire protocols, tool schemas); fixtures in protocol/fixtures/ are the source of truth
  setup/           everything needed to bring nest up: accounts, credentials, where they go, what each unlocks
```

## Working on the docs

- **Invariants:**
  - The subscription token never enters a VM.
  - Claude Code runs unmodified, with documented flags only.
  - No proxy decrypts OAuth traffic.
- **Agent logic belongs only in the control plane:** tool handlers, prompts and templates. Hosts are dumb runners, so any agent without hands (a captain, for example) can move to a pure-Cloudflare backend. See `docs/agents/backends/`.
- **No roles or workstreams in the platform.** Captains, workstreams and other structures are templates and conventions built from primitives (sandbox, agent, channel) and grants. See `docs/orchestration/`.
- Keep the docs succinct: decisions plus brief rationale, not narrative.
- Record a decision in the lowest-level doc that owns it, and update the summaries above it if they change.
- Record open questions in the doc that owns them and also in the list in `docs/README.md`.
- Link sources for external facts (pricing, limits, terms). Mark unverified claims as unverified.
- A new subcomponent gets its own directory with a `README.md`, linked from its parent.

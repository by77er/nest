# nest

Durable Claude Code agents with isolated hands, on my own subscription. nest is two systems joined by one network seam:
- **The sandbox system** runs machines: Firecracker microVMs on spot sandbox hosts in cells, each reached only through its host's gateway.
- **The agent system** runs loops: durable agents whose brains are unmodified Claude Code processes on brain hosts. They act on sandboxes only over the network.

A Cloudflare control plane holds the state.

**nest is a microkernel.** The kernel keeps sandboxes, agents, the broker (credentials, injection, the GitHub App), egress policy and MCP attachment. It exposes a generic client interface: API clients and grants, labels, caller identity, webhooks, live traces. Everything else is built outside it on that interface, such as the projects app in `projects/`. If something outside seems to need a special case inside, the interface is wrong: fix it generically ([principle 9](docs/README.md#principles)).

**Status:** early implementation. Test with `cargo test --workspace`, `npm test` in `control-plane/` and each app, and `e2e/run.sh`. **Stack:** TypeScript for the control plane (Workers and Durable Objects); Rust on hosts and in guests. **Scope:** Claude Code is the only harness.

## Invariants

- The subscription token never enters a VM.
- Claude Code runs unmodified, with documented flags only.
- No proxy decrypts OAuth traffic.
- Credentials never enter sandboxes: they're injected at the egress proxy.
- Agent logic lives only in the control plane: tool handlers, prompts and templates. Hosts are dumb runners, so any agent can move to a pure-Cloudflare backend (`docs/agents/backends/`).
- Where an agent loop runs and where its sandbox runs are unrelated and opaque to each other. A runner reaches a sandbox only through the seam: the SandboxDO control API and the gateway's hands data plane, by hostname and binding, never by sharing a host with it.
- Nothing app-specific is in the platform, including roles, boards and workstreams. Structures like captains are templates and conventions built from primitives and grants (`docs/orchestration/`).

`scripts/fences.toml` turns these into checks; never widen it without the owner.

## Repo

`docs/README.md` has the full map. In short:
- `control-plane/` is the Worker and Durable Objects;
- `crates/` holds the host and guest binaries;
- `protocol/` holds the wire fixtures, the source of truth for contracts;
- `deploy/` holds the cells' infrastructure;
- `e2e/` and `verification/` hold the end-to-end harness and the models;
- `dashboard/` and `projects/` are apps on nest;
- `scripts/` holds the repo guards, CI's path rules and the design-review tooling;
- `dev/` covers developing this repo.

## Docs

Start at [docs/README.md](docs/README.md) for the goals, principles, glossary, decisions and open questions, then [docs/architecture/](docs/architecture/README.md). Each directory's `README.md` summarizes its subsystem and links down to one subdirectory per subcomponent.

- Keep docs succinct: decisions plus brief rationale, not narrative. No tombstones.
- Record a decision in the lowest-level doc that owns it, and update the summaries above it.
- Record open questions where they're owned, and also in `docs/README.md`.
- Link sources for external facts; mark unverified claims as unverified.
- A new subcomponent gets its own directory with a `README.md`, linked from its parent.
- **Developing this repo isn't platform design.** CI, deploys, repo settings and using nest to maintain this repo live in `dev/`. The design docs stay generic.

## Skills

Skills live in [.claude/skills/](.claude/skills/); `nest-change-flow` routes between them. Use the ones that fit the change:

| Change | Skills |
|---|---|
| Any change | `nest-change-flow`, `nest-tests`, `nest-validation` |
| Control plane | `nest-control-plane` |
| Host binaries | `nest-host` |
| Wire contracts | `nest-wire` |
| Infrastructure | `nest-infra` |
| Models and proofs | `nest-verification` |
| Frontend (`dashboard/`, `projects/src/ui/`) | `nest-ui-design` |
| Review | `nest-review` (code), `nest-design-review` (frontend) |

**Every frontend change needs a design review.** A PR touching `dashboard/**`, `projects/src/ui/**` or the `nest-ui-design` skill merges only after an independent design review (`nest-design-review`) passes, in addition to the code review. Its tooling is [scripts/ui-review/](scripts/ui-review/README.md).

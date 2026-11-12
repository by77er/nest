# GitHub env names reserved only beside kernel GitHub access (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** Control plane only: no Durable Object class, table, kv key or wire message changes. `GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS` and `GIT_CONFIG*` leave `EnvName`'s reserved list; SandboxDO and the spec expansion refuse them only beside kernel GitHub access ([environment](../../docs/control-plane/api/clients/#environment)).

- **Mixed versions within a deploy:** a Worker on this release can send a SandboxDO still on the previous code an env with these names (its `create`, `setClientLayer` and `attach` store what they're given), and that SandboxDO doesn't check them against its repos. The window is the deploy's own, and the backstop below cleans it up at the next `agent_attach`.
- **What a `wrangler rollback` does with what this release wrote:**
  - **Templates** (CatalogDO): the previous release parses each stored row with its `Template` schema, which refuses these names, so a template whose `env` names one is skipped (logged: "does not parse; skipped") and can't be spawned until the roll-forward; every other template is unaffected ("a row that doesn't parse is skipped, not fatal" in `test/templates.test.ts`).
  - **A sandbox's env and an agent's** (kv `client_env`, `agent_env`): read without a schema, so the previous release still sends them in `agent_attach`. It doesn't refuse an agent with repos attaching beside them, so for the rollback's duration such a sandbox's `gh` can use the client's token over nest's. That gives nobody a credential they didn't hold: the value is the client's own, and the push guards apply whatever credential a request carries. Rolled forward, `agent_attach` drops the names wherever kernel access is present ("a sandbox a previous release left with GitHub names …" in `test/client-layer.test.ts`).
  - **Its API:** a client's write naming one is refused (400) by the previous release's `EnvName`, as before this release. `GET …/client-policy` answers the env as stored.
- **No shim to drop.** The reservation and its backstop go with the kernel's GitHub token (C3 in the migration).
- **Cloud check:** a client creates a sandbox with `env: {"GH_TOKEN": "x"}` and no `github_push` (201); the same with `github_push: {"workflows": true}` answers 400 naming `GH_TOKEN`.

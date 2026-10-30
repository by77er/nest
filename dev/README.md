# Developing nest

How this repo is built, tested and shipped, and how nest's own agents will maintain it. **This is about the project, not the platform.** Running nest on its own repo is one use of the [repo maintenance](../docs/orchestration/repo-maintenance/) pattern, so it lives here, outside `docs/`.

> Built:
> - CI (`.github/workflows/ci.yml`), `.github/CODEOWNERS`, branch protection on `main` (`ci-ok`) and the `production` environment;
> - the repo guards (`scripts/`);
> - the agent skills (`.claude/skills/`);
> - the first cut of the deploy (`deploy.yml`: infra, the Worker with a smoke check and rollback, the host release; `deploy-dashboard.yml`) and nightly fuzzing (`fuzz.yml`).
>
> The rest (the reviewer's `nest/review` check, the health window, `rollback.yml`, nest's own agents on this repo) is a plan.

## Pipeline

```
worker ── push + github.create_pr{auto_merge} ──► PR
PR ── ci.yml (ci-ok) ──────────────────────────────┐
PR ── reviewer: nest/review check ────────────────┤──► GitHub auto-merge (squash) ──► main
PR ── me, only if CODEOWNERS paths changed ───────┘
main ── ci.yml green ──► deploy.yml (environment production): infra ─► wrangler deploy ─► smoke ─► 10-min health window ─► host release
                                                                                  └─ regression ─► wrangler rollback, deploys pause
runtime ── Worker, DOs, hosts ──► Analytics Engine ◄── metrics_query ── monitor agent
```

## The gates live outside nest

nest's guardrails (grants, taint, nest-proxy, the runner's hygiene rules) are code in this repo, so agents changing this repo could weaken them. Every gate that protects them is enforced by GitHub or Cloudflare, never by nest:

- **Branch protection on `main`:** required CI checks, the reviewer's `nest/review` check pinned to the App, and no bypass except mine.
- **`CODEOWNERS`:** changes to the gates, dependencies, secrets handling, authority checks, egress enforcement and launch hygiene need my review.
- **Deploy credentials live in a GitHub environment that only `main` can use.** Agents never hold them, and a branch's workflow can't reach them.
- **Rollback runs in GitHub Actions,** so recovering from a bad deploy doesn't depend on the agents it may have broken.

## Decisions

| Decision | Doc |
|---|---|
| Agents auto-merge PRs that pass CI and the reviewer's check, except changes to `CODEOWNERS` paths, which need me | [github.md](github.md) |
| Merges deploy the control plane to production; a health window rolls back on regression, and deploys pause until a fix or my say-so | [deploy.md](deploy.md) |
| nest's agents reach this repo through a GitHub App from the start | [github.md](github.md) |

## Files

| File | What |
|---|---|
| [ci.md](ci.md) | The checks every change must pass |
| [deploy.md](deploy.md) | `deploy.yml`, the health window, `rollback.yml` |
| [github.md](github.md) | The App's permissions and bindings for this repo, branch protection, merge policy |
| [setup.md](setup.md) | What I set up on GitHub and Cloudflare for all of the above |
| [practices.md](practices.md) | Guards, test rules, evidence tiers, review and supply chain: what keeps agent-written changes safe |
| [review-lessons.md](review-lessons.md) | Standalone lessons from real findings, checked on every review |
| [verification.md](verification.md) | The formal models in `verification/` and their CI jobs |

## Path to self-maintenance

1. **CI, `CODEOWNERS`, guards and agent skills.** Done.
2. **Me:** the GitHub and Cloudflare steps in [setup.md](setup.md), and stages 1–3 of the [platform setup](../docs/setup/) (a Claude token, the control plane on Cloudflare, cell hosts). Done, except `nest/review` as a required check, which waits for the hand-over.
3. **Build the minimum platform slice,** in this order. Each step is a PR through the gates above, with me as reviewer until step 4:
   1. ChannelDO with posts, reads, subscriptions and wakes; the `user` channel through the API.
   2. Grants (taint included), and a channel in place of WorkstreamDO. Spawn specs, templates and capabilities are built.
   3. HookDO with GitHub verification, and `wake_at`.
   4. BrokerDO's GitHub App minting and the `github.*` brokered actions.
   5. A dev sandbox image: git, `gh`, Rust, Node, Python, nftables, with a warm build cache.
   6. Metrics emitters, the `metrics` capability, and the rest of `deploy.yml` (the health window).
4. **Hand over:** spawn the maintainer and the monitor. From then on, agents build the rest (Discord, versioned host rollout), and I review only `CODEOWNERS` paths.

Workspaces don't need the S3 store first: for a code repo, git is the durable copy, so a lost sandbox costs a re-clone.

## Open questions

- **Branch protection on a private personal repo:** GitHub's docs say GitHub Pro covers it, but users report rulesets not enforcing there (unverified). Use classic branch protection and confirm it shows as enforced.
- **Code-owner review with zero required approvals:** expected to still require my approval on owned paths (unverified). [setup.md](setup.md) tests it.

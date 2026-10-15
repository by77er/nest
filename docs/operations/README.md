# Operations

How nest itself is built, tested, deployed and watched, and how its own agents maintain it. **The goal:** nest maintains this repo. Agents propose, review and merge changes; CI/CD ships them; a monitor watches the runtime and raises regressions. The agents are the [repo maintenance](../orchestration/repo-maintenance/) pattern; this directory holds what they run against.

> Built: CI (`.github/workflows/ci.yml`) and `CODEOWNERS`. Everything else here is designed, not built; the [build order](#path-to-self-maintenance) says what comes first.

## The gates live outside nest

nest's guardrails (grants, taint, nest-proxy, the runner's hygiene rules) are code in this repo, so agents changing this repo could weaken them. Every gate that protects them is enforced by GitHub or Cloudflare, never by nest:

- **Branch protection on `main`:** required CI checks, the reviewer's `nest/review` check pinned to nest's GitHub App, and no bypass except mine. See [github/](github/).
- **`CODEOWNERS`:** changes to the gates, dependencies, secrets handling, authority checks, egress enforcement and launch hygiene need my review.
- **Deploy credentials live in a GitHub environment that only `main` can use.** Agents never hold them, and a branch's workflow can't reach them.
- **Rollback runs in GitHub Actions,** so recovering from a bad control-plane deploy doesn't depend on the agents that deploy may have broken.

## Pipeline

```
worker ── push + github.create_pr{auto_merge} ──► PR
PR ── ci.yml: rust · control-plane · e2e · docs ──┐
PR ── reviewer: nest/review check ────────────────┤──► GitHub auto-merge (squash) ──► main
PR ── me, only if CODEOWNERS paths changed ───────┘
main ── ci.yml green ──► deploy.yml (environment production): wrangler deploy ─► smoke ─► 10-min health window
                                                                        └─ regression ─► wrangler rollback, deploys pause
runtime ── Worker, DOs, hosts ──► Analytics Engine ◄── metrics_query ── monitor agent
```

## Components

| Component | What | Doc |
|---|---|---|
| CI | The checks every change must pass | [ci/](ci/) |
| Deploy | Control-plane CD with a health window and automatic rollback; host rollout | [deploy/](deploy/) |
| Metrics | Workers Analytics Engine: what's emitted, how it's read | [metrics/](metrics/) |
| GitHub | nest's GitHub App, token scoping, branch protection, `CODEOWNERS`, merge policy | [github/](github/) |

## Decisions

| Decision | Owning doc |
|---|---|
| Agents auto-merge PRs that pass CI and the reviewer's check, except changes to `CODEOWNERS` paths, which need me | [github/](github/) |
| Merged changes deploy to production automatically; a health window rolls back on regression, and deploys pause until a fix or my say-so | [deploy/](deploy/) |
| GitHub access is a GitHub App from the start; BrokerDO mints installation tokens downscoped per binding | [github/](github/) |
| Runtime metrics go to Workers Analytics Engine, read through a `metrics` capability | [metrics/](metrics/) |

## Path to self-maintenance

1. **CI and `CODEOWNERS`.** Done.
2. **Merge this branch into `main`.** `main` still holds only the initial commit.
3. **Me, on GitHub:** turn on branch protection (a private repo on a personal account needs GitHub Pro), create and install the App, create the `production` environment. See [setup](../setup/#stage-4-self-maintenance).
4. **Stages 1–3 of [setup](../setup/):** a real Claude token, the control plane on Cloudflare, one controller host and one burst host.
5. **Build the minimum slice,** in this order (each is a PR through the gates above, with me as reviewer until step 6):
   1. ChannelDO with posts, reads, subscriptions and wakes; the `user` channel through the API.
   2. Spawn specs, templates, capabilities and grants (taint included), replacing roles and WorkstreamDO.
   3. HookDO with GitHub verification, and `wake_at`.
   4. BrokerDO's GitHub App minting and the `github.*` brokered actions.
   5. The dev sandbox image: git, `gh`, Rust, Node, Python, nftables, with a warm build cache.
   6. Metrics emitters, the `metrics` capability and `deploy.yml`.
6. **Hand over:** spawn the maintainer and the monitor. From then on, agents build the rest (Discord, the autoscaler, the S3 store, host rollout), and I review only `CODEOWNERS` paths.

Workspaces don't need the S3 store first: for a code repo, git is the durable copy, so a lost sandbox costs a re-clone.

## Open questions

- **Branch protection on a private personal repo:** GitHub's docs say GitHub Pro covers it, but users report rulesets not enforcing there (unverified). Use classic branch protection and confirm it shows as enforced. See [github/](github/).
- **Code-owner review with zero required approvals:** expected to still require my approval on owned paths (unverified). Test with a throwaway PR before relying on it.
- **Taint can't tell sandbox output from outside content.** Hands output taints every worker, so taint can't decide which PRs may auto-merge. Auto-merge rests on keeping outside content away from this repo's workers (see [repo maintenance](../orchestration/repo-maintenance/#why-auto-merge-is-safe-enough)). Recording a taint *source* (hands, web, hook) per session would let a PR from a session that read the web wait for me.

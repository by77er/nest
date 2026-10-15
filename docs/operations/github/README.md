# GitHub

How nest's agents reach GitHub, and the repo settings that bound what they can merge. **Decided: a GitHub App from the start,** with tokens minted by BrokerDO and downscoped per use; **low-risk changes auto-merge,** and `CODEOWNERS` paths need me. Not built beyond `CODEOWNERS`.

## The App

One App, owned by me and installed only on `by77er/nest`.

| Repository permission | Why |
|---|---|
| Contents: read and write | Push branches |
| Pull requests: read and write | Open PRs, comment, enable auto-merge |
| Issues: read and write | Pick up and file work |
| Checks: read and write | Read CI; post the `nest/review` check |
| Actions: read and write | Read logs; dispatch `rollback.yml` |
| Workflows: read and write | Push changes to `.github/workflows/` (merging them still needs me) |
| Deployments: read | See deploy outcomes and the pause |
| Metadata: read | Required |

- **Webhook:** the App's single webhook points at a [hook](../../channels/sources/) (`https://<control plane>/v1/hooks/<hk_…>`, with the secret shown to me once). Events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issues`, `issue_comment`, `check_run`, `check_suite`, `workflow_run`, `push`, `deployment_status`. One hook covers every installed repo, so no per-repo webhook permission is needed.
- **No Administration permission:** the App can't change branch protection, rulesets, environments or secrets.
- **Commits** are authored as the App's bot user, so history shows which changes agents made.

## Tokens

BrokerDO holds the App's private key and mints installation tokens: a JWT signed with the key, then `POST /app/installations/<id>/access_tokens` with the binding's `repositories` and `permissions`. A token can only narrow the installation's access and expires after an hour ([API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)); BrokerDO caches it for 50 minutes.

| Binding | Used by | Reaches | Permissions |
|---|---|---|---|
| `github:dev` | Workers | The sandbox, through nest-proxy [injection](../../sandbox/networking/egress/injection/) (`git push`, `gh`) | contents, pull requests, workflows: write; checks, actions, issues: read |
| `github:review` | Reviewers | Brokered actions only (`github.review_check`, `github.review_comment`) | checks, pull requests: write; contents: read |
| `github:ops` | The maintainer and the monitor | Brokered actions and the `github_ro` capability | issues, pull requests, actions: write; contents, checks, deployments: read |

**The required `nest/review` check can only come from a `github:review` token,** and only reviewers' grants reach that binding. Since every binding is the same App to GitHub, this separation is nest's (BrokerDO's scoping), not GitHub's.

## Repo settings

| Setting | Value |
|---|---|
| Plan | **GitHub Pro** (or a Team organization): branch protection on a private repo needs it. Users report rulesets not enforcing on personal private repos even on Pro (unverified), so use classic branch protection |
| Branch protection on `main` | Require a pull request, 0 approvals, review from Code Owners. Required checks: `rust`, `control-plane`, `e2e`, `docs` (from GitHub Actions) and `nest/review` (pinned to the App as its source, so a same-named check from anything else doesn't count). Not "up to date before merging": PR CI already runs on the merge with `main`, and deploys wait for CI on `main`. No force pushes or deletions. Administrators (me) may bypass |
| Merging | Allow auto-merge; squash only; delete head branches |
| Actions | Workflow permissions read-only; "Allow GitHub Actions to create and approve pull requests" off |
| Environment `production` | Deployment branches: `main` only. Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ANALYTICS_TOKEN` |

- **A branch's workflow can't reach deploy secrets.** Same-repo PRs run their own workflow files, but the environment refuses any ref but `main`, and CI itself holds no secrets.
- **Workflow tokens can't fake the review:** a `GITHUB_TOKEN` check comes from GitHub Actions, not the App, so it fails the source pin.

## Merge policy

- **Low-risk** means no `CODEOWNERS` path changed. Such a PR merges when CI and `nest/review` pass.
- **`CODEOWNERS` paths** (`.github/CODEOWNERS`) need my approval as well: the gates (`.github/`, `scripts/`, `CLAUDE.md`, `.claude/`), dependency manifests and lockfiles, deploy config and DO migrations, API auth, BrokerDO, host identity, the root CA, EC2 access, the authority checks (`control-plane/src/authz/`), nest-proxy, the runner, Claude Code launch config and managed settings, sandbox networking and drivers, and `docs/security/` and `docs/operations/`.
- **"Low-risk" isn't "can't leak":** any control-plane module runs with every binding, and host code runs as root. What makes agent review enough there is that nothing from outside reaches this repo's workers (see [repo maintenance](../../orchestration/repo-maintenance/#why-auto-merge-is-safe-enough)), plus CI, the health window and rollback for honest mistakes.
- **Widening:** I move paths out of `CODEOWNERS` as trust grows; that change itself needs me.

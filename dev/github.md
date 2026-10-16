# GitHub

How nest's agents reach this repo, and the repo settings that bound what they can merge. **Decided:** a GitHub App from the start, with tokens minted by [BrokerDO](../docs/control-plane/durable-objects/broker/); low-risk changes auto-merge, and `CODEOWNERS` paths need me. Built: `CODEOWNERS` only.

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

- **Webhook:** the App's one webhook points at a [hook](../docs/channels/sources/), with the secret shown to me once. Events: `pull_request`, `pull_request_review`, `pull_request_review_comment`, `issues`, `issue_comment`, `check_run`, `check_suite`, `workflow_run`, `push`, `deployment_status`. It covers every repo the App is installed on, so no per-repo webhook permission is needed.
- **No Administration permission:** the App can't change branch protection, environments or secrets.
- **Commits** are authored as the App's bot user, so history shows which changes agents made.

**Bindings** (BrokerDO narrows each token to these):

| Binding | Used by | Permissions |
|---|---|---|
| `github:dev` | Workers, injected in their sandboxes | contents, pull requests, workflows: write; checks, actions, issues: read |
| `github:review` | Reviewers, through brokered actions | checks, pull requests: write; contents: read |
| `github:ops` | The maintainer and the monitor, through brokered actions and `github_ro` | issues, pull requests, actions: write; contents, checks, deployments: read |

## Repo settings

| Setting | Value |
|---|---|
| Plan | **GitHub Pro** (or a Team organization): branch protection on a private repo needs it. Users report rulesets not enforcing on personal private repos even on Pro (unverified), so use classic branch protection |
| Branch protection on `main` | Require a pull request, 0 approvals, review from Code Owners. Required checks: `ci-ok` (from GitHub Actions; it aggregates every CI job) and `nest/review` (pinned to the App as its source, so a same-named check from anything else doesn't count). Not "up to date before merging": PR CI already runs on the merge with `main`, and deploys wait for CI on `main`. No force pushes or deletions. Administrators (me) may bypass |
| Merging | Allow auto-merge; squash only; delete head branches |
| Actions | Workflow permissions read-only; Actions may not create or approve pull requests |
| Environment `production` | Deployment branches: `main` only. Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ANALYTICS_TOKEN` |

- **A branch's workflow can't reach deploy secrets.** Same-repo PRs run their own workflow files, but the environment refuses any ref but `main`, and CI itself holds no secrets.
- **Workflow tokens can't fake the review:** a `GITHUB_TOKEN` check comes from GitHub Actions, not the App, so it fails the source pin.

## Merge policy

- **Low-risk** means no `CODEOWNERS` path changed. Such a PR merges when CI and `nest/review` pass.
- **`CODEOWNERS` paths** need my approval as well:
  - the gates: `.github/`, `scripts/`, `CLAUDE.md`, `.claude/`, and the toolchain, lint, dependency and secret-scanning configs;
  - dependency manifests and lockfiles;
  - deploy config and DO migrations;
  - API auth, BrokerDO, host identity, the root CA and EC2 access;
  - the authority checks (`control-plane/src/authz/`);
  - nest-proxy, the runner, and Claude Code's launch config and managed settings;
  - sandbox networking and drivers;
  - `docs/security/` and `dev/`.
- **"Low-risk" isn't "can't leak":** any control-plane module runs with every binding, and host code runs as root. Agent review is enough there only because nothing from outside reaches this repo's workers (see [why auto-merge is safe enough](../docs/orchestration/repo-maintenance/#why-auto-merge-is-safe-enough)). CI, the health window and rollback cover honest mistakes.
- **Widening:** I move paths out of `CODEOWNERS` as trust grows, and that change itself needs me.

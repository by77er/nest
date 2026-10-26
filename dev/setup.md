# Setup for self-maintenance

What I set up so nest can maintain this repo, beyond the [platform setup](../docs/setup/) (stages 1–3). The GitHub steps can be done now; CI and `CODEOWNERS` are already in the repo. The [credential rules](../docs/setup/#rules-for-every-credential) apply: never paste a credential into a chat.

| What | How | Where it goes |
|---|---|---|
| **GitHub Pro** | github.com → Settings → Billing and plans, or move the repo to a Team organization. Branch protection on a private repo needs it. | — |
| **Repo settings** | Settings → General: allow auto-merge, squash merging only, automatically delete head branches. Settings → Actions → General: workflow permissions read-only, and Actions may not create or approve pull requests. | — |
| **Branch protection on `main`** | Settings → Branches → add a classic branch protection rule, as in [github.md](github.md#repo-settings). Require `ci-ok`; it shows up for selection once CI has run on a PR. Add `nest/review` at hand-over; until then I merge with my own review. | — |
| **The GitHub App** | Settings → Developer settings → GitHub Apps → New: the permissions and events in [github.md](github.md#the-app), "Only on this account", webhook inactive until the control plane is up. Generate a private key, then install the App on `by77er/nest` only. | Cloud environment: `NEST_GITHUB_APP_ID`, `NEST_GITHUB_APP_PRIVATE_KEY` (the PEM) |
| **An analytics read token** | Cloudflare → My Profile → API Tokens → Create Custom Token: Account → Account Analytics → Read | Cloud environment: `CLOUDFLARE_ANALYTICS_TOKEN` (the setup agent stores it as `cap:metrics`) |
| **Environment `production`** | Settings → Environments → New environment; deployment branches: `main` only. Add six environment secrets: a **second** Edit Cloudflare Workers token (so GitHub's copy can be revoked on its own), the account ID, the tunnel token (Account: Cloudflare One Connector: cloudflared → Edit, Zone: DNS → Edit on the nest zone), which the deploy writes to the Worker, an Access token (Account › Access: Apps and Policies › Edit, and Account › Workers R2 Storage › Edit) for the `edge` stack, and the control plane's admin token, which the dashboard deploy writes to the dashboard Worker; and another analytics read token for the planned health window (no workflow reads it yet). Also create the SSM parameter `/nest/control-plane/vars/CLOUDFLARE_ACCOUNT_ID` next to the other vars (`AWS_CELLS` is written by the cell stack). | GitHub environment secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_API_TOKEN`, `CLOUDFLARE_ACCESS_API_TOKEN`, `NEST_ADMIN_TOKEN`, `CLOUDFLARE_ANALYTICS_TOKEN` |

**Then, in a new session, the setup agent checks the gates as the App.** PRs I author prove nothing, since I can bypass. It opens two throwaway PRs and confirms that GitHub reports:
- one outside the `CODEOWNERS` paths mergeable on green CI;
- one under `.github/` blocked on code-owner review.

If the rule shows as not enforced, the plan doesn't cover it.

**Cleanup:** delete the App (its key goes with it), the `production` environment, and GitHub's copies of the Cloudflare tokens.

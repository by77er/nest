# Brokered actions

A capability's `brokered` source grants **actions the control plane runs for the agent**, with credentials no agent, brain host or sandbox ever holds: GitHub writes through the GitHub App, and HTTP requests through an operator-defined profile. AgentDO runs the pipeline (`control-plane/src/lib/brokered.ts`, `lib/github.ts`, `do/agent.ts`); BrokerDO keeps the credentials and mints GitHub tokens ([BrokerDO](../../../control-plane/durable-objects/broker/)).

## Catalog

```yaml
capability: gh-nest
brokered:
  - {action: github.create_pr, repos: [by77er/nest]}          # scoped: allow when tainted (the default)
  - {action: github.comment, repos: [by77er/nest]}
  - {action: github.create_issue}                              # unscoped: any repo the App is installed on; approve when tainted
  - {action: http.request, profile: status, base_url: https://api.example.com/v1, methods: [GET, POST], paths: [/incidents],
     auth: {secret: "http:status", header: authorization, scheme: Bearer}, trusted: false, idempotency_header: Idempotency-Key}
prompt: Open PRs and comment on by77er/nest; file issues anywhere the App is installed (the operator approves those from a tainted session).
```

- **Actions:** `github.comment`, `github.create_issue`, `github.create_pr`, `github.review_comment`, `github.fork` ([forks](#forks)), `http.request`. `email.send` is reserved: no email provider exists, so the catalog refuses it and a call answers `not_implemented`. The design's `github.review_check`, `github.dispatch_workflow` and `github.create_webhook` aren't built.
- **Each entry takes:** `when_tainted` (`approve` or `allow`) and `per_hour` (1–1000; default 30 for GitHub, 60 for a profile). GitHub entries take `repos` (`owner/name`, compared without case); a profile takes `profile` (a name), `base_url` (`https`, no credentials, query or fragment; loopback only with `ALLOW_LOOPBACK_BROKERED=1`), `methods`, optional `paths` (whole-segment prefixes, the [injection](../../../sandbox/networking/egress/injection/#scope) safe-path rules), `auth` (a BrokerDO secret `http:<name>` sent as `<header>: <scheme> <value>`; never `host`, framing, `cookie`, `accept` or `content-type`), `trusted` and `idempotency_header`.
- **Spawn:** the expanded spec copies each entry (`AgentSpec.brokered`), defaults resolved. With a [push allowlist](#repo-allowlists), its unscoped GitHub entries are scoped to it. `overrides.tools` narrows them by tool name: a given list keeps only the actions it names.
- **Rollback:** a previous Worker reading a capability or spec with `brokered` ignores the field (zod strips unknown keys), so the actions are just unavailable.

## Tools

**Decided (2026-10-31): one tool per granted action, plus the generic `brokered{action, args}`.** `tools_list` lists `github_comment`, `github_create_issue`, `github_create_pr`, `github_review_comment` and `http_request` for the actions the spec grants, each with its own schema, narrowed to the grants (the `repo` enum is the scoped repos; the `profile` enum the agent's profiles, each described with its base URL and methods). **Why:** the model gets a schema per action and sees what it may do; the names are the design's with `_` for `.`, because an API tool name matches `^[a-zA-Z0-9_-]{1,128}$`, with no `.` ([define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools), read 2026-10-31; unverified for Claude Code's MCP names). `brokered` (a registry tool) reaches the same actions under the same checks, for a backend that wants one entry point. No mcp capability may make a name a brokered tool has (`github_…` from an mcp capability named `github` is refused).

## The pipeline

Per call, in AgentDO, in this order ([taint and sinks](../../tools/#taint-and-sinks)):

1. **Grant:** a grant of that action covering the repo (or the profile, its method and path). None: `forbidden`. Several covering grants (from several capabilities) are separate: the call is allowed when tainted if any allows it, and gets the highest cap.
2. **Hourly cap:** per agent and action, counted from the journal (refused calls don't count): `rate_limited`, retryable, with when a slot frees.
3. **Secret scan:** every string in the arguments (keys too) is checked for credential shapes (GitHub, Anthropic, AWS, Slack and Stripe prefixes, PEM private keys) and against every BrokerDO secret's value, its base64, any long string inside a JSON value and a PEM's body lines (`BrokerDO.scanSecrets`, which answers names only). A hit is refused (`forbidden`, "the arguments contain …" with the kind, never the value or which secret), journaled as `refused` with what matched and without the arguments, and never reaches the approval question. **Why before the gate:** the operator's question shows the arguments.
4. **Sink gate:** the [one gate](../../tools/#taint-and-sinks) every sink uses. GitHub writes are sinks; a profile is a sink unless its methods are only `GET` and `HEAD`. `github.fork` waits for the operator from any session, tainted or not.
5. **Current external state:** a pull request: an open one from the same head to the same base is returned (`existing: true`) instead of a second. A redelivered call (an AgentDO eviction mid-call): GitHub is read for what that very call posted, by its marker.
6. **Run:** the epoch is checked and the journal row written `sending` in the same synchronous step as the request leaves.
7. **Journal:** the outcome, durable before the result goes back.

## Idempotency

- **Natural keys:** a pull request is `(repo, head, base)` (GitHub keeps one open pull request per pair); a comment, issue or review comment is the call itself, found again by a hidden marker the posted text carries (`<!-- nest:<24 hex of SHA-256 of the call key> -->`), so no agent id is public; a request is the call.
- **A lost answer** (timeout, network, 5xx): GitHub is read once; a comment, issue or PR it shows is the result, otherwise `outcome_unknown`. A pull request refused with 422 is read again too (one made meanwhile). A profile request is retried once only for `GET`, `HEAD`, `PUT` or `DELETE`, or with the profile's `idempotency_header` (sent with the key's digest); otherwise `outcome_unknown`.
- **Redelivery:** a call key with a settled journal row gets its stored outcome. One still `sending` reads GitHub first and sends only when its marker isn't there (a profile request only when retryable), without the cap, scan or gate again (they passed).

## Results and taint

- **GitHub:** the result is ids and URLs only (`number`, `id`, `url`, `existing`), never GitHub's text (a pull request found by its head is someone's title): no taint. A refusal carries GitHub's message.
- **Profiles:** the status, `content-type`, `location` of a redirect (not followed: the credential never goes to another origin) and the body (up to 64 KiB), with the credential masked wherever the answer reflects it. The answer taints unless the profile is `trusted`.

## GitHub permissions

Each action's installation token is minted for its one repo and only: `github.comment` `{issues: write, pull_requests: write}` (the issue-comment endpoint is listed under both, and a pull request's comment needs the latter: [permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)), `github.create_issue` `{issues: write}`, `github.create_pr` and `github.review_comment` `{pull_requests: write, contents: read}`. **`contents: read` isn't in GitHub's permission table** for these endpoints, but GitHub reads the refs with the token: a `create_pr` with only `pull_requests: write` was refused 422 "not all refs are readable", and that token got 403 on `GET /git/ref/heads/main` where one with `contents: read` got 200 (observed 2026-10-31 by the live brokered check). `review_comment` gets it too because it names a commit (unverified that it needs it). The App must hold them on the installation; a mint asking for more than it holds is refused by GitHub. Endpoints: [issue comments](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment), [issues](https://docs.github.com/en/rest/issues/issues#create-an-issue), [pulls](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [review comments](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request).

## Repo allowlists

**Built.** An agent's spec may carry a push allowlist (`repos`: the template's, replaced by the operator's `overrides.repos`, narrowed by a spawner; [policy](../../../sandbox/networking/egress/policy/#repo-allowlists)). Then an **unscoped** GitHub grant ("any repo the App is installed on") reaches only those repos, and the tool's `repo` enum lists them; a **scoped** grant keeps the repos the catalog named, so existing catalogs work unchanged; `github.fork`'s repos are upstreams and keep their own scope. No allowlist: nothing changes. [Read-only repos](../../../sandbox/networking/egress/policy/#read-only-repos) scope no action: every action writes. **Why not intersect scoped grants too:** every catalog written before allowlists would lose its actions, and a scoped grant is already the operator's explicit choice.

## Forks

**Decided (2026-11-01): `github.fork`, then a compare link the operator opens.** For a public repo the owner doesn't own:

- **The App can't fork it.** GitHub's fork endpoint works for a GitHub App only when "the GitHub App [is] installed on the destination account with access to all repositories and on the source account with access to the source repository" ([create a fork](https://docs.github.com/en/rest/repos/forks#create-a-fork), read 2026-11-01), and the App isn't installed upstream. So the fork is made with **the operator's own token**, `github_user` in BrokerDO: a fine-grained PAT needs Administration (write) and Contents (read) for `POST /repos/{owner}/{repo}/forks` ([fine-grained permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens); unverified that it suffices to fork another account's public repo). The answer is 202 and the fork's git objects can take a moment.
- **`github.fork{repo}`** (an entry `{action: github.fork, repos?: [upstreams]}`; default 5 an hour): always the operator's approval; then `POST /repos/{upstream}/forks {default_branch_only: true}` with `github_user`, and the fork joins the agent's part of its sandbox's push allowlist while attached. A lost answer or a redelivery asks GitHub again (that GitHub answers the existing fork for a repeat is unverified). The result is ids and URLs: `fork`, `url`, and `compare`, `https://github.com/<upstream>/compare/<base>...<fork-owner>:<fork-name>:<branch>`.
- **The fork needs the App to push to it:** a new fork isn't in an installation with "Only select repositories" until the operator adds it; "All repositories" includes repos created later (GitHub's settings page; unverified in GitHub's docs). Without it, the mint leaves the fork out (audited) and pushes fail at GitHub.
- **The upstream pull request is the operator's:** the agent pushes its branch to the fork and hands over the compare link (in its final text, or through a coordination integration); the operator opens it. **Why not an action:** the App can't open a PR upstream, and a fine-grained PAT can't write to public repos the user doesn't own or belong to through an org: "Only personal access tokens (classic) have write access for public repositories that are not owned by you or an organization that you are not a member of" ([managing tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), read 2026-11-01). A classic PAT with `public_repo` would reach every public repo the owner can, far beyond one PR. An action through one, always `approve`, is an open question.

## Journal

AgentDO's `brokered_journal`, one row per call key: action, target (repo or profile), natural key, arguments digest, the arguments (4 KiB; withheld for a refusal), `sending`, `done`, `failed`, `unknown` or `refused`, attempts, what it came to, the session's taint, created and settled times. Pruned after 7 days with the call ledger. The operator reads it with `GET /v1/agents/:agent/brokered?limit=&before=` (newest first).

## Not built

`email.send` (no provider), an upstream pull request through the operator's token ([forks](#forks)), `github.review_check`, `github.dispatch_workflow`, `github.create_webhook`, the `api` source, a secret scan of mcp tool arguments, and a per-server or global cap (the cap is per agent).

## Open questions

- **Marker reads are bounded:** a redelivered comment looks at the last hour's comments on that issue (one page of 100), an issue at the 50 newest issues, a review comment at the 100 newest review comments. A busier target can hide the marker and post twice.

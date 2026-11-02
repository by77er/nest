# The projects app's infrastructure

The app's own [inframe](https://github.com/by77er/inframe) project: Lean stacks rendered to OpenTofu. The app isn't part of nest ([../README.md](../README.md)), so this project isn't part of nest's [deploy/](../../deploy/): it imports nothing from it and keeps its own state.

| Path | What |
|---|---|
| `inframe.toml` | The project: the Lean package, the pinned Cloudflare provider, the `projects` stack and its S3 state backend |
| `cloudflare-schema.json` | The Cloudflare provider schema (5.27.0), trimmed to the one resource type the stack uses (`cloudflare_zero_trust_access_application`); nest's trimmed schema minus the policy and service-token types |
| `lean/Projects/Stack.lean` | The `projects` stack: three Access applications for `projects-nest.bitcru.sh`, as data (`apps`) and rendered. The hostname allows the owner's login (24 h session, in the App Launcher); `/hooks` and `/mcp` bypass Access, since the Worker authenticates them itself (signatures, `Nest-Identity`). Outputs `projects_aud`, the hostname application's audience tag |
| `lean/Projects/Spec.lean` | The values: account, zone, hostname and owner, copied from nest's edge stack (not secrets) |
| `lean/Projects/Test.lean` | Theorems for every spec: only the owner is ever allowed, and only on the hostname; the bypass covers exactly `/hooks` and `/mcp` on it; no other hostname or path. Policies over the rendered graph: the same rules on what OpenTofu would create, three applications once each, and the output |

- **Path bypass:** each bypassed path is its own self-hosted application whose `domain` names the path (`projects-nest.bitcru.sh/hooks`), with one `bypass` policy that includes `everyone`. Access applies the more specific of overlapping paths, and a path covers its subpaths ([application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)). That this holds for a Bypass application under an Allow one is unverified; one [community report](https://community.cloudflare.com/t/cloudflare-access-exclude-path-from-authentication/204893) saw such a bypass stop applying. Either way the Worker fails closed: every other path needs a valid Access token for `projects_aud`.
- **State** is `projects/projects.tfstate` in nest's bucket `nest-tfstate-589531222691` (S3-native locking, encrypted). The bucket is shared only as storage; the state could move to a bucket of the app's own.

## Use

Needs OpenTofu 1.10+, `elan` and the `inframe` CLI (`scripts/infra-tools.sh` pins both).

```bash
cd projects/deploy
inframe provider generate cloudflare --frontend lean --schema-json cloudflare-schema.json   # once per checkout
inframe test --stack projects      # proofs and policies; plan and apply also run them
```

**Applied by CI:** `.github/workflows/deploy-projects-infra.yml` runs on a push to `main` that touches `projects/deploy/` (or by hand), apart from nest's deploy. It tests, plans and applies the stack, with the `production` environment's `CLOUDFLARE_ACCESS_API_TOKEN` (Account › Access: Apps and Policies › Edit) and nest's deploy role for the state; it skips the plan and apply with a notice without the token. The plan's summary and `projects_aud` go in the run summary. CI's `infra` job runs `inframe test --stack projects` on every pull request that touches this directory ([dev/ci.md](../../dev/ci.md)).

**By hand** (the owner's), with the same token in `CLOUDFLARE_API_TOKEN` and AWS credentials that can write the state:

```bash
inframe init --stack projects -- -input=false
inframe plan --stack projects -- -out=projects.plan
inframe apply --stack projects -- projects.plan
inframe output --stack projects | jq -r .projects_aud.value   # the Worker's PROJECTS_AUD
```

**After the first apply:** set `PROJECTS_AUD` in `../wrangler.jsonc` to `projects_aud` and deploy the Worker. Then check the bypass: `curl -sI https://projects-nest.bitcru.sh/hooks/nest` answers the Worker's 405 (not a redirect to `bitcrush.cloudflareaccess.com`), and `curl -sI https://projects-nest.bitcru.sh/` redirects to the login.

# nest dashboard

A read-only page of what is live in one cell: agents with a brain (template, state, lifecycle,
activity, current turn, brain host and phase, bound sandbox; an agent without a brain is not
listed), sandboxes and the host each runs on (a sandbox suspended to S3 is counted, not listed),
live hosts with their residents, the sandbox templates, and what is left lying around (dormant
sandboxes and when their TTL takes them, sandboxes held by agents nobody uses, quiet agents). History (retired hosts, launches) and
AMIs stay off it. Vite + React, served by its own Worker (`src/worker.ts`), which proxies exactly
two routes of the control plane's admin API (`GET /v1/admin/fleet`, `GET /v1/admin/images`) with the
admin token it holds as a secret, answers `/api/agents` by reading `GET /v1/agents/:agent` for
each agent the fleet view lists (`src/agents.ts`: at most 100, 4 at a time, narrowed to the page's
fields, an unreadable one a row with its error), and answers `/api/lifetimes` by following
`GET /v1/admin/lifetimes` page by page (`src/lifetimes.ts`: at most 10 pages, merged). Nothing is
shared with the control plane but that API; the page refreshes every 10 s (the lifetimes view, every 60 s).

```bash
npm install
echo 'NEST_ADMIN_TOKEN=…' > .dev.vars    # the control plane's admin token (gitignored)
npm run dev                              # vite + workerd on http://localhost:5173, against the live control plane
npm run typecheck && npm test && npm run build
```

Deployed by `.github/workflows/deploy-dashboard.yml` on every push to `main` that touches this
directory, to `dash-nest.bitcru.sh` (a Workers custom domain; `workers.dev` and preview URLs off).
Cloudflare Access in front of that hostname, an Allow policy for the owner's login, is managed by
the `edge` inframe stack (`deploy/lean/Edge/`). The Worker does not rely on it alone: every request
must carry a valid Access token for the dashboard's application (`Cf-Access-Jwt-Assertion`, checked
in `src/access.ts` against the team's keys, `ACCESS_TEAM_DOMAIN` and `DASHBOARD_AUD`), or it gets 403.
`vite dev` skips the check (there is no Access on localhost); `vite build` compiles that branch out.
The Worker's secret `NEST_ADMIN_TOKEN` comes from the `production` environment's secret of the same
name; `NEST_CONTROL_PLANE`, `NEST_CELLS`, `ACCESS_TEAM_DOMAIN` and `DASHBOARD_AUD` are vars in
`wrangler.jsonc`.

`src/api.ts` re-exports the admin view contract (`protocol/admin/view.ts`, a module with no
imports, which the control plane is typed by too) as types only, so the build carries no code from
outside `dashboard/`; `test/api.test.ts` holds that nothing imports the control plane and every
import from `protocol/` is type-only.
`fixtures/admin.ts` holds responses recorded from the control plane's test pool and must satisfy
those types (`npm run typecheck`): re-record it when `fleetView`, `images` or `lifetimes` change. Its `agent`,
a recorded `GET /v1/agents/:agent`, is outside the view contract and holds only the names and types
of the fields `src/agents.ts` reads. Design: [docs/control-plane/dashboard/](../docs/control-plane/dashboard/README.md).

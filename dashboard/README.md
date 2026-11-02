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
`GET /v1/admin/lifetimes` page by page (`src/lifetimes.ts`: at most 20 pages, merged). Nothing is
shared with the control plane but that API; the page refreshes every 10 s (the lifetimes view, every 60 s), only
while the tab is visible.

## The page

For the owner, checking on their fleet: **is anything wrong or stuck?** comes first, the detail after.
One page, no router, built on the `nest-ui-design` skill (`.claude/skills/nest-ui-design/`):

1. **Header:** the product name, and the cell (a picker when there is more than one; `#<cell>` selects it).
   Under it the h1 and a meta line: read-only, the refresh interval, when the fleet was last read.
2. **Summary row**, four stat tiles: live agents (with a brain on a live host), sandboxes on a host
   (with how many are in S3 or waiting for a host), live hosts (sandbox and brain), and how many things
   need attention (errors and warnings, each a badge with an icon; "all clear" only once every read it
   depends on has answered).
3. **Needs attention** (`src/ui/fleet.ts` `attention`), errors first, each with its status, what it is, why,
   and a *Show* that scrolls to its row and focuses it:
   - errors: a read that failed (the agents' detail, the lifetimes view), a host awaiting STONITH or a
     wedged brain on one, an agent errored or unreadable or with a condemned brain, a sandbox failed or
     fenced (on a host or off any), one whose SandboxDO did not answer, and what the lifetimes view
     marks destroyed, gone or unreadable;
   - warnings: a host active but disconnected or with its tunnel not up, an agent waiting for
     permission or input, stalled or parked on quota, and what is left lying around: held, dormant
     (with when its TTL takes it) and unknown sandboxes, quiet and stuck-ending agents.
4. **Detail**, one section each: agents (template, state, lifecycle, activity, turn, brain host, phase
   and since when, sandbox), sandboxes on a host (template, host, state, age; the ones off any host
   counted below), hosts as cards (role, reachability, wedged, uptime, free memory and vCPUs, their
   sandboxes and brains), templates (default, live sandboxes on a host), and what is left lying around
   (the view's rules and counts, its sandboxes and agents oldest first with the operator's API call as
   text, and what it could not cover).

Each section has its own loading (one spinner, after 300 ms), empty and error (with a retry) state; a
fleet read that fails after one succeeded keeps the last data under a warning. Tables scroll in their
own frame with their header kept in view, numbers right-aligned; ids are shortened, with the full id
as their title. Light and dark follow the system. A count or status that changes on a poll flashes
its tint once (not under reduced motion); an unchanged poll moves nothing.

Code: `src/ui/theme.ts` (the skill's tokens), `src/ui/layout/` (the primitives, the only place with
values besides the theme), `src/ui/features/` (the sections, which only arrange them),
`src/ui/status.ts` (each status's role), `src/ui/fleet.ts` (what is live and what needs attention),
`src/ui/queries.ts` (TanStack Query). Tests: `test/*.test.ts` hold the Worker (node), `test/ui/` the page
(jsdom): the theme against the skill's tables and WCAG AA in both schemes, every status's role swept
from its enum, the no-styling rule for feature code, the sections over `fixtures/admin.ts`, and polling.

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

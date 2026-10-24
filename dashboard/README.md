# nest dashboard

A read-only page for one cell: hosts with their tunnel state, capacity, resident sandboxes and
brains; every live sandbox (unplaced ones too); launches in flight; the host AMIs and the one the
launch template resolves to. Vite + React, served by its own Worker (`src/worker.ts`), which
proxies exactly two routes of the control plane's admin API (`GET /v1/admin/fleet`,
`GET /v1/admin/images`) with the admin token it holds as a secret. Nothing is shared with the
control plane but that API; the page refreshes every 10 s.

```bash
npm install
echo 'NEST_ADMIN_TOKEN=…' > .dev.vars    # the control plane's admin token (gitignored)
npm run dev                              # vite + workerd on http://localhost:5173, against the live control plane
npm run typecheck && npm run build
```

Deployed by `.github/workflows/deploy-dashboard.yml` on every push to `main` that touches this
directory, to `dash-nest.bitcru.sh` (a Workers custom domain). Cloudflare Access in front of that
hostname, an Allow policy for the owner's login, is what makes the proxy private; it is created by
hand ([setup](../docs/setup/README.md)). The Worker's secret `NEST_ADMIN_TOKEN` comes from the
`production` environment's secret of the same name; `NEST_CONTROL_PLANE` and `NEST_CELLS` are vars
in `wrangler.jsonc`. Design: [docs/control-plane/dashboard/](../docs/control-plane/dashboard/README.md).

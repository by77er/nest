# Dashboard

A read-only page of what is live in one cell: agents and the host each brain runs on; sandboxes and the host each runs on (one suspended to S3 is counted, not listed); live hosts with their residents; the sandbox templates. History and AMIs stay off it. It refreshes every 10 s. Code: `dashboard/` (Vite + React, its own Worker, `dash-nest.bitcru.sh`).

- **Apart from the platform.** The dashboard shares nothing with the control plane but its admin API: its own directory, package, Worker (`nest-dashboard`) and deploy workflow (`deploy-dashboard.yml`, on pushes that touch it). It reads `GET /v1/admin/fleet` and `GET /v1/admin/images` and nothing else; the Worker proxies exactly those two paths and refuses every other method and route.
- **The token stays in the Worker.** The control plane's admin token is a secret on the dashboard Worker, added to the two proxied requests; the page never sees it. What keeps the proxy private is Cloudflare Access on `dash-nest.bitcru.sh` with an Allow policy for the owner's login, managed by the `edge` inframe stack ([setup](../../setup/), [deploy](../../../dev/deploy.md)); the hostname follows the [naming rule](../../setup/#hostnames).
- **Reads only.** Operator actions stay with the API and the `nest` CLI; the page shows state and changes none.

**Not built:** per-agent detail (turns, transcripts), channels, cost, a second cell.

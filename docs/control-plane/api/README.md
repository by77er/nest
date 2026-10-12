# API and surfaces

- **Worker HTTP API and a static dashboard,** with my access gated by Cloudflare Access.
- **Triggers:** webhooks (e.g. GitHub), Email Routing to an Email Worker, and schedules implemented as DO alarms.
- **Live views:** live tails and captains' `wait_events` subscribe to AgentDO and WorkstreamDO streams.
- **Approvals and escalations** go through the **[Discord bot](discord/)**, and can also be answered in the dashboard.
- **`nest` CLI on my machine:** `attach` (a terminal over WebSocket → nestd → vsock), `logs -f`, `port-forward` (TCP over WebSocket), `diff <a> <b>`.
- **Host authentication:**
  - A signed instance identity document (or a one-time enrollment token) is exchanged for a rotating host token. See [../../compute/provisioning/](../../compute/provisioning/).
  - The fleet channel accepts a token up to 24 h past expiry, so a reconnecting host can get a fresh one. The session channel accepts no grace period.
- **Admin API (implemented):** bearer `ADMIN_TOKEN`, to be replaced by Access. Endpoints are listed in `control-plane/README.md`.
  - **Includes:** egress policy layers (`PUT /v1/sandboxes/<id>/policy`), ports and public share links (operator-only), and paged transcripts.
  - **Cells:** must be well-formed names, and must be in `CELLS` when that's set.

# Egress audit records carry a duration (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** `EgressAuditRecord` gains one optional field, `duration_ms`. nest-proxy writes it, nestd forwards it, and FleetDO writes it to R2. No table, column, route or message type changes.

- **Mixed versions:**
  - an older nestd (the proxy and nestd ship in one release, so only briefly) parses the record into its own type, which ignores the unknown field, so it forwards the record without it;
  - an older Worker's zod schema strips the field, so its R2 lines lack it;
  - an older proxy sends no `duration_ms`, and every reader treats it as absent.
- **What a `wrangler rollback` does:** the previous Worker drops `duration_ms` from the lines it writes. R2 lines already written keep it, and nothing in nest reads them back.
- **No shim to drop.**

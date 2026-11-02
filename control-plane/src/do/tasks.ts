// TaskLedgerDO: what is left of the task ledger, which left the platform (docs/README.md#principles).
// The class stays declared (the `TASKS` binding and its migration in wrangler.jsonc) only until a
// deploy of its own deletes it with a `deleted_classes` migration (stage 4 of the removal). Until then
// it stores nothing and serves only `GET /v1/health`'s round trip, which reaches every declared class
// (lib/health.ts). A ledger stored by the previous release stays as it was, so a rollback finds it; an
// alarm that release armed (notices, the daily prune) fires here and does nothing.
import { DurableObject } from "cloudflare:workers";
import { healthRead } from "../lib/health";
import type { Env } from "../env";

export class TaskLedgerDO extends DurableObject<Env> {
  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.ctx.storage.sql);
  }

  /** An alarm the previous release armed: not re-armed, and nothing is delivered. */
  override async alarm(): Promise<void> {}
}

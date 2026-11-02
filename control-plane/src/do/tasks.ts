// TaskLedgerDO: what is left of the task ledger, which left the platform (docs/README.md#principles).
// The class stays declared (the `TASKS` binding and its migration in wrangler.jsonc) only until a
// deploy of its own deletes it with a `deleted_classes` migration (stage 4 of the removal). Until then
// it stores nothing and serves only `GET /v1/health`'s round trip, which reaches every declared class
// (lib/health.ts). A ledger stored by the previous release stays as it was, so a rollback finds it. An
// alarm that release armed (notices, the daily prune) fires here and delivers nothing, but is re-armed a
// day later while its `deadlines` rows remain: that release re-arms only from its alarm, so after a
// rollback its own alarm still comes and delivers what the ledger owes.
import { DurableObject } from "cloudflare:workers";
import { healthRead } from "../lib/health";
import type { Env } from "../env";

/** How often a ledger the previous release left with deadlines is woken (and does nothing). */
export const LEDGER_ALARM_MS = 86_400_000;

export class TaskLedgerDO extends DurableObject<Env> {
  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.ctx.storage.sql);
  }

  /** An alarm the previous release armed: nothing is delivered; re-armed a day later while it has deadlines. */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'deadlines'").toArray().length) return;
    if (!sql.exec("SELECT 1 FROM deadlines LIMIT 1").toArray().length) return;
    await this.ctx.storage.setAlarm(Date.now() + LEDGER_ALARM_MS);
  }
}

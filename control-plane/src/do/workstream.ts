// WorkstreamDO: what is left of workstreams, which left the platform (docs/README.md#principles). The
// class stays declared (the `WORKSTREAM` binding and its migration in wrangler.jsonc) only until a deploy
// of its own deletes it with a `deleted_classes` migration (stage 4 of the removal). Until then it
// stores nothing and serves only `GET /v1/health`'s round trip, which reaches every declared class
// (lib/health.ts). A workstream stored by the previous release (its info, events and user
// notifications) stays as it was, so a rollback finds it. An alarm that release armed (a subscriber's
// batched wake) fires here and does nothing, but is re-armed a day later while decision events wait
// for that wake: that release arms its alarm only on ingest, so after a rollback the batch still comes.
import { DurableObject } from "cloudflare:workers";
import { healthRead } from "../lib/health";
import type { Env } from "../env";

/** How often a workstream the previous release left with an unsent wake is woken (and does nothing). */
export const WORKSTREAM_ALARM_MS = 86_400_000;

export class WorkstreamDO extends DurableObject<Env> {
  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.ctx.storage.sql);
  }

  /** An alarm the previous release armed: nothing is woken; re-armed a day later while decision events wait for a wake. */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (!sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").toArray().length) return;
    if (!sql.exec("SELECT 1 FROM events WHERE woke = 0 AND decision = 1 LIMIT 1").toArray().length) return;
    await this.ctx.storage.setAlarm(Date.now() + WORKSTREAM_ALARM_MS);
  }
}

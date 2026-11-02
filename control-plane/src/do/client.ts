// ClientDO: API clients (docs/control-plane/api/clients/). This release only declares the class (its
// binding and `clients` migration in wrangler.jsonc): a class addition is one-way and ships alone
// (docs/control-plane/#upgrades). Until the release that builds clients, it stores nothing and serves only
// `GET /v1/health`'s round trip, which reaches every declared class (lib/health.ts).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { healthRead } from "../lib/health";

export class ClientDO extends DurableObject<Env> {
  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.ctx.storage.sql);
  }
}

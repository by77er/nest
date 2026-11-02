// Events to an API client (docs/control-plane/api/clients/#events-to-the-owner): what an agent or
// sandbox in a client's subtree tells it, the outbox each keeps until ClientDO has them, and the
// webhook's signature and retry schedule. Nothing here knows any one client.
import { withTimeout } from "./reliable";
import type { Env } from "../env";
import { hex } from "./util";

/** What a client hears, for every agent and sandbox in its subtree; `id` is for deduplication. */
export type ClientEvent =
  | { type: "agent.turn_completed"; agent: string; turn: string; text: string }
  | { type: "agent.exited"; agent: string; reason: string; text: string }
  | { type: "agent.ask"; agent: string; ask: string; question: string; approval?: { name: string; tool: string } }
  | { type: "agent.error"; agent: string; code: string; message: string }
  | { type: "sandbox.destroyed"; sandbox: string };
export type StampedEvent = ClientEvent & { id: string };

/** A turn's final text, an exit's summary: clipped to this many UTF-8 bytes. */
export const EVENT_TEXT_MAX = 16 * 1024;
/** One delivery attempt is cut off after this long (the env's `CLIENT_WEBHOOK_TIMEOUT_MS` overrides it in tests). */
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The first retry after a failed delivery; each later one doubles, up to `RETRY_MAX_MS`. */
export const RETRY_FIRST_MS = 1_000;
export const RETRY_MAX_MS = 5 * 60_000;
/** Events a client's backlog holds; past it the oldest are dropped, and counted. */
export const BACKLOG_MAX = 10_000;
/** Events an agent or sandbox hands to ClientDO per call. */
const HAND_OFF_BATCH = 100;
/** A hand-off that doesn't answer in this long is retried (the outbox keeps the events). */
const HAND_OFF_TIMEOUT_MS = 10_000;

/** The wait before the next attempt after `failures` consecutive failed ones (1 s, doubling, capped at 5 min). */
export function retryDelayMs(failures: number): number {
  if (failures < 1) return 0;
  // 2^9 s is past the cap already; the exponent is bounded so it never overflows.
  return Math.min(RETRY_FIRST_MS * 2 ** Math.min(failures - 1, 20), RETRY_MAX_MS);
}

/** `Nest-Signature`: `t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, the key the secret's UTF-8 bytes. */
export async function signature(secret: string, t: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`)));
  return `t=${t},v1=${hex(mac)}`;
}

/** A webhook URL a client may set: https, with no credentials or fragment. */
export function checkWebhookUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${raw} is not a URL`;
  }
  if (u.protocol !== "https:") return "a webhook URL must be https";
  if (u.username || u.password) return "a webhook URL carries no credentials: verify the signature instead";
  if (u.hash) return "a webhook URL has no fragment";
  return null;
}

/**
 * An agent's or sandbox's outbox (`client_events`): an event is written here in the same synchronous
 * step as the change it reports, and leaves only once ClientDO has taken it (`handOff`, from the
 * object's alarm). The row's `id` is the event's, so a hand-off retried after a lost answer carries
 * the same ids, which ClientDO stores once.
 */
export class ClientOutbox {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS client_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, client TEXT NOT NULL,
      id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`);
  }

  /** Record `ev` for `client` under `id`; an id already waiting stays as it was. */
  add(client: string, id: string, ev: ClientEvent): void {
    this.sql.exec("INSERT OR IGNORE INTO client_events (client, id, body) VALUES (?, ?, ?)", client, id, JSON.stringify({ id, ...ev }));
  }

  waiting(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM client_events").one().n;
  }

  /**
   * Hand the oldest waiting events to their clients' ClientDOs, deleting each batch only once its
   * ClientDO answered. Throws (the caller's deadline retries) when one doesn't; answers whether more wait.
   */
  async handOff(env: Env): Promise<boolean> {
    const rows = this.sql.exec<{ seq: number; client: string; body: string }>(
      "SELECT seq, client, body FROM client_events ORDER BY seq LIMIT ?", HAND_OFF_BATCH).toArray();
    const byClient = new Map<string, { seqs: number[]; events: StampedEvent[] }>();
    for (const r of rows) {
      const g = byClient.get(r.client) ?? { seqs: [], events: [] };
      g.seqs.push(r.seq);
      g.events.push(JSON.parse(r.body) as StampedEvent);
      byClient.set(r.client, g);
    }
    for (const [client, g] of byClient) {
      await withTimeout(env.CLIENT.get(env.CLIENT.idFromName(client)).enqueue(g.events), HAND_OFF_TIMEOUT_MS, `handing events to ${client}`);
      // By seq: a row added meanwhile (a new seq) stays for the next hand-off.
      for (const s of g.seqs) this.sql.exec("DELETE FROM client_events WHERE seq = ?", s);
    }
    return this.waiting() > 0;
  }
}

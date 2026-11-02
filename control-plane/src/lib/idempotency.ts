// Idempotency keys for creates (docs/control-plane/api/#idempotency-keys): `POST /v1/agents` and
// `POST /v1/sandboxes` take an `Idempotency-Key` header, so a create whose answer was lost can be sent
// again without making a second agent or sandbox. A key is its principal's (each client's own ClientDO,
// the operator's the `operator` instance), bound to the first request's body and to the id that request
// was given, for `IDEMPOTENCY_TTL_MS`.
//
// The id is fixed when the key is first claimed and every create path is idempotent by id (AgentDO and
// SandboxDO `create`, ClientDO `admit`), so a request that takes over a claim another left behind (it
// died, or its lease lapsed while it still ran) can only make the same object again, never a second one.
import { z } from "zod";
import { ErrorCodes } from "../protocol/model";
import { canonicalJson } from "./sinks";
import { storedEnum } from "./stored";
import { hex, NestError, sha256 } from "./util";

/** A key binds its first request and that request's object this long (from its first use); after that it is free again. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
/** A claim still being worked on refuses a second request with the key (409, retryable) this long; after that, it is taken over. */
export const IDEMPOTENCY_LEASE_MS = 60_000;
/** Expired keys deleted per claim (the rest go at later claims, and in a client's hourly prune). */
const PRUNE_PER_CLAIM = 100;

/** The header's value: a short opaque string (a UUID, a ULID, base64url), 1-128 characters, printable and unambiguous. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:~+/=-]{1,128}$/,
  "Idempotency-Key is 1-128 characters: letters, digits and _ . : ~ + / = -");

/** The request's key, if it sent one (400 for a malformed one). */
export function idempotencyKey(req: Request): string | null {
  const raw = req.headers.get("idempotency-key");
  if (raw === null) return null;
  const k = IdempotencyKey.safeParse(raw);
  if (!k.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, k.error.issues[0]!.message);
  return k.data;
}

/** What a key is bound to: the route and the parsed body (defaults applied, keys sorted), hashed. */
export async function requestDigest(route: string, body: unknown): Promise<string> {
  return hex(await sha256(canonicalJson({ route, body })));
}

/**
 * What claiming a key came to: `run` (create the object with `id`; `fresh`: nothing was ever done under
 * this key, so a failure before the create began may free it again), or `done` (an earlier request with
 * the key created `id` and was answered `status`: replay it).
 */
export type KeyClaim =
  | { kind: "run"; id: string; claim: string; fresh: boolean }
  | { kind: "done"; id: string; status: number };

const KeyState = z.enum(["pending", "done"]);

/** The keys of one principal, in its Durable Object's SQLite (table `idempotency_keys`). Every method is one synchronous step. */
export class IdempotencyKeys {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, digest TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL,
      status INTEGER, claim TEXT, claimed_ms INTEGER NOT NULL, created_ms INTEGER NOT NULL)`);
    sql.exec("CREATE INDEX IF NOT EXISTS idempotency_keys_created ON idempotency_keys (created_ms)");
  }

  /**
   * Claim `key` for a request whose digest is `digest`; `id` is the id a new object would take. Refused
   * (409 `conflict`) when the key was used for a different request, or (retryable) while another request
   * holding it is still within its lease.
   */
  claim(key: string, digest: string, id: string, now = Date.now()): KeyClaim {
    this.prune(now, PRUNE_PER_CLAIM);
    const row = this.sql.exec<{ digest: string; id: string; state: string; status: number | null; claimed_ms: number }>(
      "SELECT digest, id, state, status, claimed_ms FROM idempotency_keys WHERE key = ?", key).toArray()[0];
    const claim = crypto.randomUUID();
    if (!row) {
      this.sql.exec("INSERT INTO idempotency_keys (key, digest, id, state, claim, claimed_ms, created_ms) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        key, digest, id, claim, now, now);
      return { kind: "run", id, claim, fresh: true };
    }
    if (row.digest !== digest) {
      throw new NestError(ErrorCodes.CONFLICT, "this Idempotency-Key was used for a different request (another route or body): use a new key", 409);
    }
    if (storedEnum(KeyState, row.state, "idempotency_keys.state") === "done") return { kind: "done", id: row.id, status: row.status ?? 201 };
    if (now - row.claimed_ms < IDEMPOTENCY_LEASE_MS) {
      throw new NestError(ErrorCodes.CONFLICT, "a request with this Idempotency-Key is still being handled: retry shortly", 409, true);
    }
    // Left behind, or out of its lease: taken over, under the same id.
    this.sql.exec("UPDATE idempotency_keys SET claim = ?, claimed_ms = ? WHERE key = ?", claim, now, key);
    return { kind: "run", id: row.id, claim, fresh: false };
  }

  /** The create under `key` was answered `status`: later requests with it replay that. The first to finish decides. */
  finish(key: string, status: number): void {
    this.sql.exec("UPDATE idempotency_keys SET state = 'done', status = ?, claim = NULL WHERE key = ? AND state = 'pending'", status, key);
  }

  /**
   * The request holding `claim` failed. `free`: nothing was created under the key, ever (a fresh claim
   * that failed before its create began), so the key goes; otherwise it stays bound to its id and body,
   * and the next request with it takes it over at once.
   */
  abandon(key: string, claim: string, free: boolean): void {
    if (free) this.sql.exec("DELETE FROM idempotency_keys WHERE key = ? AND claim = ? AND state = 'pending'", key, claim);
    else this.sql.exec("UPDATE idempotency_keys SET claim = NULL, claimed_ms = 0 WHERE key = ? AND claim = ? AND state = 'pending'", key, claim);
  }

  /** Delete up to `limit` keys older than the TTL. */
  prune(now = Date.now(), limit = 1000): void {
    this.sql.exec("DELETE FROM idempotency_keys WHERE key IN (SELECT key FROM idempotency_keys WHERE created_ms <= ? LIMIT ?)",
      now - IDEMPOTENCY_TTL_MS, limit);
  }
}

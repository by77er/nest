// A client's name and its phases (docs/control-plane/durable-objects/client/): the directory row
// is the deciding record of where a client stands; its ClientDO record follows it. Pure: each decision
// takes the row as read and answers what to write, so the directory applies it in one synchronous step.
//
//   (none) ──reserve──▶ reserved ──confirm──▶ live ──tombstone──▶ deleted ──sweep──▶ (purged: no row)
//                          │                                        ▲
//                          ├──tombstone (a delete of a half-made client)┘
//                          └──stale (RESERVE_TTL_MS, no confirm)──▶ (purged; a new create takes the name over)
import { z } from "zod";

/** A name's phase. `purged` is no row at all: the name is free. */
export const CLIENT_PHASES = ["reserved", "live", "deleted", "purged"] as const;
export type ClientPhase = (typeof CLIENT_PHASES)[number];
/** What a row stores (a row stored before phases has none: it is `live`). */
export const StoredPhase = z.enum(["reserved", "live", "deleted"]);
export type StoredPhase = z.output<typeof StoredPhase>;

/**
 * A reservation not confirmed this long after it was made is stale: its create died before answering, so
 * its token was never handed out, and the name may be taken over. A create confirms within seconds.
 */
export const RESERVE_TTL_MS = 2 * 60_000;
/**
 * A deleted client's name is held this long before the sweep frees it: requests that authenticated
 * before the delete (a catalog or secret write) have landed by then, and the sweep deletes what they
 * wrote, so no later client of that name inherits it.
 */
export const TOMBSTONE_MS = 15 * 60_000;

export interface NameRow {
  name: string;
  client: string;
  created_ms: number;
  phase: StoredPhase;
  /** When it entered `phase` (a row from before phases: its `created_ms`). */
  phase_ms: number;
}

/** A row as stored, with the defaults for one written before phases (it was a live client's). */
export function nameRow(raw: { name: string; client: string; created_ms: number; phase: string | null; phase_ms: number | null }): NameRow {
  const p = raw.phase === null ? "live" : StoredPhase.safeParse(raw.phase);
  // An unknown phase (a later release's) holds the name as `deleted` does: never handed to another client.
  const phase: StoredPhase = typeof p === "string" ? p : p.success ? p.data : "deleted";
  return { name: raw.name, client: raw.client, created_ms: raw.created_ms, phase, phase_ms: raw.phase_ms ?? raw.created_ms };
}

/** Whether a reservation is stale at `now`. */
export const staleReservation = (r: NameRow, now: number): boolean => r.phase === "reserved" && now - r.phase_ms >= RESERVE_TTL_MS;

export type ReserveDecision =
  /** Free: insert it reserved. */
  | { kind: "insert" }
  /** This client already holds it (a retried reserve): nothing to write. */
  | { kind: "held"; phase: StoredPhase }
  /** Another client's stale reservation: replace it (that record purges itself at its next prune). */
  | { kind: "takeover"; stale: string }
  /** Taken: live, a fresh reservation, or a deleted client's name until `free_ms`. */
  | { kind: "taken"; phase: StoredPhase; free_ms: number | null };

/** Reserve `name` for a client being created. */
export function reserveDecision(row: NameRow | undefined, client: string, now: number): ReserveDecision {
  if (!row) return { kind: "insert" };
  if (row.client === client && row.phase !== "deleted") return { kind: "held", phase: row.phase };
  if (row.client !== client && staleReservation(row, now)) return { kind: "takeover", stale: row.client };
  return {
    kind: "taken", phase: row.phase,
    free_ms: row.phase === "deleted" ? row.phase_ms + TOMBSTONE_MS : row.phase === "reserved" ? row.phase_ms + RESERVE_TTL_MS : null,
  };
}

/**
 * Confirm a reservation once the record exists: reserved → live. Idempotent: a confirm whose answer
 * was lost, asked again, finds it live (`already`). `lost`: the row isn't this client's reservation any
 * more (taken over, or deleted), so the create must not hand out its token.
 */
export function confirmDecision(row: NameRow | undefined, client: string): "confirm" | "already" | "lost" {
  if (!row || row.client !== client) return "lost";
  if (row.phase === "reserved") return "confirm";
  return row.phase === "live" ? "already" : "lost";
}

/** Begin a client's delete: its name becomes a tombstone (from reserved or live). `none`: no row of its. */
export function tombstoneDecision(row: NameRow | undefined, client: string): "tombstone" | "already" | "none" {
  if (!row || row.client !== client) return "none";
  return row.phase === "deleted" ? "already" : "tombstone";
}

/** What the directory's sweep does with a row at `now`: drop a stale reservation, finish a tombstone, or nothing yet. */
export function sweepDecision(row: NameRow, now: number): "drop_reservation" | "finish_delete" | null {
  if (staleReservation(row, now)) return "drop_reservation";
  if (row.phase === "deleted" && now - row.phase_ms >= TOMBSTONE_MS) return "finish_delete";
  return null;
}

/** When the sweep next has something to do for this row; null for a live one. */
export function sweepDueMs(row: NameRow): number | null {
  if (row.phase === "reserved") return row.phase_ms + RESERVE_TTL_MS;
  if (row.phase === "deleted") return row.phase_ms + TOMBSTONE_MS;
  return null;
}

/** A client's phase, from its directory row (absent: purged, or never created). */
export const phaseOf = (row: NameRow | undefined): ClientPhase => row?.phase ?? "purged";

// A client's subtree registry (docs/control-plane/durable-objects/client/): the states an agent or
// sandbox of the subtree goes through in ClientDO's `members` table, and the one step between them.

import { z } from "zod";

/** `members.state`: a place taken before the object is created, the object as it reports itself, or ended (final). */
export const MemberState = z.enum(["reserved", "live", "ended"]);
export type MemberState = z.output<typeof MemberState>;
export const MEMBER_STATES = MemberState.options;

/**
 * What happens to a member:
 * - `admit`: a place is taken before the object is created;
 * - `release`: the create failed for good;
 * - `report_live`, `report_ended`: the object reports itself (from its own alarm);
 * - `check_live`, `check_ended`, `check_gone`: ClientDO asked the object (a reservation past its check
 *   time, the hourly recheck of live rows);
 * - `expire`: an ended row is past its retention.
 */
export const MEMBER_EVENTS = ["admit", "release", "report_live", "report_ended", "check_live", "check_ended", "check_gone", "expire"] as const;
export type MemberEvent = (typeof MEMBER_EVENTS)[number];

/**
 * The registry's one step: the state after `event` (`none`: no row), or `refuse` when the event changes
 * nothing there. Every change of `members.state` goes through it (`ClientDO.move`).
 * - `ended` is final: nothing brings an ended member back, so a late `live` report or check can't
 *   retake a place; only its retention removes the row.
 * - A report is believed from any state but `ended`, also with no row (one the reconcile dropped): the
 *   count never misses an object that exists.
 * - A check only acts on what it looked at: a reservation becomes what the object is (or goes, if it
 *   was never made), and a live row whose object is ended or gone is ended. It never creates a row.
 * - Only a reservation is released: a place whose object reported itself stays.
 */
export function memberStep(state: MemberState | "none", event: MemberEvent): MemberState | "none" | "refuse" {
  switch (event) {
    case "admit": return state === "none" ? "reserved" : "refuse";
    case "release": return state === "reserved" ? "none" : "refuse";
    case "report_live": return state === "none" || state === "reserved" ? "live" : "refuse";
    case "report_ended": return state === "ended" ? "refuse" : "ended";
    case "check_live": return state === "reserved" ? "live" : "refuse";
    case "check_ended": return state === "reserved" || state === "live" ? "ended" : "refuse";
    case "check_gone": return state === "reserved" ? "none" : state === "live" ? "ended" : "refuse";
    case "expire": return state === "ended" ? "none" : "refuse";
  }
}

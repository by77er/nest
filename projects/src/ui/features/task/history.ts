// A history entry as a sentence: what happened, with the gist of its details. The actions and their
// details are what ProjectDO records (src/do/project.ts `record`, `move`): an event's name, and a
// string or a JSON object.

import type { HistoryRow } from "../../api/types";

/** `owner`, `app:<what>` or an agent's id, as a person reads it. */
export function actorLabel(actor: string): string {
  if (actor === "owner") return "You";
  if (actor === "app:auto-assign") return "Auto-assign";
  if (actor.startsWith("app:")) return "The app";
  return actor;
}

/** The detail, parsed: an object, a string, or null. */
export function detailOf(h: HistoryRow): Record<string, unknown> | string | null {
  if (h.detail === null) return null;
  try {
    const v: unknown = JSON.parse(h.detail);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
    if (typeof v === "string") return v;
  } catch {
    // plain text
  }
  return h.detail;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function summarize(h: HistoryRow): string {
  const d = detailOf(h);
  const o = typeof d === "object" && d !== null ? d : {};
  const text = typeof d === "string" ? str(d) : null;
  switch (h.action) {
    case "created":
      return str(o.title) ? `Created "${clip(str(o.title)!)}"` : "Created";
    case "updated": {
      const parts: string[] = [];
      if (str(o.title)) parts.push(`renamed to "${clip(str(o.title)!)}"`);
      if (o.body !== undefined) parts.push("details edited");
      if (o.ord !== undefined) parts.push("moved on the board");
      return parts.length ? parts.join(", ").replace(/^./, (c) => c.toUpperCase()) : "Updated";
    }
    case "spec": {
      const n = Array.isArray(o.acceptance_criteria) ? o.acceptance_criteria.length : 0;
      return n ? `Spec written, ${n} acceptance ${n === 1 ? "criterion" : "criteria"}` : "Spec written";
    }
    case "assign":
      return h.actor === "app:auto-assign" ? "Assigned automatically" : "Assigned";
    case "worker":
      return str(o.agent) ? `Assigned to ${str(o.agent)}` : "Worker created";
    case "started":
      return str(o.agent) ? `${str(o.agent)} started on it` : "Worker started";
    case "start_failed":
      return text ? `The worker couldn't start: ${clip(text)}` : "The worker couldn't start";
    case "pr_opened":
      return typeof o.pr === "number" ? `PR #${o.pr} opened` : "PR opened";
    case "worker_exited": {
      const who = str(o.agent) ? `Worker ${str(o.agent)}` : "The worker";
      return str(o.reason) ? `${who} exited (${clip(str(o.reason)!, 60)}) before opening a PR` : `${who} exited before opening a PR`;
    }
    case "merged":
      return typeof o.pr === "number" ? `PR #${o.pr} merged` : "PR merged";
    case "done":
      return "Marked done";
    case "cancel":
      return text ? `Cancelled: ${clip(text)}` : "Cancelled";
    case "progress":
      return text ? `Progress: ${clip(text)}` : "Progress reported";
    case "blocker":
      return text ? `Blocked: ${clip(text)}` : "Reported a blocker";
    default:
      return h.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

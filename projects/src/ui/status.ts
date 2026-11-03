// What the board shows for each task state: its label, its semantic color, and its column. The moves a
// button offers come from the state machine itself (src/tasks.ts), so the page never offers one the
// Worker refuses.

import { type TaskEvent, type TaskState, transition } from "../tasks";
import type { JobState } from "../do/review";
import type { Role } from "./theme";

export const STATE_LABEL: Record<TaskState, string> = {
  draft: "Draft",
  ready: "Ready",
  assigned: "Assigned",
  in_progress: "In progress",
  in_review: "In review",
  stalled: "Stalled",
  done: "Done",
  cancelled: "Cancelled",
};

/** Blue for work under way, yellow for stalled, green for done, red for cancelled; gray before work starts. */
export const STATE_COLOR: Record<TaskState, Role> = {
  draft: "gray",
  ready: "gray",
  assigned: "primary",
  in_progress: "primary",
  in_review: "primary",
  stalled: "warning",
  done: "success",
  cancelled: "danger",
};

export interface Column {
  id: string;
  title: string;
  states: readonly TaskState[];
}

/** The board's columns, left to right. `cancelled` is shown only when asked for. */
export const COLUMNS: readonly Column[] = [
  { id: "draft", title: "Draft", states: ["draft"] },
  { id: "ready", title: "Ready", states: ["ready"] },
  { id: "working", title: "In progress", states: ["assigned", "in_progress"] },
  { id: "in_review", title: "In review", states: ["in_review"] },
  { id: "stalled", title: "Stalled", states: ["stalled"] },
  { id: "done", title: "Done", states: ["done"] },
];
export const CANCELLED_COLUMN: Column = { id: "cancelled", title: "Cancelled", states: ["cancelled"] };

/** Whether the owner's `event` applies to a task in `state` (the Worker's own table). */
export const can = (state: TaskState, event: TaskEvent) => transition(state, event).ok;

/** A review job's state (src/do/review.ts) as the Reviews page shows it; a done job by its verdict. */
export const REVIEW_STATE: Record<JobState, { label: string; color: Role }> = {
  queued: { label: "Queued", color: "gray" },
  running: { label: "Reviewing", color: "primary" },
  done: { label: "Reviewed", color: "success" },
  failed: { label: "Failed", color: "danger" },
  superseded: { label: "Superseded", color: "gray" },
  closed: { label: "Closed", color: "gray" },
};

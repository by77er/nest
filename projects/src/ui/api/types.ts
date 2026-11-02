// The API's shapes, taken from the Worker's own modules by type only: nothing here reaches the bundle.

import type { HistoryRow, Settings, Task } from "../../do/project";
import type { ProjectRow } from "../../do/directory";

export type { Ask, ChatMessage, HistoryRow, Settings, Task } from "../../do/project";
export type { ProjectRow, SyncState } from "../../do/directory";
export type { AnswerBody, CancelBody, ChatBody, CreateProjectBody, CreateTaskBody, SettingsBody, UpdateTaskBody } from "../../requests";
export type { Spec, TaskState } from "../../tasks";

/** `GET /api/projects/<id>`. */
export type Project = ProjectRow & { settings: Settings };
/** A row of the projects list: with `needs_you`, how many asks and blocked tasks wait on the owner. */
export type ListedProject = ProjectRow & { needs_you: number };
export type { Attention, Blocked } from "../../do/project";
/** `POST /api/projects`. */
export type CreatedProject = ProjectRow & { settings: Settings | null; catalog_synced: boolean };
/** `GET /api/projects/<id>/tasks/<task>`. */
export type TaskDetail = Task & { history: HistoryRow[] };
/** `POST /api/admin/sync`. */
export interface SyncResult {
  written: string[];
  repos: string[];
}

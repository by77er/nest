// The API's shapes, taken from the Worker's own modules by type only: nothing here reaches the bundle.

import type { HistoryRow, Settings, Task } from "../../do/project";
import type { ProjectRow } from "../../do/directory";

export type { Ask, ChatMessage, HistoryRow, Settings, Task } from "../../do/project";
export type { ProjectRow, SyncState } from "../../do/directory";
export type { AnswerBody, CancelBody, ChatBody, CreateProjectBody, CreateTaskBody, SettingsBody, UpdateTaskBody } from "../../requests";
export type { Spec, TaskState } from "../../tasks";
export type { ManagerPhase, ManagerStatus } from "../../manager";
export type { Job, JobState } from "../../do/review";
export type { Dimension, Verdict } from "../../github";

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

export type { Wait, WaitKind, WaitOutcome } from "../../waits";
export type { LayerStatus } from "../../do/project";
export type { EgressRule, NetworkRole, RoleRules } from "../../network";
export type { NetworkBody } from "../../requests";
/** `GET /api/projects/<id>/waits`. */
export interface Waits {
  pending: import("../../waits").Wait[];
  recent: import("../../waits").Wait[];
}
/** `GET /api/projects/<id>/network`: the rules, each live agent's layer, the grant's ceiling and the operator's base rules. */
export interface NetworkView {
  rules: import("../../network").RoleRules;
  rev: number;
  agents: import("../../do/project").LayerStatus[];
  egress_hosts: string[] | null;
  base: import("../../network").EgressRule[] | null;
}

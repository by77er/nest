// The API's shapes, taken from the Worker's own modules by type only: nothing here reaches the bundle.

import type { HistoryRow, Settings, Task } from "../../do/project";
import type { ProjectRow } from "../../do/directory";

export type { Ask, ChatMessage, HistoryRow, Settings, Task } from "../../do/project";
export type { ProjectRow, SyncState } from "../../do/directory";
export type { PutSecretBody } from "../../requests";
export type { AddDependencyBody, AttachPrBody, AnswerBody, CancelBody, ChatBody, CreateProjectBody, CreateTaskBody, SettingsBody, UpdateTaskBody } from "../../requests";
export type { Spec, TaskState } from "../../tasks";
export type { ManagerPhase, ManagerStatus } from "../../manager";
export type { Job, JobState } from "../../do/review";
export type { Dimension, Verdict } from "../../github";

/** `GET /api/projects/<id>`. */
export type Project = ProjectRow & { settings: Settings };
/** A row of the projects list: with `needs_you`, how many asks and blocked tasks wait on the owner. */
export type ListedProject = ProjectRow & { needs_you: number };
export type { Attention, Blocked, SecretRequest, SecretView, TaskPr, TaskRef } from "../../do/project";
export type { SecretGrant, SecretLocation, SecretRole } from "../../secrets";
/** `GET /api/projects/:id/secrets`: the project's secrets with nest's facts, and the grant's limits. */
export interface SecretsAnswer {
  secrets: (import("../../do/project").SecretView & { last_injected_ms: number | null; in_nest: boolean | null })[];
  grant: (import("../../secrets").SecretGrant & { used: number }) | null;
  client: string | null;
}
/** One of the repo's open PRs, for attaching: the task it's attached to, if any. */
export interface OpenPr {
  number: number;
  title: string;
  head: string;
  fork: boolean;
  task: string | null;
}
/** `POST /api/projects`. */
export type CreatedProject = ProjectRow & { settings: Settings | null; catalog_synced: boolean };
/** `GET /api/projects/<id>/tasks/<task>`. */
export type TaskDetail = Task & { history: HistoryRow[] };
/** `POST /api/admin/sync`. */
export interface SyncResult {
  written: string[];
  repos: string[];
}

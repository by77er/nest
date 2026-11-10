// The API's shapes, taken from the Worker's own modules by type only: nothing here reaches the bundle.

import type { HistoryRow, Settings, Task } from "../../do/project";
import type { ProjectRow } from "../../do/directory";

export type { Ask, ChatMessage, HistoryRow, Settings, Task } from "../../do/project";
export type { ProjectRow, SyncState } from "../../do/directory";
export type { PutSecretBody } from "../../requests";
export type { AddDependencyBody, AttachPrBody, AnswerBody, CancelBody, ChatBody, CreateProjectBody, CreateTaskBody, SettingsBody, UpdateTaskBody } from "../../requests";
export type { Spec, TaskState } from "../../tasks";
export type { OutboxState } from "../../outbox";
export type { ManagerPhase, ManagerStatus } from "../../manager";
export type { Job, JobState } from "../../do/review";
export type { Dimension, Verdict } from "../../github";

/** `GET /api/projects/<id>`. */
export type Project = ProjectRow & { settings: Settings };
/** A row of the projects list: with `needs_you`, how many asks and blocked tasks wait on the owner. */
export type ListedProject = ProjectRow & { needs_you: number };
export type { Blocked, Issue, SecretRequest, SecretView, TaskIssue, TaskPr, TaskRef } from "../../do/project";
/** One thing waiting on the owner: ProjectDO's (asks, blocked tasks, secret requests, triage), or a review held for approval (README.md#the-review-gate). */
export type Attention = import("../../do/project").Attention
  | { kind: "review"; pr: number; sha: string; title: string | null; author: string | null; fork: boolean; at_ms: number };
export type { AcceptIssueBody, DeclineIssueBody } from "../../requests";
export type { SecretGrant, SecretLocation, SecretRole } from "../../secrets";
/** `GET /api/projects/:id/secrets`: the project's secrets with nest's facts, and the grant's limits. */
export interface SecretsAnswer {
  secrets: (import("../../do/project").SecretView & { last_injected_ms: number | null; in_nest: boolean | null; outside_hosts: string[] })[];
  grant: (import("../../secrets").SecretGrant & { used: number }) | null;
  client: string | null;
  /** Each live agent's client layer, which carries its bindings and variables (as the Network page shows it). */
  agents: import("../../do/project").LayerStatus[];
  /** Live workers whose push token may change workflows: theirs until they end, whatever the setting says now. */
  workflow_workers: string[];
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
  base: import("../../network").OperatorRule[] | null;
  /** Agents nest refused to stop (README.md#outboxes): they may still be running. */
  failed_stops: import("../../do/project").FailedStop[];
}

// Routines and memory (README.md#routines, README.md#memory).
export type { Proposal, Routine, RoutineRun } from "../../do/project";
export type { Created, RunOutcome, RunState, Timer, TriggerKind, Triggers } from "../../routines";
export type { Note } from "../../memory";
export type { CreateRoutineBody, DeclineProposalBody, RoutineKind, RoutinePreset, UpdateRoutineBody } from "../../requests";
/** `GET /api/projects/<id>/routines`. */
export interface RoutinesAnswer {
  routines: import("../../do/project").Routine[];
  max_routine_runs: number;
  live: number;
}

// The API's shapes, taken from the Worker's own modules by type only: nothing here reaches the bundle.

import type { HistoryRow, Settings as ProjectSettings, Task } from "../../do/project";
import type { ProjectRow } from "../../do/directory";

export type { Ask, ChatMessage, HistoryRow, Task } from "../../do/project";
/** A project's settings as the API answers them: ProjectDO's, with ReviewDO's `untrusted_reviews` (README.md#the-review-gate; `hold` when absent). */
export type Settings = ProjectSettings & { untrusted_reviews?: "hold" | "review" };
export type { ProjectRow, RepoBinding, SyncState } from "../../do/directory";
/**
 * `POST /api/admin/bindings/<project>` (and `…/bind`): the binding as read again, and what happened to a
 * rename; or, when GitHub's repo for the name isn't the bound one, both, and nothing written.
 */
export type RereadBinding =
  | { binding: import("../../do/directory").RepoBinding; changed: boolean; previous_id: number | null; rename: { applied: string } | { blocked: string } | null }
  | { binding: import("../../do/directory").RepoBinding; mismatch: BindingMismatch };
/** The bound repo and GitHub's repo for the name, side by side; `same_owner` null when either owner isn't known. */
export interface BindingMismatch {
  bound: import("../../do/directory").RepoRef;
  github: import("../../do/directory").RepoRef & { same_owner: boolean | null };
}
export type { PutSecretBody } from "../../requests";
export type { AddDependencyBody, AttachPrBody, AnswerBody, CancelBody, ChatBody, CreateProjectBody, CreateTaskBody, SettingsBody, UpdateTaskBody } from "../../requests";
export type { Spec, TaskState } from "../../tasks";
export type { OutboxState } from "../../outbox";
export type { ManagerPhase, ManagerStatus } from "../../manager";
export type { Job, JobState } from "../../do/review";
export type { Dimension, Verdict } from "../../github";

/** `GET /api/projects/<id>`. */
export type Project = ProjectRow & { settings: Settings };
/**
 * A row of the projects list: with `needs_you`, how many things wait on the owner ("Needs you"'s items), or
 * null when nest couldn't be read for the agents' asks (unknown, not none).
 */
export type ListedProject = ProjectRow & { needs_you: number | null };
export type { Blocked, Issue, SecretRequest, SecretView, TaskIssue, TaskPr, TaskRef } from "../../do/project";
/** One thing waiting on the owner: ProjectDO's (asks, blocked tasks, secret requests, triage), or a review held for approval (README.md#the-review-gate). */
export type Attention = import("../../do/project").Attention
  | { kind: "review"; pr: number; sha: string; title: string | null; author: string | null; fork: boolean; at_ms: number }
  // PRs from authors the project doesn't trust that got no review job yet: too many already wait.
  | { kind: "review_backlog"; count: number; at_ms: number };
/** What "Needs you" lists: everything but the marker saying the asks couldn't be read. */
export type Waiting = Exclude<Attention, { kind: "asks_unavailable" }>;

/** "Needs you"'s items, and why nest's asks couldn't be read (null: they were). */
export function splitAttention(xs: readonly Attention[] | undefined): { items: Waiting[]; asksError: string | null } {
  const items: Waiting[] = [];
  let asksError: string | null = null;
  for (const x of xs ?? []) {
    if (x.kind === "asks_unavailable") asksError = x.error;
    else items.push(x);
  }
  return { items, asksError };
}
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
/**
 * `GET /api/repos`: the repos the owner may attach a project to (nest's grant lets the app push to and mint
 * tokens for them), each with the project already on it; owner-wide entries nest couldn't list.
 */
export interface AttachableRepos {
  repos: { repo: string; project: string | null }[];
  unlisted: string[];
  complete: boolean;
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

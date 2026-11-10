// The JSON API's request bodies (src/api.ts), in a module of their own with nothing but zod, so the
// page (src/ui/) validates its forms with the very schemas the Worker checks, and types its calls by them.

import { z } from "zod";
import { MODEL_ID } from "./models";
import { MERGE_METHODS } from "./automerge";

/** A GitHub repo, `owner/name`. */
/** `POST /api/admin/bindings/<project>/bind`: the repo id a re-read showed, which the operator chose. */
export const BindRepo = z.object({ repo_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const Text = (max: number) => z.string().max(max);

export const CreateProject = z.strictObject({
  name: z.string().min(1).max(100),
  repo: z.string().regex(REPO, "repo is owner/name").refine((r) => !/\.git$/i.test(r), "repo is owner/name, without .git"),
  auto_assign: z.boolean().optional(),
  max_workers: z.number().int().min(0).max(20).optional(),
  max_concurrent_reviews: z.number().int().min(0).max(50).nullable().optional(),
  auto_merge: z.boolean().optional(),
  merge_method: z.enum(MERGE_METHODS).optional(),
});
export const Settings = z.strictObject({
  // Workers' push tokens may change .github/workflows/ (README.md#secrets); needs the grant's github_push.workflows.
  workers_edit_workflows: z.boolean().optional(),
  auto_assign: z.boolean().optional(),
  max_workers: z.number().int().min(0).max(20).optional(),
  // ReviewDO's: null (the default) for no cap on running reviews.
  max_concurrent_reviews: z.number().int().min(0).max(50).nullable().optional(),
  // ReviewDO's: a PR the project doesn't trust waits for the owner's approval (`hold`, the default), or is reviewed like any other.
  untrusted_reviews: z.enum(["hold", "review"]).optional(),
  // GitHub's auto-merge on task PRs, and the repo's "Allow auto-merge" written back (README.md#auto-merge).
  auto_merge: z.boolean().optional(),
  merge_method: z.enum(MERGE_METHODS).optional(),
  // Whose PR comments reach workers (README.md#pr-comments): a GitHub user's id; null for nobody's.
  comments_from_id: z.number().int().min(1).max(2 ** 53 - 1).nullable().optional(),
  // Or by login, looked up on GitHub and kept as its id; null for nobody's.
  comments_from_login: z.string().trim().min(1).max(39).nullable().optional(),
  // Or the repo's owner, as GitHub names the repo's owner now (by its id: never looked up by login).
  comments_from_repo_owner: z.boolean().optional(),
  // Routine runs at once across the project (README.md#routines).
  max_routine_runs: z.number().int().min(1).max(3).optional(),
  // The models the manager and the workers run on (README.md#models): an id or alias Claude Code's --model takes.
  manager_model: z.string().trim().regex(MODEL_ID, "a model id: letters, digits and . _ : @ / [ ] -").optional(),
  worker_model: z.string().trim().regex(MODEL_ID, "a model id: letters, digits and . _ : @ / [ ] -").optional(),
});
export const CreateTask = z.strictObject({ title: z.string().min(1).max(200), body: Text(20000).optional() });
export const UpdateTask = z.strictObject({ title: z.string().min(1).max(200).optional(), body: Text(20000).optional(), ord: z.number().finite().optional() });
export const Spec = z.strictObject({
  goal: Text(4000), acceptance_criteria: z.array(Text(1000)).max(50), files: z.array(Text(1000)).max(50), test_plan: Text(4000),
});
/** A PR to attach: its number, `#<n>`, or its URL on github.com (README.md#prs). */
export const AttachPr = z.strictObject({ pr: z.union([z.number().int().positive(), z.string().min(1).max(300)]) });
/** A task this one waits on (README.md#dependencies). */
export const AddDependency = z.strictObject({ blocked_by: z.string().regex(/^tsk_[a-z0-9]+$/, "a task id (tsk_…)") });
/** A secret's settings, and its value when set (README.md#secrets): the value goes to nest, never stored here. */
const Location = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("authorization_bearer") }),
  z.strictObject({ type: z.literal("authorization_basic_password") }),
  z.strictObject({ type: z.literal("header"), name: z.string().min(1).max(64) }),
]);
export const PutSecret = z.strictObject({
  value: z.string().min(1).max(65536).optional(),
  description: z.string().max(200).default(""),
  hosts: z.array(z.string().min(1).max(253)).min(1).max(16),
  locations: z.array(Location).min(1).max(3),
  roles: z.array(z.enum(["worker", "manager", "reviewer"])).min(1).max(3),
  /** The variable holding its placeholder (src/secrets.ts checks it). */
  env: z.string().min(1).max(64),
});
/** Accepting an issue in triage (README.md#triage): its `updated_ms` as the owner read it. */
export const AcceptIssue = z.strictObject({ updated_ms: z.number().int().nonnegative() });
export type AcceptIssueBody = z.input<typeof AcceptIssue>;
/** Declining an issue in triage (README.md#triage): an optional reason, kept on it. */
export const DeclineIssue = z.strictObject({ reason: z.string().max(500).optional() });
export type DeclineIssueBody = z.input<typeof DeclineIssue>;
/** The owner's chat message; `request_id` is the page's, so posting it again (an answer lost) is the same message (README.md#outboxes). */
export const Chat = z.strictObject({ text: z.string().min(1).max(20000), request_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional() });
export const Answer = z.strictObject({ answer: z.string().max(20000) });
export const Cancel = z.strictObject({ reason: Text(1000).optional() });
/** A role's egress rules (src/network.ts checks hosts against the grant). */
const Rule = z.strictObject({ host: z.string().min(1).max(253), ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(16).optional() });
export const Network = z.strictObject({ worker: z.array(Rule).max(64), manager: z.array(Rule).max(64) });

/** A time of day, HH:MM (24 h). */
const HHMM = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "a time, HH:MM");
/** An IANA time zone the runtime knows (the daily and weekly timers' wall clock). */
const TimeZone = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "an IANA time zone, like Europe/London");
/** A routine's timer (README.md#routines): an interval of 15 minutes to 7 days, or a daily or weekly time. */
export const Timer = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("interval"), minutes: z.number().int().min(15, "At least 15 minutes").max(7 * 24 * 60, "At most 7 days (10080 minutes)") }),
  z.strictObject({ kind: z.literal("daily"), time: HHMM, tz: TimeZone }),
  // day: 0 is Sunday, as JavaScript's getDay.
  z.strictObject({ kind: z.literal("weekly"), day: z.number().int().min(0).max(6), time: HHMM, tz: TimeZone }),
]);
/** What fires a routine, any of them: its timer, or N tasks done or N task PRs merged since its last run. */
export const Triggers = z.strictObject({
  timer: Timer.nullable(),
  tasks_done: z.number().int().min(1).max(1000).nullable(),
  prs_merged: z.number().int().min(1).max(1000).nullable(),
});
export const ROUTINE_KINDS = ["review", "dreaming", "custom"] as const;
export const ROUTINE_PRESETS = ["review", "dreaming"] as const;
const RoutineFields = {
  name: z.string().trim().min(1).max(80),
  kind: z.enum(ROUTINE_KINDS),
  /** The owner's instructions for each run (the brief carries them, untainted). */
  prompt: z.string().trim().min(1).max(8000),
  enabled: z.boolean(),
  triggers: Triggers,
  /** At least this long between two runs' starts (a manual run skips it). */
  cooldown_min: z.number().int().min(0).max(7 * 24 * 60),
  /** The run is stopped after this long (its cost guard). */
  max_minutes: z.number().int().min(5).max(120),
  /** The run is stopped after this many turns. */
  max_turns: z.number().int().min(1).max(20),
  /** Where its proposed tasks go: the triage queue (the owner accepts them), or the board as drafts. */
  proposals: z.enum(["triage", "draft"]),
};
/** A new routine: a preset (README.md#presets) or every field. */
export const CreateRoutine = z.union([z.strictObject({ preset: z.enum(ROUTINE_PRESETS) }), z.strictObject(RoutineFields)]);
export const UpdateRoutine = z.strictObject(Object.fromEntries(Object.entries(RoutineFields).map(([k, v]) => [k, v.optional()])) as {
  [K in keyof typeof RoutineFields]: z.ZodOptional<(typeof RoutineFields)[K]>;
});
/** Declining a routine's proposed task: an optional reason, kept on it. */
export const DeclineProposal = z.strictObject({ reason: z.string().max(500).optional() });

export type CreateProjectBody = z.input<typeof CreateProject>;
export type SettingsBody = z.input<typeof Settings>;
export type NetworkBody = z.input<typeof Network>;
export type CreateTaskBody = z.input<typeof CreateTask>;
export type UpdateTaskBody = z.input<typeof UpdateTask>;
export type AttachPrBody = z.input<typeof AttachPr>;
export type AddDependencyBody = z.input<typeof AddDependency>;
export type PutSecretBody = z.input<typeof PutSecret>;
export type ChatBody = z.input<typeof Chat>;
export type AnswerBody = z.input<typeof Answer>;
export type CancelBody = z.input<typeof Cancel>;
export type TimerBody = z.input<typeof Timer>;
export type TriggersBody = z.input<typeof Triggers>;
export type CreateRoutineBody = z.input<typeof CreateRoutine>;
export type UpdateRoutineBody = z.input<typeof UpdateRoutine>;
export type DeclineProposalBody = z.input<typeof DeclineProposal>;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];
export type RoutinePreset = (typeof ROUTINE_PRESETS)[number];

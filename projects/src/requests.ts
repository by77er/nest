// The JSON API's request bodies (src/api.ts), in a module of their own with nothing but zod, so the
// page (src/ui/) validates its forms with the very schemas the Worker checks, and types its calls by them.

import { z } from "zod";
import { MERGE_METHODS } from "./automerge";

/** A GitHub repo, `owner/name`. */
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
  // GitHub's auto-merge on task PRs, and the repo's "Allow auto-merge" written back (README.md#auto-merge).
  auto_merge: z.boolean().optional(),
  merge_method: z.enum(MERGE_METHODS).optional(),
  // Whose PR comments reach workers (README.md#pr-comments): a GitHub user's id; null for nobody's.
  comments_from_id: z.number().int().min(1).max(2 ** 53 - 1).nullable().optional(),
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
export const Chat = z.strictObject({ text: z.string().min(1).max(20000) });
export const Answer = z.strictObject({ answer: z.string().max(20000) });
export const Cancel = z.strictObject({ reason: Text(1000).optional() });
/** A role's egress rules (src/network.ts checks hosts against the grant). */
const Rule = z.strictObject({ host: z.string().min(1).max(253), ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(16).optional() });
export const Network = z.strictObject({ worker: z.array(Rule).max(64), manager: z.array(Rule).max(64) });

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

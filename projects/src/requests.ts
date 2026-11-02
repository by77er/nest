// The JSON API's request bodies (src/api.ts), in a module of their own with nothing but zod, so the
// page (src/ui/) validates its forms with the very schemas the Worker checks, and types its calls by them.

import { z } from "zod";

/** A GitHub repo, `owner/name`. */
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

const Text = (max: number) => z.string().max(max);

export const CreateProject = z.strictObject({
  name: z.string().min(1).max(100),
  repo: z.string().regex(REPO, "repo is owner/name").refine((r) => !/\.git$/i.test(r), "repo is owner/name, without .git"),
  auto_assign: z.boolean().optional(),
  max_workers: z.number().int().min(0).max(20).optional(),
});
export const Settings = z.strictObject({ auto_assign: z.boolean().optional(), max_workers: z.number().int().min(0).max(20).optional() });
export const CreateTask = z.strictObject({ title: z.string().min(1).max(200), body: Text(20000).optional() });
export const UpdateTask = z.strictObject({ title: z.string().min(1).max(200).optional(), body: Text(20000).optional(), ord: z.number().finite().optional() });
export const Spec = z.strictObject({
  goal: Text(4000), acceptance_criteria: z.array(Text(1000)).max(50), files: z.array(Text(1000)).max(50), test_plan: Text(4000),
});
export const Chat = z.strictObject({ text: z.string().min(1).max(20000) });
export const Answer = z.strictObject({ answer: z.string().max(20000) });
export const Cancel = z.strictObject({ reason: Text(1000).optional() });

export type CreateProjectBody = z.input<typeof CreateProject>;
export type SettingsBody = z.input<typeof Settings>;
export type CreateTaskBody = z.input<typeof CreateTask>;
export type UpdateTaskBody = z.input<typeof UpdateTask>;
export type ChatBody = z.input<typeof Chat>;
export type AnswerBody = z.input<typeof Answer>;
export type CancelBody = z.input<typeof Cancel>;

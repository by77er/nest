// The one module that calls the JSON API (src/api.ts). Same origin, so Cloudflare Access's cookie goes
// with every call and the page holds no credential of its own.

import type {
  AnswerBody, Ask, Attention, ListedProject, CancelBody, ChatBody, ChatMessage, CreatedProject, CreateProjectBody, CreateTaskBody, Project, ProjectRow,
  Job, ManagerStatus, Settings, SettingsBody, SyncResult, SyncState, Task, TaskDetail, UpdateTaskBody,
} from "./types";

/** An answer that isn't a success: the API's `{error}`, or what the page could tell. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, `the app can't be reached (${e instanceof Error ? e.message : String(e)})`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: Access's login page after the session lapsed, or a proxy's error page.
    throw new ApiError(res.status, res.ok ? "the answer isn't JSON: reload to sign in again" : `${res.status} ${res.statusText}`.trim());
  }
  if (!res.ok) {
    const error = typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : null;
    throw new ApiError(res.status, error ?? `${res.status} ${res.statusText}`.trim());
  }
  return data as T;
}

const prj = (id: string) => `/projects/${encodeURIComponent(id)}`;
const tsk = (id: string, task: string) => `${prj(id)}/tasks/${encodeURIComponent(task)}`;

export const api = {
  projects: () => call<{ projects: ListedProject[] }>("GET", "/projects").then((r) => r.projects),
  createProject: (b: CreateProjectBody) => call<CreatedProject>("POST", "/projects", b),
  project: (id: string) => call<Project>("GET", prj(id)),
  updateSettings: (id: string, b: SettingsBody) => call<Settings>("PATCH", `${prj(id)}/settings`, b),
  retryRepoAutoMerge: (id: string) => call<Settings>("POST", `${prj(id)}/auto-merge/retry`),

  tasks: (id: string) => call<Task[]>("GET", `${prj(id)}/tasks`),
  task: (id: string, task: string) => call<TaskDetail>("GET", tsk(id, task)),
  createTask: (id: string, b: CreateTaskBody) => call<Task>("POST", `${prj(id)}/tasks`, b),
  updateTask: (id: string, task: string, b: UpdateTaskBody) => call<Task>("PATCH", tsk(id, task), b),
  deleteTask: (id: string, task: string) => call<{ deleted: string }>("DELETE", tsk(id, task)),
  assignTask: (id: string, task: string) => call<Task>("POST", `${tsk(id, task)}/assign`),
  cancelTask: (id: string, task: string, b: CancelBody) => call<Task>("POST", `${tsk(id, task)}/cancel`, b),
  markDone: (id: string, task: string) => call<Task>("POST", `${tsk(id, task)}/done`),

  chat: (id: string) => call<ChatMessage[]>("GET", `${prj(id)}/chat`),
  postChat: (id: string, b: ChatBody) => call<{ seq: number; delivered: boolean }>("POST", `${prj(id)}/chat`, b),
  asks: (id: string) => call<Ask[]>("GET", `${prj(id)}/asks`),
  attention: (id: string) => call<Attention[]>("GET", `${prj(id)}/attention`),
  answerBlocked: (id: string, task: string, b: AnswerBody) => call<Task>("POST", `${tsk(id, task)}/answer`, b),
  answerAsk: (id: string, ask: string, b: AnswerBody) => call<{ delivered: unknown }>("POST", `${prj(id)}/asks/${encodeURIComponent(ask)}/answer`, b),

  manager: (id: string) => call<ManagerStatus>("GET", `${prj(id)}/manager`),
  retryAttach: (id: string) => call<Settings>("POST", `${prj(id)}/attach`),
  reviews: (id: string) => call<Job[]>("GET", `${prj(id)}/reviews`),

  syncState: () => call<SyncState | null>("GET", "/admin/sync-state"),
  sync: () => call<SyncResult>("POST", "/admin/sync"),
};

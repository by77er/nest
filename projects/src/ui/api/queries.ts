// Every query and mutation the page makes, with its cache key. Live views (the board, the chat, the
// asks) poll while the tab is visible; TanStack Query stops polling a hidden tab by default.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Ask, CancelBody, ChatMessage, CreateProjectBody, CreateTaskBody, SettingsBody, Task, UpdateTaskBody } from "./types";

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  tasks: (id: string) => ["projects", id, "tasks"] as const,
  task: (id: string, task: string) => ["projects", id, "task", task] as const,
  chat: (id: string) => ["projects", id, "chat"] as const,
  asks: (id: string) => ["projects", id, "asks"] as const,
  syncState: ["admin", "sync-state"] as const,
};

/** How often each live view polls, in ms. */
export const POLL = { board: 5_000, chat: 3_000, asks: 5_000, project: 10_000, task: 5_000 } as const;

// --- reads ------------------------------------------------------------------------------------------

export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.projects });

export const useProject = (id: string) => useQuery({ queryKey: keys.project(id), queryFn: () => api.project(id), refetchInterval: POLL.project });

/** The board; `paused` while a card is being dragged, so a poll can't move cards under the pointer. */
export const useTasks = (id: string, o: { paused?: boolean } = {}) =>
  useQuery({ queryKey: keys.tasks(id), queryFn: () => api.tasks(id), refetchInterval: o.paused ? false : POLL.board });

export const useTask = (id: string, task: string | undefined) =>
  useQuery({
    queryKey: keys.task(id, task ?? ""),
    queryFn: () => api.task(id, task!),
    enabled: task !== undefined,
    refetchInterval: POLL.task,
    placeholderData: keepPreviousData,
  });

export const useChat = (id: string) => useQuery({ queryKey: keys.chat(id), queryFn: () => api.chat(id), refetchInterval: POLL.chat });

export const useAsks = (id: string) => useQuery({ queryKey: keys.asks(id), queryFn: () => api.asks(id), refetchInterval: POLL.asks });

export const useSyncState = () => useQuery({ queryKey: keys.syncState, queryFn: api.syncState });

// --- writes -----------------------------------------------------------------------------------------

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateProjectBody) => api.createProject(b),
    meta: { failure: "The project wasn't created" },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.projects, exact: true }),
  });
}

export function useUpdateSettings(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: SettingsBody) => api.updateSettings(id, b),
    meta: { failure: "The settings weren't saved" },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.project(id), exact: true });
      // Turning auto-assign on, or raising the cap, may assign tasks at once.
      return qc.invalidateQueries({ queryKey: keys.tasks(id) });
    },
  });
}

/** Write the repo's "Allow auto-merge" again: after GitHub refused it, or to undo a change by hand. */
export function useRetryRepoAutoMerge(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryRepoAutoMerge(id),
    meta: { failure: "The repo's auto-merge setting wasn't written" },
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.project(id), exact: true }),
  });
}

/** After a task changes: its row on the board at once, then the board and its detail fetched again. */
function useTaskWrite<V extends { task: string }>(id: string, fn: (v: V) => Promise<Task>, failure: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { failure },
    onSuccess: (data, v) => {
      qc.setQueryData<Task[]>(keys.tasks(id), (old) => old?.map((t) => (t.id === data.id ? data : t)));
      void qc.invalidateQueries({ queryKey: keys.task(id, v.task) });
      return qc.invalidateQueries({ queryKey: keys.tasks(id) });
    },
  });
}

export function useCreateTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateTaskBody) => api.createTask(id, b),
    meta: { failure: "The task wasn't created" },
    onSuccess: (t) => {
      qc.setQueryData<Task[]>(keys.tasks(id), (old) => (old ? [...old, t] : old));
      return qc.invalidateQueries({ queryKey: keys.tasks(id) });
    },
  });
}

export const useUpdateTask = (id: string) =>
  useTaskWrite(id, (v: { task: string } & Omit<UpdateTaskBody, "ord">) => {
    const { task, ...b } = v;
    return api.updateTask(id, task, b);
  }, "The task wasn't saved");

export const useAssignTask = (id: string) => useTaskWrite(id, (v: { task: string }) => api.assignTask(id, v.task), "The task wasn't assigned");

export const useCancelTask = (id: string) =>
  useTaskWrite(id, (v: { task: string } & CancelBody) => api.cancelTask(id, v.task, { ...(v.reason ? { reason: v.reason } : {}) }), "The task wasn't cancelled");

export const useMarkDone = (id: string) => useTaskWrite(id, (v: { task: string }) => api.markDone(id, v.task), "The task wasn't marked done");

export function useDeleteTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { task: string }) => api.deleteTask(id, v.task),
    meta: { failure: "The task wasn't deleted" },
    onSuccess: (_d, v) => {
      qc.setQueryData<Task[]>(keys.tasks(id), (old) => old?.filter((t) => t.id !== v.task));
      qc.removeQueries({ queryKey: keys.task(id, v.task) });
      return qc.invalidateQueries({ queryKey: keys.tasks(id) });
    },
  });
}

/** Move a card: shown at once (board order is `ord`), put back if the Worker refuses. */
export function useReorderTask(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { task: string; ord: number }) => api.updateTask(id, v.task, { ord: v.ord }),
    meta: { failure: "The card wasn't moved" },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: keys.tasks(id) });
      const before = qc.getQueryData<Task[]>(keys.tasks(id));
      qc.setQueryData<Task[]>(keys.tasks(id), (old) =>
        old?.map((t) => (t.id === v.task ? { ...t, ord: v.ord } : t)).sort((a, b) => a.ord - b.ord || a.created_ms - b.created_ms));
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.tasks(id), ctx.before);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.tasks(id) }),
  });
}

/** Say something to the manager: shown at once as not yet delivered, then as the Worker logged it. */
export function usePostChat(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.postChat(id, { text }),
    meta: { failure: "The message wasn't sent" },
    onMutate: async (text) => {
      await qc.cancelQueries({ queryKey: keys.chat(id) });
      const before = qc.getQueryData<ChatMessage[]>(keys.chat(id));
      const pending: ChatMessage = { seq: -Date.now(), at_ms: Date.now(), sender: "owner", text, delivered: false, error: null };
      qc.setQueryData<ChatMessage[]>(keys.chat(id), (old) => [...(old ?? []), pending]);
      return { before };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(keys.chat(id), ctx.before);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.chat(id) }),
  });
}

/**
 * Answer an ask. Not optimistic: an approval is a decision, so the ask stays (its buttons busy) until
 * nest has taken the answer, and an answer nest refuses leaves it as it was, typed text and all.
 */
export function useAnswerAsk(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ask: string; answer: string }) => api.answerAsk(id, v.ask, { answer: v.answer }),
    meta: { failure: "The answer wasn't sent" },
    onSuccess: (_d, v) => {
      qc.setQueryData<Ask[]>(keys.asks(id), (old) => old?.map((a) => (a.ask === v.ask ? { ...a, answered_ms: Date.now() } : a)));
      return qc.invalidateQueries({ queryKey: keys.asks(id) });
    },
  });
}

export function useSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.sync,
    meta: { inline: true },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.syncState }),
  });
}

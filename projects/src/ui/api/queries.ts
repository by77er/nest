// Every query and mutation the page makes, with its cache key. Live views (the board, the chat, the
// asks) poll while the tab is visible; TanStack Query stops polling a hidden tab by default.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { CreateRoutineBody, PutSecretBody, UpdateRoutineBody } from "./types";
import type { NetworkBody, Ask, Attention, CancelBody, ChatMessage, CreateProjectBody, CreateTaskBody, SettingsBody, Task, UpdateTaskBody } from "./types";

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  tasks: (id: string) => ["projects", id, "tasks"] as const,
  task: (id: string, task: string) => ["projects", id, "task", task] as const,
  chat: (id: string) => ["projects", id, "chat"] as const,
  asks: (id: string) => ["projects", id, "asks"] as const,
  manager: (id: string) => ["projects", id, "manager"] as const,
  reviews: (id: string) => ["projects", id, "reviews"] as const,
  openPrs: (id: string) => ["projects", id, "open-prs"] as const,
  secrets: (id: string) => ["projects", id, "secrets"] as const,
  attention: (id: string) => ["projects", id, "attention"] as const,
  routines: (id: string) => ["projects", id, "routines"] as const,
  runs: (id: string) => ["projects", id, "routine-runs"] as const,
  proposals: (id: string) => ["projects", id, "proposals"] as const,
  memory: (id: string) => ["projects", id, "memory"] as const,
  issues: (id: string) => ["projects", id, "issues"] as const,
  syncState: ["admin", "sync-state"] as const,
};

/** How often each live view polls, in ms. */
export const POLL = { board: 5_000, chat: 3_000, asks: 5_000, project: 10_000, task: 5_000, manager: 10_000, reviews: 15_000, routines: 10_000 } as const;

// --- reads ------------------------------------------------------------------------------------------

/** The projects, with each one's "needs you" count (the sidebar's badges): polled like a project. */
export const useProjects = () => useQuery({ queryKey: keys.projects, queryFn: api.projects, refetchInterval: POLL.project });

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

/** The chat's latest page; `enabled: false` (or no id) asks nothing (the sidebar outside a project). */
export const useChat = (id: string, enabled = true) => useQuery({ queryKey: keys.chat(id), queryFn: () => api.chat(id), refetchInterval: POLL.chat, enabled: enabled && id !== "" });

/** Stop the manager's current turn (Stop, while one runs). */
export function useInterruptManager(id: string) {
  return useMutation({ mutationFn: () => api.interruptManager(id), meta: { failure: "The manager wasn't stopped" } });
}

export const useAsks = (id: string) => useQuery({ queryKey: keys.asks(id), queryFn: () => api.asks(id), refetchInterval: POLL.asks });

/** The manager's status for its page (nest's agent record, read through the app). */
export const useManager = (id: string) => useQuery({ queryKey: keys.manager(id), queryFn: () => api.manager(id), refetchInterval: POLL.manager });

export const useReviews = (id: string) => useQuery({ queryKey: keys.reviews(id), queryFn: () => api.reviews(id), refetchInterval: POLL.reviews });

/** Attach the repo again after a failure: the manager starts once it's attached. */
export function useRetryAttach(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryAttach(id),
    meta: { failure: "The repo wasn't attached" },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.manager(id) }), qc.invalidateQueries({ queryKey: keys.project(id), exact: true })]),
  });
}

/** What waits on the owner: open asks and blocked tasks, oldest first (README.md#blocked). */
/** The manager's pending waits (and the last few that ended): polled, since their deadlines run down. */
export const useWaits = (id: string) => useQuery({ queryKey: ["projects", id, "waits"], queryFn: () => api.waits(id), refetchInterval: POLL.manager });

/** The Network page: polled while changes reach the live agents. */
export const useNetwork = (id: string) =>
  useQuery({ queryKey: ["projects", id, "network"], queryFn: () => api.network(id), refetchInterval: (q) => (q.state.data?.agents.some((a) => a.state === "pending") ? 3_000 : POLL.manager) });

export function useSetNetwork(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: NetworkBody) => api.setNetwork(id, b),
    // The page says why under Save, and marks the hosts it names: no notification.
    meta: { inline: true },
    onSuccess: (v) => {
      // The same layers carry the secrets: their statuses on the Secrets page move too.
      void qc.invalidateQueries({ queryKey: keys.secrets(id) });
      qc.setQueryData(["projects", id, "network"], v);
    },
  });
}

export const useAttention = (id: string) => useQuery({ queryKey: keys.attention(id), queryFn: () => api.attention(id), refetchInterval: POLL.asks });

/** The owner answers a blocked task: its block clears, and the answer reaches the agents' inboxes. */
export function useAnswerBlocked(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { task: string; answer: string }) => api.answerBlocked(id, v.task, { answer: v.answer }),
    meta: { failure: "The answer wasn't sent" },
    onSuccess: (t) => {
      qc.setQueryData<Attention[]>(keys.attention(id), (old) => old?.filter((x) => !(x.kind === "blocked" && x.task === t.id)));
      qc.setQueryData<Task[]>(keys.tasks(id), (old) => old?.map((x) => (x.id === t.id ? t : x)));
      void qc.invalidateQueries({ queryKey: keys.projects, exact: true });
      return qc.invalidateQueries({ queryKey: keys.attention(id) });
    },
  });
}

/** The repo's open PRs, read when the picker opens (not polled). */
export const useOpenPrs = (id: string, enabled: boolean) => useQuery({ queryKey: keys.openPrs(id), queryFn: () => api.openPrs(id), enabled, staleTime: 30_000 });

/** A write to a task's PRs or dependencies: its detail and the board read again. */
function useRelationWrite<V extends { task: string }>(id: string, fn: (v: V) => Promise<Task>, failure: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { failure },
    onSuccess: (t, v) => {
      qc.setQueryData<Task[]>(keys.tasks(id), (old) => old?.map((x) => (x.id === t.id ? t : x)));
      void qc.invalidateQueries({ queryKey: keys.task(id, v.task) });
      void qc.invalidateQueries({ queryKey: keys.openPrs(id) });
      return qc.invalidateQueries({ queryKey: keys.tasks(id) });
    },
  });
}

export const useAttachPr = (id: string) => useRelationWrite(id, (v: { task: string; pr: number | string }) => api.attachPr(id, v.task, { pr: v.pr }), "The PR wasn't attached");
export const useDetachPr = (id: string) => useRelationWrite(id, (v: { task: string; pr: number }) => api.detachPr(id, v.task, v.pr), "The PR wasn't detached");
export const useAddDependency = (id: string) => useRelationWrite(id, (v: { task: string; blocked_by: string }) => api.addDependency(id, v.task, { blocked_by: v.blocked_by }), "The dependency wasn't added");
export const useRemoveDependency = (id: string) => useRelationWrite(id, (v: { task: string; blocker: string }) => api.removeDependency(id, v.task, v.blocker), "The dependency wasn't removed");

/** The Secrets page: polled faster while a change reaches the live agents. */
export const useSecrets = (id: string) =>
  useQuery({ queryKey: keys.secrets(id), queryFn: () => api.secrets(id), refetchInterval: (q) => (q.state.data?.agents.some((a) => a.state === "pending") ? 3_000 : POLL.reviews) });

/** Save a secret's settings, and its value when one is given (straight to nest; never kept by the page). */
export function usePutSecret(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; body: PutSecretBody }) => api.putSecret(id, v.name, v.body),
    // The variables hold the value: dropped once the save settles, not kept in the mutation cache.
    gcTime: 0,
    meta: { failure: "The secret wasn't saved" },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.attention(id) });
      void qc.invalidateQueries({ queryKey: ["projects", id, "network"] });
      return qc.invalidateQueries({ queryKey: keys.secrets(id) });
    },
  });
}

export function useDeleteSecret(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteSecret(id, name),
    meta: { failure: "The secret wasn't deleted" },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects", id, "network"] });
      return qc.invalidateQueries({ queryKey: keys.secrets(id) });
    },
  });
}

export function useSecretRequestDone(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: string) => api.secretRequestDone(id, req),
    meta: { failure: "It wasn't marked done" },
    onSuccess: (_d, req) => {
      qc.setQueryData<Attention[]>(keys.attention(id), (old) => old?.filter((x) => !(x.kind === "secret" && x.id === req)));
      void qc.invalidateQueries({ queryKey: keys.projects, exact: true });
      return qc.invalidateQueries({ queryKey: keys.attention(id) });
    },
  });
}

// --- triage (README.md#triage) ----------------------------------------------------------------------

/** The repo's issues waiting for triage, polled as "Needs you" is. */
export const useIssues = (id: string) => useQuery({ queryKey: keys.issues(id), queryFn: () => api.issues(id), refetchInterval: POLL.asks });

/** A triage write: the queue, the board and "Needs you" (its count) all move. */
function useTriageWrite<V, R>(id: string, fn: (v: V) => Promise<R>, failure: string, inline = false) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    meta: { failure, inline },
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.issues(id) }), qc.invalidateQueries({ queryKey: keys.tasks(id) }),
      qc.invalidateQueries({ queryKey: keys.attention(id) }), qc.invalidateQueries({ queryKey: keys.projects, exact: true }),
    ]),
  });
}
/** Accept, with the issue's `updated_ms` as read: its failure shows on the issue (one edited since asks again). */
export const useAcceptIssue = (id: string) =>
  useTriageWrite(id, (v: { n: number; updated_ms: number }) => api.acceptIssue(id, v.n, { updated_ms: v.updated_ms }), "The issue wasn't accepted", true);
export const useDeclineIssue = (id: string) => useTriageWrite(id, (v: { n: number; reason: string }) => api.declineIssue(id, v.n, v.reason ? { reason: v.reason } : {}), "The issue wasn't declined");
export const useImportIssues = (id: string) => useTriageWrite(id, () => api.importIssues(id), "The open issues weren't imported");

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

/** Try closing a done task's issue on GitHub again, after GitHub refused it (README.md#triage). */
export const useRetryIssueClose = (id: string) => useTaskWrite(id, (v: { task: string }) => api.retryIssueClose(id, v.task), "The issue close wasn't retried");

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
    // No toast: a message that isn't taken stays in the log, not delivered, with Retry.
    meta: { inline: true },
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
      qc.setQueryData<Attention[]>(keys.attention(id), (old) => old?.filter((x) => !(x.kind === "ask" && x.ask === v.ask)));
      void qc.invalidateQueries({ queryKey: keys.attention(id) });
      void qc.invalidateQueries({ queryKey: keys.projects, exact: true });
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

// --- routines and memory (README.md#routines) ------------------------------------------------------------

export const useRoutines = (id: string) => useQuery({ queryKey: keys.routines(id), queryFn: () => api.routines(id), refetchInterval: POLL.routines });
export const useRoutineRuns = (id: string) => useQuery({ queryKey: keys.runs(id), queryFn: () => api.routineRuns(id), refetchInterval: POLL.routines });
export const useProposals = (id: string) => useQuery({ queryKey: keys.proposals(id), queryFn: () => api.proposals(id), refetchInterval: POLL.routines });
export const useMemory = (id: string) => useQuery({ queryKey: keys.memory(id), queryFn: () => api.memory(id), refetchInterval: POLL.routines });

/** A write to routines: the routines and their runs read again after it. */
function useRoutineWrite<V, R>(id: string, fn: (v: V) => Promise<R>, failure: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // null: the form shows its error itself.
    meta: failure === null ? { inline: true } : { failure },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.routines(id) }), qc.invalidateQueries({ queryKey: keys.runs(id) })]),
  });
}

export const useCreateRoutine = (id: string) => useRoutineWrite(id, (b: CreateRoutineBody) => api.createRoutine(id, b), null);
/** A preset, added with one click (its failure a notification: there's no form to show it). */
export const useAddPreset = (id: string) => useRoutineWrite(id, (preset: "review" | "dreaming") => api.createRoutine(id, { preset }), "The routine wasn't added");
export const useUpdateRoutine = (id: string) =>
  useRoutineWrite(id, (v: { routine: string } & UpdateRoutineBody) => {
    const { routine, ...b } = v;
    return api.updateRoutine(id, routine, b);
  }, null);
export const useDeleteRoutine = (id: string) => useRoutineWrite(id, (routine: string) => api.deleteRoutine(id, routine), "The routine wasn't deleted");
export const useRunRoutine = (id: string) => useRoutineWrite(id, (routine: string) => api.runRoutine(id, routine), "The routine didn't start");
export const useStopRun = (id: string) => useRoutineWrite(id, (run: string) => api.stopRun(id, run), "The run wasn't stopped");

/** Accept or decline a proposed task: the queue, and the board an accepted one lands on, read again. */
export function useTriageProposal(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { proposal: string; accept: boolean; reason?: string }): Promise<unknown> =>
      v.accept ? api.acceptProposal(id, v.proposal) : api.declineProposal(id, v.proposal, v.reason ? { reason: v.reason } : {}),
    meta: { failure: "The proposal wasn't triaged" },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.proposals(id) }), qc.invalidateQueries({ queryKey: keys.tasks(id) })]),
  });
}

export function useDeleteNote(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.deleteNote(id, key),
    meta: { failure: "The note wasn't deleted" },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.memory(id) }),
  });
}

// The board's list holds summaries (README.md#built-the-core): a write that patches it with the task it
// answered stores that task without its body and spec, as the list's own read would.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi, task } from "../test/fakeApi";
import { keys, useAnswerBlocked, useAttachPr, useCancelTask, useCreateTask, useDetachPr, useRemoveDependency, useUpdateTask } from "./queries";
import { createQueryClient } from "./queryClient";
import type { TaskSummary } from "./types";

const spec = { goal: "g", acceptance_criteria: ["a"], files: ["f"], test_plan: "p" };

function setup() {
  const api = new FakeApi();
  vi.stubGlobal("fetch", api.fetch);
  const blocker = task({ title: "blocker", body: "its body", spec });
  const t = task({
    title: "t", body: "a body", spec, state: "ready",
    prs: [{ number: 7, state: "open", title: null, fork: false, attached_by: "owner", attached_ms: 1, auto_merge: null }], pr: 7,
    blocked_by: [{ id: blocker.id, title: blocker.title, state: blocker.state }], waiting_on: [blocker.id],
    blocked: { at_ms: 1, by: "agt_w", role: "worker", reason: "why", question: null, tainted: false },
  });
  api.tasks = [blocker, t];
  const qc = createQueryClient();
  // What the list's read put there: summaries.
  qc.setQueryData<TaskSummary[]>(keys.tasks("prj_one"), api.tasks.map(({ body: _b, spec: _s, ...x }) => ({ ...x })));
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const list = () => qc.getQueryData<TaskSummary[]>(keys.tasks("prj_one"))!;
  return { api, qc, t, blocker, wrapper, list };
}

const noBodies = (list: TaskSummary[]) => {
  for (const x of list) {
    expect(x).not.toHaveProperty("body");
    expect(x).not.toHaveProperty("spec");
  }
};

describe("writes that patch the board's list", () => {
  it.each([
    ["an update", (id: string) => useUpdateTask(id), (t: string) => ({ task: t, title: "renamed" }), (x: TaskSummary) => x.title === "renamed"],
    ["attaching a PR", (id: string) => useAttachPr(id), (t: string) => ({ task: t, pr: 9 }), (x: TaskSummary) => x.prs.length === 2],
    ["detaching a PR", (id: string) => useDetachPr(id), (t: string) => ({ task: t, pr: 7 }), (x: TaskSummary) => x.prs.length === 0],
    ["removing a dependency", (id: string) => useRemoveDependency(id), (t: string, blocker: string) => ({ task: t, blocker }), (x: TaskSummary) => x.blocked_by.length === 0],
    ["answering a blocked task", (id: string) => useAnswerBlocked(id), (t: string) => ({ task: t, answer: "yes" }), (x: TaskSummary) => x.blocked === null],
    ["cancelling it", (id: string) => useCancelTask(id), (t: string) => ({ task: t }), (x: TaskSummary) => x.state === "cancelled"],
  ] as const)("%s stores the task as a summary", async (_name, hook, vars, changed) => {
    const s = setup();
    const { result } = renderHook(() => hook("prj_one"), { wrapper: s.wrapper });
    // Each hook's own variables; the table pairs them.
    act(() => (result.current.mutate as (v: unknown) => void)(vars(s.t.id, s.blocker.id)));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const row = s.list().find((x) => x.id === s.t.id)!;
    expect(changed(row)).toBe(true);
    noBodies(s.list());
  });

  it("creating a task appends it as a summary", async () => {
    const s = setup();
    const { result } = renderHook(() => useCreateTask("prj_one"), { wrapper: s.wrapper });
    act(() => result.current.mutate({ title: "new", body: "a new body" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The answer itself is the full task (the form's `onCreated` has it); the list holds its summary.
    expect(result.current.data).toHaveProperty("body", "a new body");
    expect(s.list().map((x) => x.title)).toEqual(["blocker", "t", "new"]);
    noBodies(s.list());
  });
});

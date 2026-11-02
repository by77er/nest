// Reordering is optimistic: the board shows the move before the Worker answers, writes only the moved
// task's `ord`, and puts the card back if the Worker refuses.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FakeApi, task } from "../test/fakeApi";
import { keys, useReorderTask } from "./queries";
import { createQueryClient } from "./queryClient";
import type { Task } from "./types";

function setup(api: FakeApi) {
  vi.stubGlobal("fetch", api.fetch);
  const qc = createQueryClient();
  const tasks = [task({ title: "a", ord: 1 }), task({ title: "b", ord: 2 }), task({ title: "c", ord: 3 })];
  api.tasks = tasks.map((t) => ({ ...t }));
  qc.setQueryData(keys.tasks("prj_one"), tasks);
  const { result } = renderHook(() => useReorderTask("prj_one"), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
  const titles = () => qc.getQueryData<Task[]>(keys.tasks("prj_one"))!.map((t) => t.title);
  return { qc, tasks, result, titles };
}

describe("reordering", () => {
  it("shows the move at once and writes only the moved task's ord", async () => {
    const api = new FakeApi();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch = api.fetch;
    const s = setup(api);
    vi.stubGlobal("fetch", async (...a: Parameters<typeof fetch>) => (await gate, fetch(...a)));

    act(() => s.result.current.mutate({ task: s.tasks[2]!.id, ord: 0.5 }));
    // Before the Worker has answered.
    await waitFor(() => expect(s.titles()).toEqual(["c", "a", "b"]));
    release();
    await waitFor(() => expect(s.result.current.isSuccess).toBe(true));
    expect(api.writes).toEqual([{ method: "PATCH", path: `/api/projects/prj_one/tasks/${s.tasks[2]!.id}`, body: { ord: 0.5 } }]);
  });

  it("puts the card back when the Worker refuses", async () => {
    const api = new FakeApi();
    api.fail(/^PATCH /, 404, "unknown task");
    const s = setup(api);
    // The board isn't refetched on settle in this test: nothing observes it.
    act(() => s.result.current.mutate({ task: s.tasks[0]!.id, ord: 9 }));
    await waitFor(() => expect(s.result.current.isError).toBe(true));
    expect(s.titles()).toEqual(["a", "b", "c"]);
  });
});

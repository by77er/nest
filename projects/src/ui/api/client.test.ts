// The API client's conditional GETs (README.md#the-ui): it names the answer it has, and a 304 hands back
// that very value without reading a body; everything else is answered as before.
import { describe, expect, it, vi } from "vitest";
import { api, ApiError, REMEMBERED } from "./client";

type Seen = { url: string; method: string; ifNoneMatch: string | null };

/** A Worker that tags each answer with its body's version, and answers 304 to the tag it would send. */
function server(answer: (url: string, method: string) => { body: unknown; etag?: string; status?: number }) {
  const seen: Seen[] = [];
  const parsed: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    seen.push({ url, method, ifNoneMatch });
    const a = answer(url, method);
    const res = a.etag && ifNoneMatch === a.etag
      ? new Response(null, { status: 304, headers: { etag: a.etag } })
      : new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json", ...(a.etag ? { etag: a.etag } : {}) } });
    // Which answers had their bodies read.
    const text = res.text.bind(res);
    res.text = () => (parsed.push(`${res.status} ${url}`), text());
    res.json = () => Promise.reject(new Error("call() reads text"));
    return res;
  });
  vi.stubGlobal("fetch", fetch);
  return { seen, parsed, fetch };
}

describe("conditional GETs", () => {
  it("a 304 hands back the very value it had, without reading a body", async () => {
    let version = 1;
    const s = server(() => ({ body: [{ id: "tsk_a", v: version }], etag: `"v${version}"` }));
    const first = await api.tasks("prj_c1");
    expect(s.seen[0]!.ifNoneMatch).toBeNull();
    const second = await api.tasks("prj_c1");
    expect(s.seen[1]!.ifNoneMatch).toBe('"v1"');
    expect(Object.is(second, first)).toBe(true);
    expect(s.parsed).toEqual(["200 /api/projects/prj_c1/tasks"]);
    // Changed: the new body, read and remembered in its place.
    version = 2;
    const third = await api.tasks("prj_c1");
    expect(third).toEqual([{ id: "tsk_a", v: 2 }]);
    expect(Object.is(await api.tasks("prj_c1"), third)).toBe(true);
    expect(s.seen.map((x) => x.ifNoneMatch)).toEqual([null, '"v1"', '"v1"', '"v2"']);
  });

  it("remembers the last answers only, least recently used dropped first", async () => {
    const s = server((url) => ({ body: { url }, etag: `"${url.length}"` }));
    await api.task("prj_c2", "tsk_first");
    for (let i = 0; i < REMEMBERED - 1; i++) await api.task("prj_c2", `tsk_${i}`);
    // Used again: now the most recent, so the next one in drops tsk_0 instead.
    await api.task("prj_c2", "tsk_first");
    await api.task("prj_c2", "tsk_last");
    s.seen.length = 0;
    await api.task("prj_c2", "tsk_first");
    await api.task("prj_c2", "tsk_0");
    expect(s.seen.map((x) => x.ifNoneMatch !== null)).toEqual([true, false]);
  });

  it("asks again, unconditionally, when a 304 comes for an answer it doesn't have", async () => {
    let calls = 0;
    const fetch = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      return calls === 1 ? new Response(null, { status: 304, headers: { etag: '"x"' } }) : new Response(JSON.stringify({ ok: init ? new Headers(init.headers).get("if-none-match") : "?" }), { headers: { etag: '"x"' } });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await api.manager("prj_c3")).toEqual({ ok: null });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("doesn't remember an answer without an ETag (the review fixtures', Access's)", async () => {
    const s = server(() => ({ body: { n: 1 } }));
    const a = await api.waits("prj_c4");
    const b = await api.waits("prj_c4");
    expect(s.seen.map((x) => x.ifNoneMatch)).toEqual([null, null]);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
  });

  it("never answers a write from what it remembers, and the GET after it gets the new state", async () => {
    let tasks = [{ id: "tsk_a" }];
    const s = server((url, method) => {
      if (method === "POST") return (tasks = [...tasks, { id: "tsk_b" }], { body: { id: "tsk_b" }, status: 201 });
      return { body: tasks, etag: `"${tasks.length}"` };
    });
    const before = await api.tasks("prj_c5");
    const created = await api.createTask("prj_c5", { title: "b" });
    expect(created).toEqual({ id: "tsk_b" });
    expect(s.seen[1]).toMatchObject({ method: "POST", ifNoneMatch: null });
    const after = await api.tasks("prj_c5");
    expect(after).not.toBe(before);
    expect(after).toEqual([{ id: "tsk_a" }, { id: "tsk_b" }]);
  });

  it("answers errors as before: the API's error, a page that isn't JSON, no connection", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "unknown task" }), { status: 404, headers: { etag: '"e"' } }));
    await expect(api.task("prj_c6", "tsk_x")).rejects.toMatchObject({ status: 404, message: "unknown task", body: { error: "unknown task" } });
    vi.stubGlobal("fetch", async () => new Response("<html>sign in</html>", { status: 200, headers: { etag: '"h"' } }));
    await expect(api.task("prj_c6", "tsk_x")).rejects.toMatchObject({ status: 200, message: "the answer isn't JSON: reload to sign in again" });
    // Neither was remembered: the next ask names nothing.
    const s = server(() => ({ body: { id: "tsk_x" }, etag: '"t"' }));
    await api.task("prj_c6", "tsk_x");
    expect(s.seen[0]!.ifNoneMatch).toBeNull();
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    const e = await api.task("prj_c6", "tsk_x").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0, message: "the app can't be reached (Failed to fetch)" });
  });
});

// Conditional GETs and Server-Timing on the JSON API (src/conditional.ts, README.md#the-ui): a poll that
// finds nothing new is a 304 with no body; anything else is answered as before.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { matches } from "../src/conditional";
import { AccessTeam, api, APP, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let team: AccessTeam;
let token: string;

beforeAll(async () => {
  team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const spec = { goal: "Do the thing", acceptance_criteria: ["it works"], files: ["src/a.ts"], test_plan: "npm test" };

/** A project with tasks (one specced) and a chat, as the page would find it. */
async function seeded(tasks = 3, messages = 3) {
  const repo = `owner-${rand()}/repo-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: `p ${repo}`, repo });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const id = p.body.id as string;
  const ids: string[] = [];
  for (let i = 0; i < tasks; i++) {
    const t = await api(token, "POST", `/api/projects/${id}/tasks`, { title: `task ${i}`, body: `details of task ${i}, `.repeat(20) });
    expect(t.status).toBe(201);
    ids.push(t.body.id);
  }
  if (ids[0]) expect((await api(token, "PUT", `/api/projects/${id}/tasks/${ids[0]}/spec`, spec)).status).toBe(200);
  for (let i = 0; i < messages; i++) expect((await api(token, "POST", `/api/projects/${id}/chat`, { text: `message ${i}` })).status).toBe(201);
  return { id, tasks: ids };
}

const get = (path: string, headers: Record<string, string> = {}) => SELF.fetch(`${APP}${path}`, { headers: { "cf-access-jwt-assertion": token, ...headers } });
const send = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${APP}${path}`, { method, headers: { "cf-access-jwt-assertion": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const timing = /^app;dur=\d+$/;

describe("conditional GETs", () => {
  it("a GET's 200 carries an ETag; asked again with it, a 304 with no body and the same ETag", async () => {
    const p = await seeded();
    const first = await get(`/api/projects/${p.id}/tasks`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("server-timing")).toMatch(timing);
    const tasks = await first.json<{ id: string }[]>();
    expect(tasks.map((t) => t.id).sort()).toEqual([...p.tasks].sort());

    const again = await get(`/api/projects/${p.id}/tasks`, { "if-none-match": etag! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(again.headers.get("server-timing")).toMatch(timing);
    // Cloudflare marks the tag weak when it compresses the answer: the browser's W/ copy matches too.
    expect((await get(`/api/projects/${p.id}/tasks`, { "if-none-match": `W/${etag}` })).status).toBe(304);
    // Another tag: the whole answer.
    const other = await get(`/api/projects/${p.id}/tasks`, { "if-none-match": '"0123"' });
    expect(other.status).toBe(200);
    expect(other.headers.get("etag")).toBe(etag);
    expect(await other.json()).toEqual(tasks);
  });

  it("after a write the ETag differs and the body is the new state: create then list, post then chat", async () => {
    const p = await seeded(1, 1);
    const list = await get(`/api/projects/${p.id}/tasks`);
    const etag = list.headers.get("etag")!;
    const created = await send("POST", `/api/projects/${p.id}/tasks`, { title: "a new one" });
    expect(created.status).toBe(201);
    // A write's answer is never conditional.
    expect(created.headers.get("etag")).toBeNull();
    const after = await get(`/api/projects/${p.id}/tasks`, { "if-none-match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect((await after.json<{ title: string }[]>()).map((t) => t.title)).toContain("a new one");

    const chat = await get(`/api/projects/${p.id}/chat`);
    const chatTag = chat.headers.get("etag")!;
    expect((await send("POST", `/api/projects/${p.id}/chat`, { text: "one more" })).status).toBe(201);
    const later = await get(`/api/projects/${p.id}/chat`, { "if-none-match": chatTag });
    expect(later.status).toBe(200);
    expect(later.headers.get("etag")).not.toBe(chatTag);
    expect((await later.json<{ text: string }[]>()).map((m) => m.text)).toContain("one more");
  });

  it("an idle project answers 304 to a second read of every route the page polls", async () => {
    const p = await seeded();
    const routes = [
      "/api/projects", `/api/projects/${p.id}`, `/api/projects/${p.id}/tasks`, `/api/projects/${p.id}/tasks/${p.tasks[0]}`,
      `/api/projects/${p.id}/chat`, `/api/projects/${p.id}/attention`, `/api/projects/${p.id}/attention?local=1`,
      `/api/projects/${p.id}/manager`, `/api/projects/${p.id}/waits`, `/api/projects/${p.id}/reviews`, `/api/projects/${p.id}/reviewers`,
      `/api/projects/${p.id}/routines`, `/api/projects/${p.id}/routine-runs`, `/api/projects/${p.id}/proposals`, `/api/projects/${p.id}/memory`,
      `/api/projects/${p.id}/issues`, `/api/projects/${p.id}/secrets`, `/api/projects/${p.id}/network`,
    ];
    for (const path of routes) {
      const first = await get(path);
      expect(first.status, path).toBe(200);
      const etag = first.headers.get("etag");
      expect(etag, path).toBeTruthy();
      const body = await first.text();
      const second = await get(path, { "if-none-match": etag! });
      // On a miss, what changed between the reads.
      expect(second.status, `${path}: ${body.slice(0, 300)} then ${second.status === 200 ? (await second.text()).slice(0, 300) : ""}`).toBe(304);
    }
  });

  it("leaves writes, refusals, errors and the trace's routes as they were, timed", async () => {
    const p = await seeded(2, 0);
    // Writes: no ETag, the same body whatever If-None-Match says.
    for (const [m, path, body] of [
      ["PATCH", `/api/projects/${p.id}/tasks/${p.tasks[1]}`, { title: "renamed" }],
      ["POST", `/api/projects/${p.id}/tasks`, { title: "another" }],
      ["DELETE", `/api/projects/${p.id}/tasks/${p.tasks[1]}`, undefined],
    ] as const) {
      const res = await SELF.fetch(`${APP}${path}`, { method: m, headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", "if-none-match": "*" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect(res.status, `${m} ${path}`).toBeLessThan(300);
      expect(res.headers.get("etag"), `${m} ${path}`).toBeNull();
      expect(res.headers.get("server-timing"), `${m} ${path}`).toMatch(timing);
      expect(await res.json(), `${m} ${path}`).toBeTruthy();
    }
    // A 4xx: its body, no ETag, even to `*`.
    const missing = await get(`/api/projects/${p.id}/tasks/tsk_nosuch`, { "if-none-match": "*" });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("etag")).toBeNull();
    expect(missing.headers.get("server-timing")).toMatch(timing);
    expect(await missing.json()).toEqual({ error: expect.any(String) });
    // A 5xx: nest failing a read the API passes on.
    fake.fail(/^GET \/v1\/agents\/agt_\w+\/asks$|^GET \/v1\/asks/, 500);
    const asks = await get(`/api/projects/${p.id}/asks`, { "if-none-match": "*" });
    fake.failures.length = 0;
    expect(asks.status).toBeGreaterThanOrEqual(500);
    expect(asks.headers.get("etag")).toBeNull();
    // The trace's history and socket are nest's answers, passed through: no ETag.
    const history = await get(`/api/agents/agt_nosuch/trace/history`, { "if-none-match": "*" });
    expect(history.status).toBe(404);
    expect(history.headers.get("etag")).toBeNull();
    const socket = await get(`/api/agents/agt_nosuch/trace`, { "if-none-match": "*" });
    expect(socket.status).toBe(426);
    expect(socket.headers.get("etag")).toBeNull();
  });

  it("the Access check comes first: no identity is the same 403, with no ETag or timing", async () => {
    const res = await SELF.fetch(`${APP}/api/projects`, { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("server-timing")).toBeNull();
    expect(await res.json()).toEqual({ error: "a Cloudflare Access login for this app is required" });
  });

  it("matches If-None-Match as a list, weakly, and `*`", () => {
    expect(matches(null, '"a"')).toBe(false);
    expect(matches('"b", W/"a"', '"a"')).toBe(true);
    expect(matches("*", '"a"')).toBe(true);
    expect(matches('"ab"', '"a"')).toBe(false);
  });
});

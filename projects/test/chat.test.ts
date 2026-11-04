// The chat's pages (GET /api/projects/:id/chat, `before` and `limit`) and stopping the manager's turn
// (POST /api/projects/:id/manager/interrupt, nest's owner route).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHAT_PAGE, CHAT_PAGE_MAX } from "../src/do/project";
import { AccessTeam, api, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let token: string;
beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

async function newProject() {
  const repo = `o-${crypto.randomUUID().slice(0, 8)}/r`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return p.body as { id: string; settings: { manager: string } };
}

describe("the chat's pages", () => {
  it("answers the latest page, then the ones before a seq, oldest first, never past the cap", async () => {
    const p = await newProject();
    for (let i = 1; i <= CHAT_PAGE + 5; i++) expect((await api(token, "POST", `/api/projects/${p.id}/chat`, { text: `m${i}` })).status).toBe(201);
    const latest = (await api(token, "GET", `/api/projects/${p.id}/chat`)).body as { seq: number; text: string }[];
    expect(latest).toHaveLength(CHAT_PAGE);
    expect(latest.at(-1)!.text).toBe(`m${CHAT_PAGE + 5}`);
    expect(latest.map((m) => m.seq)).toEqual([...latest.map((m) => m.seq)].sort((a, b) => a - b));
    const older = (await api(token, "GET", `/api/projects/${p.id}/chat?before=${latest[0]!.seq}`)).body as { seq: number; text: string }[];
    expect(older.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(older.every((m) => m.seq < latest[0]!.seq)).toBe(true);
    const capped = (await api(token, "GET", `/api/projects/${p.id}/chat?limit=9999`)).body as unknown[];
    expect(capped.length).toBeLessThanOrEqual(CHAT_PAGE_MAX);
    expect((await api(token, "GET", `/api/projects/${p.id}/chat?limit=3`)).body).toHaveLength(3);
    expect((await api(token, "GET", `/api/projects/${p.id}/chat?before=x`)).status).toBe(400);
  });
});

describe("stopping the manager's turn", () => {
  it("interrupts the project's manager in nest", async () => {
    const p = await newProject();
    const r = await api(token, "POST", `/api/projects/${p.id}/manager/interrupt`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.interrupts).toContain(p.settings.manager);
    expect(fake.callsTo("POST", new RegExp(`^/v1/agents/${p.settings.manager}/interrupt$`))).toHaveLength(1);
  });

  it("says when nest refuses", async () => {
    const p = await newProject();
    fake.fail(new RegExp(`^POST /v1/agents/${p.settings.manager}/interrupt$`), 404);
    expect((await api(token, "POST", `/api/projects/${p.id}/manager/interrupt`)).status).toBe(404);
  });
});

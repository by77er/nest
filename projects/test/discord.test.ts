// Linked Discord servers (README.md#linked-servers-discord): the owner links a project to a Discord server
// (guild) in the API only; the linked client's agents of that guild then read its board and propose tasks on
// /mcp/discord, and reach nothing else. Who may call is test/identity.test.ts's; this file is what they reach.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MIGRATIONS } from "../src/do/directory";
import { migrate } from "../src/sql";
import { MAX_LINKED_PROPOSALS, TOOLS } from "../src/tools";
import { AccessTeam, agentClaims, APP, api, callTool, FakeNest, installFetch, linkedClaims, Signer } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let token: string;
let nest: Signer;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
  nest = await Signer.create("k1");
  fake.jwks = { keys: [await nest.jwk()] };
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
/** A fresh server id (a snowflake's shape), so tests don't share links. */
const newGuild = () => `1${String(Math.floor(Math.random() * 1e17)).padStart(17, "0")}`;

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(p.status).toBe(201);
  return { id: p.body.id as string, repo, manager: p.body.settings.manager as string };
}
const link = (project: string, guild: string) => api(token, "PUT", `/api/projects/${project}/links/${guild}`);
const bot = (guild: string, agent = `agt_bot${rand()}`, over: Record<string, unknown> = {}) => nest.sign(linkedClaims(agent, guild, over));

const ok = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBe(true);
  return r.result.content[0].text as string;
};

describe("the links API", () => {
  it("links, lists and removes a project's servers, validating the id", async () => {
    const p = await newProject();
    const g = newGuild();
    expect((await api(token, "GET", `/api/projects/${p.id}/links`)).body).toEqual({ links: [], max: 20 });
    const first = await link(p.id, g);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ guild: g });
    // Again: the same link, its time kept.
    expect((await link(p.id, g)).body).toEqual(first.body);
    // A short one is a server id too (the route doesn't read it as a number).
    expect((await link(p.id, "7")).status).toBe(200);
    expect((await api(token, "GET", `/api/projects/${p.id}/links`)).body.links.map((l: { guild: string }) => l.guild)).toEqual([g, "7"]);
    for (const bad of ["0123", "12a", "1".repeat(26), "-5", "%20"]) {
      const r = await link(p.id, bad);
      expect(r.status, bad).toBe(400);
      expect(r.body.error).toMatch(/1 to 25 digits/);
    }
    expect((await link(p.id, "9".repeat(25))).status).toBe(200);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/links/7`)).body).toEqual({ removed: "7" });
    expect((await api(token, "DELETE", `/api/projects/${p.id}/links/7`)).status).toBe(404);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/links/0x`)).status).toBe(400);
    expect((await api(token, "GET", `/api/projects/prj_nosuch/links`)).status).toBe(404);
    expect((await link("prj_nosuch", g)).status).toBe(404);
  });

  it("caps a project's links at 20", async () => {
    const p = await newProject();
    for (let k = 0; k < 20; k++) expect((await link(p.id, String(1000 + k))).status).toBe(200);
    const over = await link(p.id, "5000");
    expect(over.status).toBe(409);
    expect(over.body.error).toMatch(/at most 20/);
    // One already linked is still answered, and another project has its own 20.
    expect((await link(p.id, "1000")).status).toBe(200);
    expect((await link((await newProject()).id, "5000")).status).toBe(200);
  });

  it("is behind Access like the rest of the API", async () => {
    const p = await newProject();
    const res = await SELF.fetch(`${APP}/api/projects/${p.id}/links/123`, { method: "PUT" });
    expect(res.status).toBe(403);
    expect((await api(token, "GET", `/api/projects/${p.id}/links`)).body.links).toEqual([]);
  });

  it("goes with its project: a project's row removed takes its links, whichever code removes it", async () => {
    const a = await newProject();
    const b = await newProject();
    const g = newGuild();
    await link(a.id, g);
    await link(b.id, g);
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    await runInDurableObject(dir, (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("DELETE FROM projects WHERE id = ?", a.id);
      expect(st.storage.sql.exec("SELECT project FROM links WHERE guild = ?", g).toArray().map((r) => r.project)).toEqual([b.id]);
    });
    expect(ok(await callTool("discord", await bot(g), "list_projects")).projects.map((x: { id: string }) => x.id)).toEqual([b.id]);
  });

  it("comes with DirectoryDO's migration on the release before's shape, which it leaves as it was", async () => {
    const p = await newProject();
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    await runInDurableObject(dir, (_o: unknown, st: DurableObjectState) => {
      const sql = st.storage.sql;
      // As the release before left it: no links table, no trigger.
      sql.exec("DROP TRIGGER projects_links");
      sql.exec("DROP TABLE links");
      sql.exec("UPDATE schema_version SET v = ?", MIGRATIONS.length - 1);
      expect(migrate(st.storage, MIGRATIONS)).toBe(MIGRATIONS.length);
      expect(sql.exec("SELECT COUNT(*) AS n FROM links").one().n).toBe(0);
      expect(sql.exec("SELECT id FROM projects WHERE id = ?", p.id).toArray()).toHaveLength(1);
    });
    expect((await link(p.id, "42")).status).toBe(200);
  });
});

describe("/mcp/discord's scope", () => {
  it("lists only the ready projects linked to the caller's guild", async () => {
    const a = await newProject();
    const b = await newProject();
    const c = await newProject();
    const g = newGuild();
    const other = newGuild();
    await link(a.id, g);
    await link(b.id, g);
    await link(c.id, other);
    const got = ok(await callTool("discord", await bot(g), "list_projects")).projects;
    expect(got.map((x: { id: string }) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(got.find((x: { id: string }) => x.id === a.id)).toEqual({ id: a.id, name: a.repo, repo: a.repo });
    expect(ok(await callTool("discord", await bot(newGuild()), "list_projects")).projects).toEqual([]);
  });

  it("answers a project not linked to the caller's guild as unknown, whether it exists or not, and touches nothing", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const g = newGuild();
    const other = newGuild();
    await link(mine.id, g);
    await link(theirs.id, other);
    const task = (await api(token, "POST", `/api/projects/${theirs.id}/tasks`, { title: "theirs" })).body;
    const t = await bot(g);
    for (const project of [theirs.id, "prj_nosuch"]) {
      expect(toolError(await callTool("discord", t, "list_tasks", { project }))).toBe("unknown project");
      expect(toolError(await callTool("discord", t, "get_task", { project, task: task.id }))).toBe("unknown project");
      expect(toolError(await callTool("discord", t, "recent_activity", { project }))).toBe("unknown project");
      expect(toolError(await callTool("discord", t, "propose_task", { project, title: "x", body: "y" }))).toBe("unknown project");
    }
    // Another project's task, named through a linked project, is that project's unknown task.
    expect(toolError(await callTool("discord", t, "get_task", { project: mine.id, task: task.id }))).toMatch(/unknown task/);
    expect((await api(token, "GET", `/api/projects/${theirs.id}/proposals`)).body).toEqual([]);
    expect((await api(token, "GET", `/api/projects/${mine.id}/proposals`)).body).toEqual([]);
  });

  it("stops at once when the link is removed", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const t = await bot(g);
    ok(await callTool("discord", t, "list_tasks", { project: p.id }));
    await api(token, "DELETE", `/api/projects/${p.id}/links/${g}`);
    expect(toolError(await callTool("discord", t, "list_tasks", { project: p.id }))).toBe("unknown project");
    expect(ok(await callTool("discord", t, "list_projects")).projects).toEqual([]);
  });

  it("has only its own tools: nothing that assigns, starts, changes or reads memory, chat or secrets", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const t = await bot(g);
    for (const name of ["create_task", "assign_task", "update_task", "cancel_task", "manager_chat", "memory_list", "memory_write", "request_secret", "attach_pr"]) {
      expect(toolError(await callTool("discord", t, name, { project: p.id }))).toBe(`unknown tool ${name}`);
    }
    // Arguments are the tool's schema's: none other.
    expect(toolError(await callTool("discord", t, "list_tasks", { project: p.id, extra: 1 }))).toMatch(/not an argument/);
    expect(toolError(await callTool("discord", t, "list_tasks", {}))).toMatch(/project is required/);
    // Reads are marked so, the one write isn't.
    expect(TOOLS.discord.filter((x) => !x.readOnly).map((x) => x.name)).toEqual(["propose_task"]);
  });

  it("is held to its project by the project's object too, not only by the Worker's link check", async () => {
    const a = await newProject();
    const b = await newProject();
    const caller = { kind: "linked" as const, agent: "agt_bot", client: "cli_bot", guild: "1", tainted: false };
    const r = await env.PROJECT.get(env.PROJECT.idFromName(b.id)).linkedCall(caller, "list_tasks", { project: a.id }, null);
    expect(r).toEqual({ result: null, error: "unknown project" });
  });
});

describe("/mcp/discord's reads", () => {
  it("reads a linked project's board, a task in full and its recent activity, as a routine run does", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const task = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "the first", body: "what and why" })).body;
    const t = await bot(g);
    const board = ok(await callTool("discord", t, "list_tasks", { project: p.id }));
    expect(board.tasks.map((x: { id: string; title: string }) => [x.id, x.title])).toEqual([[task.id, "the first"]]);
    // The board only: not the project's settings, as the manager's list carries.
    expect(board).not.toHaveProperty("project");
    const full = ok(await callTool("discord", t, "get_task", { project: p.id, task: task.id }));
    expect(full).toMatchObject({ id: task.id, body: "what and why" });
    expect(full.history.map((h: { action: string }) => h.action)).toEqual(["created"]);
    const activity = ok(await callTool("discord", t, "recent_activity", { project: p.id, days: 3 }));
    expect(Object.keys(activity).sort()).toEqual(["merged_prs", "pr_comments", "reviews", "since_ms", "tasks_done"]);
    // The same answers as the routine server's reads (src/do/project.ts recentActivity, taskSummaries).
    expect(activity.since_ms).toBeGreaterThan(Date.now() - 3 * 24 * 3600_000 - 60_000);
  });
});

describe("propose_task on /mcp/discord", () => {
  it("lands in triage as a routine's proposal does, tainted, marked with its server and agent; accepted, it's a draft naming them", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const agent = `agt_bot${rand()}`;
    const r = ok(await callTool("discord", await bot(g, agent), "propose_task", { project: p.id, title: "  Dark mode  ", body: "Please." }));
    expect(r).toMatchObject({ where: "triage" });
    const [prop] = (await api(token, "GET", `/api/projects/${p.id}/proposals`)).body;
    expect(prop).toMatchObject({ id: r.proposal, title: "Dark mode", body: "Please.", guild: g, source: `discord:${g}/${agent}`, run: agent, state: "untriaged" });
    // Nothing on the board yet, and it waits for the owner in "Needs you".
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks`)).body).toEqual([]);
    expect((await api(token, "GET", `/api/projects/${p.id}/attention`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "triage", proposals: 1 })]));
    const accepted = await api(token, "POST", `/api/projects/${p.id}/proposals/${r.proposal}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: "draft", title: "Dark mode", tainted: true });
    expect(accepted.body.body).toBe(`Please.\n\nProposed from the Discord server ${g} (agent ${agent}).`);
    const full = (await api(token, "GET", `/api/projects/${p.id}/tasks/${accepted.body.id}`)).body;
    const h = full.history.find((x: { action: string }) => x.action === "proposal_accepted");
    expect(h).toMatchObject({ actor: "owner", tainted: true });
    expect(JSON.parse(h.detail)).toMatchObject({ proposal: r.proposal, source: `discord:${g}/${agent}` });
  });

  it("is recorded tainted whatever the session says", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const r = ok(await callTool("discord", await bot(g, undefined, { tainted: false }), "propose_task", { project: p.id, title: "clean?", body: "b" }));
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o: unknown, st: DurableObjectState) => {
      expect(st.storage.sql.exec("SELECT tainted FROM proposals WHERE id = ?", r.proposal).one().tainted).toBe(1);
    });
  });

  it("is applied once for the caller's own call key, and not answered from another agent's", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    const agent = `agt_bot${rand()}`;
    const t = await bot(g, agent);
    const key = `${agent}/1/call-${rand()}`;
    const a = ok(await callTool("discord", t, "propose_task", { project: p.id, title: "once", body: "b" }, { "nest/call": key }));
    const b = ok(await callTool("discord", t, "propose_task", { project: p.id, title: "once", body: "b" }, { "nest/call": key }));
    expect(b.proposal).toBe(a.proposal);
    expect((await api(token, "GET", `/api/projects/${p.id}/proposals`)).body).toHaveLength(1);
    const foreign = `agt_someoneelse/1/call-${rand()}`;
    const c = ok(await callTool("discord", t, "propose_task", { project: p.id, title: "twice", body: "b" }, { "nest/call": foreign }));
    const d = ok(await callTool("discord", t, "propose_task", { project: p.id, title: "twice", body: "b" }, { "nest/call": foreign }));
    expect(d.proposal).not.toBe(c.proposal);
  });

  it(`holds at most ${MAX_LINKED_PROPOSALS} of one server's proposals waiting in a project; another server has its own`, async () => {
    const p = await newProject();
    const g = newGuild();
    const other = newGuild();
    await link(p.id, g);
    await link(p.id, other);
    const t = await bot(g);
    for (let k = 0; k < MAX_LINKED_PROPOSALS; k++) ok(await callTool("discord", t, "propose_task", { project: p.id, title: `idea ${k}`, body: "b" }));
    expect(toolError(await callTool("discord", t, "propose_task", { project: p.id, title: "one more", body: "b" }))).toMatch(new RegExp(`your Discord server has ${MAX_LINKED_PROPOSALS} proposals waiting`));
    ok(await callTool("discord", await bot(other), "propose_task", { project: p.id, title: "theirs", body: "b" }));
    // Triaging one makes room again.
    const waiting = (await api(token, "GET", `/api/projects/${p.id}/proposals`)).body as { id: string; guild: string }[];
    await api(token, "POST", `/api/projects/${p.id}/proposals/${waiting.find((x) => x.guild === g)!.id}/decline`, {});
    ok(await callTool("discord", t, "propose_task", { project: p.id, title: "one more", body: "b" }));
  });

  it("refuses a title the owner declined lately, telling the owner's reason only to the server whose proposal it was", async () => {
    const p = await newProject();
    const g = newGuild();
    const other = newGuild();
    await link(p.id, g);
    await link(p.id, other);
    const r = ok(await callTool("discord", await bot(g), "propose_task", { project: p.id, title: "Rewrite it in Rust", body: "b" }));
    await api(token, "POST", `/api/projects/${p.id}/proposals/${r.proposal}/decline`, { reason: "not now" });
    expect(toolError(await callTool("discord", await bot(g), "propose_task", { project: p.id, title: "rewrite it in rust!", body: "b" }))).toMatch(/declined .*\(their reason: not now\)/);
    const theirs = toolError(await callTool("discord", await bot(other), "propose_task", { project: p.id, title: "Rewrite it in Rust", body: "b" }));
    expect(theirs).toMatch(/declined/);
    expect(theirs).not.toMatch(/not now/);
  });

  it("needs a title", async () => {
    const p = await newProject();
    const g = newGuild();
    await link(p.id, g);
    expect(toolError(await callTool("discord", await bot(g), "propose_task", { project: p.id, title: "   ", body: "b" }))).toMatch(/needs a title/);
  });
});

describe("the catalog", () => {
  it("publishes no capability for /mcp/discord: the linked client makes its own", async () => {
    await newProject();
    expect((await api(token, "POST", "/api/admin/sync")).status).toBe(200);
    const caps = [...fake.catalog.entries()].filter(([k]) => k.startsWith("capabilities/"));
    expect(caps.length).toBeGreaterThan(0);
    expect(caps.filter(([, v]) => JSON.stringify(v).includes("/mcp/discord"))).toEqual([]);
    expect(caps.map(([k]) => k)).not.toContain("capabilities/projects/discord");
  });

  it("and a manager's token for /mcp/discord isn't one the app's own catalog makes", async () => {
    // The app's agents have no capability naming that URL; one signed for it anyway is refused.
    const p = await newProject();
    const t = await nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", guild: "1" }, { aud: `${APP}/mcp/discord` }));
    expect((await callTool("discord", t, "list_projects")).status).toBe(403);
  });
});

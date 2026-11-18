// The board's list (`GET /api/projects/:id/tasks`, README.md#built-the-core): every task as `toTask` makes
// it, but without its body and spec, read in a fixed number of SQL statements however many tasks there are.
// The drawer's task read and the agents' `list_tasks` keep theirs.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import type { ProjectDO, Task } from "../src/do/project";
import { AccessTeam, agentClaims, api, APP, callTool, FakeNest, installFetch, Signer } from "./fake-nest";

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
const spec = { goal: "g", acceptance_criteria: ["a"], files: ["f"], test_plan: "p" };
const owner = { kind: "owner" } as const;

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, manager: p.settings.manager as string };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
// What the DO keeps private, reached in the object (runInDurableObject).
type Inner = { toTask(r: Record<string, SqlStorageValue>): Task; ctx: DurableObjectState };
const inner = (o: ProjectDO) => o as unknown as Inner;

/**
 * Every case the list carries: PRs open and merged (two on one task), dependencies both ways (one blocker
 * done, so `waiting_on` differs from `blocked_by`), issues with a failed, an owed and a closed close, a task a
 * tainted session wrote, a blocked task, a cancelled one, specced and not.
 */
async function seed(p: P) {
  const s = stub(p);
  const make = async (title: string, actor: Parameters<ProjectDO["createTask"]>[1] = owner) => {
    const r = await s.createTask({ title, body: `${title}'s body` }, actor);
    if (!r.ok) throw new Error(r.error);
    return r.value.id;
  };
  const ids = {
    prs: await make("with PRs"),
    blocker: await make("a blocker"),
    doneBlocker: await make("a done blocker"),
    waiter: await make("waits on two"),
    issueFailed: await make("issue close failed"),
    issueOwed: await make("issue close owed"),
    issueClosed: await make("issue closed"),
    tainted: await make("a tainted session wrote it", { kind: "agent", agent: "agt_x", tainted: true }),
    blocked: await make("blocked"),
    cancelled: await make("cancelled"),
    plain: await make("plain draft"),
  };
  for (const id of [ids.prs, ids.blocker, ids.doneBlocker, ids.waiter, ids.blocked, ids.cancelled]) expect((await s.writeSpec(id, spec)).ok).toBe(true);
  await s.onPullRequest({ pr: 11, task: ids.prs, action: "opened", merged: false, title: "first", fork: false });
  await s.onPullRequest({ pr: 12, task: ids.prs, action: "opened", merged: false, title: "second", fork: false });
  await s.onPullRequest({ pr: 11, task: ids.prs, action: "closed", merged: true });
  await s.onPullRequest({ pr: 13, task: ids.doneBlocker, action: "opened", merged: false, title: "done's", fork: false });
  await s.onPullRequest({ pr: 13, task: ids.doneBlocker, action: "closed", merged: true });
  expect((await s.addDependency(ids.waiter, ids.blocker, owner)).ok).toBe(true);
  expect((await s.addDependency(ids.waiter, ids.doneBlocker, owner)).ok).toBe(true);
  expect((await s.addDependency(ids.blocker, ids.prs, owner)).ok).toBe(true);
  expect((await s.cancel(ids.cancelled, owner, "not needed")).ok).toBe(true);
  await runInDurableObject(s, async (o: ProjectDO) => {
    const blocked = await (o as unknown as { block(id: string, c: unknown, by: string, reason: string, q: string | null): Promise<{ ok: boolean }> })
      .block(ids.blocked, { kind: "agent", agent: p.manager, role: "manager", labels: {}, tainted: true }, "manager", "why", "which one?");
    expect(blocked.ok).toBe(true);
    // Issues and their closes as triage and a done task leave them (README.md#triage).
    const sql = inner(o).ctx.storage.sql;
    sql.exec("UPDATE tasks SET issue = 41 WHERE id = ?", ids.issueFailed);
    sql.exec("INSERT INTO issue_closes (task, issue, next_ms, error, owed_ms) VALUES (?, 41, NULL, 'Resource not accessible by integration', 1)", ids.issueFailed);
    sql.exec("UPDATE tasks SET issue = 42 WHERE id = ?", ids.issueOwed);
    sql.exec("INSERT INTO issue_closes (task, issue, next_ms, owed_ms) VALUES (?, 42, ?, 1)", ids.issueOwed, Date.now() + 3_600_000);
    sql.exec("UPDATE tasks SET issue = 43 WHERE id = ?", ids.issueClosed);
    sql.exec("INSERT INTO issue_closes (task, issue, next_ms, closed_ms, owed_ms) VALUES (?, 43, NULL, 2, 1)", ids.issueClosed);
  });
  return ids;
}

/** What `toTask` makes of every task, in the board's order: the list as it was before summaries. */
const fullTasks = (p: P) =>
  runInDurableObject(stub(p), (o: ProjectDO) => {
    const sql = inner(o).ctx.storage.sql;
    const rows = sql.exec("SELECT t.*, EXISTS (SELECT 1 FROM history h WHERE h.task = t.id AND h.tainted = 1) AS tainted FROM tasks t ORDER BY t.ord, t.created_ms").toArray();
    return rows.map((r) => inner(o).toTask(r));
  });

/** `sql.exec` calls `f` makes in the object. */
async function statements<T>(p: P, f: (o: ProjectDO) => Promise<T>): Promise<{ n: number; value: T }> {
  return runInDurableObject(stub(p), async (o: ProjectDO) => {
    const sql = inner(o).ctx.storage.sql;
    const exec = sql.exec;
    let n = 0;
    sql.exec = ((...a: Parameters<typeof exec>) => (n++, exec.apply(sql, a))) as typeof exec;
    try {
      const value = await f(o);
      return { n, value };
    } finally {
      sql.exec = exec;
    }
  });
}

describe("the board's list", () => {
  it("is each task as toTask makes it, without its body and spec, in the board's order", async () => {
    const p = await newProject();
    const ids = await seed(p);
    const list = await api(token, "GET", `/api/projects/${p.id}/tasks`);
    expect(list.status).toBe(200);
    const full = await fullTasks(p);
    expect(full.map((t) => t.id)).toEqual(Object.values(ids));
    // Field by field, keys in the same order.
    expect(list.body).toEqual(full.map(({ body: _b, spec: _s, ...t }) => t));
    expect(list.body.map((t: object) => Object.keys(t))).toEqual(full.map(({ body: _b, spec: _s, ...t }) => Object.keys(t)));
    for (const t of list.body) {
      expect(t).not.toHaveProperty("body");
      expect(t).not.toHaveProperty("spec");
    }
    // The seed has what it says (so the comparison above isn't over empty fields).
    const by = new Map<string, Task>(full.map((t) => [t.id, t]));
    expect(by.get(ids.prs)!.prs.map((x) => [x.number, x.state])).toEqual([[11, "merged"], [12, "open"]]);
    expect(by.get(ids.prs)!.blocks.map((x) => x.id)).toEqual([ids.blocker]);
    expect(by.get(ids.waiter)!.blocked_by.map((x) => x.id)).toEqual([ids.blocker, ids.doneBlocker]);
    expect(by.get(ids.waiter)!.waiting_on).toEqual([ids.blocker]);
    expect(by.get(ids.doneBlocker)!.state).toBe("done");
    expect(by.get(ids.issueFailed)!.issue).toEqual({ number: 41, close: "failed", error: "Resource not accessible by integration" });
    expect(by.get(ids.issueOwed)!.issue?.close).toBe("owed");
    expect(by.get(ids.issueClosed)!.issue?.close).toBe("closed");
    expect(full.filter((t) => t.tainted).map((t) => t.id).sort()).toEqual([ids.tainted, ids.blocked].sort());
    expect(by.get(ids.blocked)!.blocked).toMatchObject({ role: "manager", question: "which one?", tainted: true });
    expect(by.get(ids.cancelled)!.state).toBe("cancelled");
  });

  it("the drawer's task read keeps the body, the spec and the history", async () => {
    const p = await newProject();
    const ids = await seed(p);
    const t = (await api(token, "GET", `/api/projects/${p.id}/tasks/${ids.waiter}`)).body;
    const full = (await fullTasks(p)).find((x) => x.id === ids.waiter)!;
    const { history, ...rest } = t;
    expect(rest).toEqual(full);
    expect(t.body).toBe("waits on two's body");
    expect(t.spec).toEqual(spec);
    expect(history.map((h: { action: string }) => h.action)).toContain("dependency_added");
  });

  it("the manager's list_tasks answers each task as toTask makes it, with `specced` for its spec", async () => {
    const p = await newProject();
    await seed(p);
    const full = await fullTasks(p);
    const r = await callTool("board", await nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" })), "list_tasks");
    expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
    expect(r.result.structuredContent.tasks).toEqual(full.map(({ body: _b, spec: s, ...t }) => ({ ...t, specced: s !== null })));
  });

  it("is read in the same number of statements for 3 tasks and for 300", async () => {
    const count = async (n: number) => {
      const p = await newProject();
      await runInDurableObject(stub(p), async (o: ProjectDO) => {
        const ids: string[] = [];
        for (let i = 0; i < n; i++) {
          const r = await o.createTask({ title: `t${i}`, body: "b" }, i % 7 === 0 ? { kind: "agent", agent: "agt_x", tainted: true } : owner);
          if (!r.ok) throw new Error(r.error);
          ids.push(r.value.id);
        }
        for (let i = 0; i < n; i += 3) {
          await o.onPullRequest({ pr: 1000 + i, task: ids[i]!, action: "opened", merged: false, title: "pr" });
          if (i > 0) await o.addDependency(ids[i]!, ids[i - 1]!, owner);
        }
      });
      const r = await statements(p, (o) => o.listTasks());
      expect(r.value.ok && r.value.value.length).toBe(n);
      return r.n;
    };
    const few = await count(3);
    expect(await count(300)).toBe(few);
  }, 60_000);

  it("reads which tasks are tainted through the index of tainted history rows, not the whole history", async () => {
    const p = await newProject();
    const plan = await runInDurableObject(stub(p), (o: ProjectDO) =>
      inner(o).ctx.storage.sql.exec("EXPLAIN QUERY PLAN SELECT DISTINCT task FROM history WHERE tainted = 1").toArray().map((r) => r.detail as string).join("\n"));
    expect(plan).toMatch(/USING (COVERING )?INDEX history_tainted/);
  });
});

/**
 * The measurement the change was made for, on a project of 300 tasks (bodies ~1 KB, specs ~3 KB, a third with
 * a PR and a dependency): what one poll of the list costs, printed for the PR (README.md#built-the-core).
 */
describe("the list's size", () => {
  it("on 300 tasks", async () => {
    const p = await newProject();
    // Text that compresses as prose does, not as one repeated letter: words picked by a fixed generator.
    const words = "the task list board poll worker manager spec body drawer review merge branch query cache index statement summary page owner agent sandbox".split(" ");
    let x = 1;
    const prose = (bytes: number) => {
      let t = "";
      while (t.length < bytes) t += `${words[(x = (x * 1103515245 + 12345) % 2 ** 31) % words.length]}${x % 11 === 0 ? ". " : " "}`;
      return t.slice(0, bytes);
    };
    const big = () => ({ goal: prose(500), acceptance_criteria: Array.from({ length: 5 }, () => prose(300)), files: ["projects/src/do/project.ts"], test_plan: prose(1000) });
    await runInDurableObject(stub(p), async (o: ProjectDO) => {
      const ids: string[] = [];
      for (let i = 0; i < 300; i++) {
        const r = await o.createTask({ title: `Task number ${i}`, body: prose(1024) }, owner);
        if (!r.ok) throw new Error(r.error);
        ids.push(r.value.id);
        await o.writeSpec(r.value.id, big());
      }
      for (let i = 0; i < 300; i += 3) {
        await o.onPullRequest({ pr: 1000 + i, task: ids[i]!, action: "opened", merged: false, title: `PR for ${i}` });
        if (i > 0) await o.addDependency(ids[i]!, ids[i - 1]!, owner);
      }
    });
    const res = await SELF.fetch(`${APP}/api/projects/${p.id}/tasks`, { headers: { "cf-access-jwt-assertion": token } });
    const raw = new Uint8Array(await res.arrayBuffer());
    const gz = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    const n = (await statements(p, (o) => o.listTasks())).n;
    console.log(`list of 300 tasks: ${raw.length} bytes raw, ${gz.length} bytes gzip, ${n} SQL statements`);
    expect(res.status).toBe(200);
  }, 120_000);
});

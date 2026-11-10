// A task's PRs and dependencies (README.md#prs, README.md#dependencies): PRs attached by the owner, the
// manager, a worker or a branch, a task done only once all have merged, auto-merge on every attached PR
// from the repo itself; tasks waiting on others, not assigned until those are done; the live worker told
// of each change. Against the fake nest and GitHub (test/fake-nest.ts).
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MIGRATIONS } from "../src/do/project";
import { migrate } from "../src/sql";
import { AccessTeam, agentClaims, api, callTool, deliverGithub, FakeNest, installFetch, prEvent, prNode, repoIdOf, Signer } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
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
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
let clock = Date.parse("2026-11-03T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

async function newProject(o: Record<string, unknown> = {}) {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo, ...o })).body;
  return { id: p.id as string, repo, manager: p.settings.manager as string };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));

async function readyTask(p: P, title = "t") {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  return t.id as string;
}
async function withWorker(p: P, title = "t") {
  const id = await readyTask(p, title);
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
  expect(a.state, JSON.stringify(a)).toBe("in_progress");
  return { id, worker: a.assignee as string };
}
const task = async (p: P, id: string) => (await api(token, "GET", `/api/projects/${p.id}/tasks/${id}`)).body;
const attach = (p: P, id: string, pr: number | string) => api(token, "POST", `/api/projects/${p.id}/tasks/${id}/prs`, { pr });
const managerToken = (p: P) => nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" }));
const closed = (p: P, n: number, merged: boolean) => deliverGithub("pull_request", prEvent({ repo: p.repo, number: n, sha: sha(), action: "closed", merged, updated_at: later() }));
const afterWindow = async (p: P) => {
  await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET notify_next_ms = 0 WHERE notify_next_ms IS NOT NULL"); });
  await stub(p).drain();
};
const ok = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.result?.isError).toBe(true);
  return r.result.content[0].text as string;
};

describe("attaching PRs", () => {
  it("a task's PR opened after the repo was renamed is still the repo's own, by GitHub's ids: attached to its task, not a fork's", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    // The repo's id, as attach read it from GitHub.
    const id = repoIdOf(p.repo);
    const renamed = `${p.repo}-renamed`;
    const opened = (n: number, repoName: string, headId: number) => {
      const e = prEvent({ repo: p.repo, number: n, sha: sha(), action: "opened", ref: `task/${w.id}`, updated_at: later() });
      return { ...e, repository: { id, full_name: repoName }, pull_request: { ...e.pull_request, head: { ...e.pull_request.head, repo: { id: headId, full_name: repoName } } } };
    };
    // The project learns the repo's id from an event under the name it was created with.
    await deliverGithub("pull_request", opened(21, p.repo, id));
    await deliverGithub("pull_request", opened(22, renamed, id));
    // A fork's branch of the same name, under the new name's lookalike: not the repo's own.
    await deliverGithub("pull_request", opened(23, renamed, id + 1));
    const t = await task(p, w.id);
    expect(t.prs.map((x: { number: number; fork: boolean }) => [x.number, x.fork])).toEqual([[21, false], [22, false]]);
  });

  it("the owner attaches open PRs by number, #n or URL, checked on GitHub; the task goes to review", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    for (const n of [11, 12, 13]) gh.pull(p.repo, n);
    expect((await attach(p, w.id, 11)).body).toMatchObject({ state: "in_review", pr: 11 });
    expect((await attach(p, w.id, "#12")).status).toBe(200);
    expect((await attach(p, w.id, `https://github.com/${p.repo}/pull/13`)).status).toBe(200);
    const t = await task(p, w.id);
    expect(t.prs.map((x: { number: number; state: string; fork: boolean }) => [x.number, x.state, x.fork])).toEqual([[11, "open", false], [12, "open", false], [13, "open", false]]);
    expect(t.pr).toBe(11);
    // Not another repo's, not a closed one, not one that doesn't exist.
    expect((await attach(p, w.id, "https://github.com/someone/else/pull/14")).status).toBe(400);
    gh.pull(p.repo, 15, { state: "closed" });
    expect((await attach(p, w.id, 15)).body.error).toMatch(/is closed/);
    expect((await attach(p, w.id, 99)).status).toBe(404);
    // Its token reads PRs only.
    expect(fake.calls.filter((c) => c.path === "/v1/clients/self/github-token" && c.body.permissions.pull_requests === "read").at(-1)!.body.permissions).toEqual({ pull_requests: "read" });
  });

  it("a PR attached to one task is refused for another, by the owner and by a branch alike", async () => {
    const p = await newProject();
    const a = await withWorker(p, "a");
    const b = await withWorker(p, "b");
    gh.pull(p.repo, 20);
    await attach(p, a.id, 20);
    expect((await attach(p, b.id, 20)).body.error).toMatch(new RegExp(`attached to ${a.id}: detach it there first`));
    // The PR's branch names b: the branch never moves it.
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 20, sha: sha(), action: "reopened", ref: `task/${b.id}`, updated_at: later() }));
    expect((await task(p, a.id)).prs.map((x: { number: number }) => x.number)).toEqual([20]);
    expect((await task(p, b.id)).prs).toEqual([]);
    // Detached from a, it can be attached to b.
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${a.id}/prs/20`)).status).toBe(200);
    expect((await attach(p, b.id, 20)).status).toBe(200);
  });

  it("the manager attaches and detaches through /mcp/board", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 30);
    const t = await managerToken(p);
    expect(ok(await callTool("board", t, "attach_pr", { task: id, pr: 30 })).prs.map((x: { number: number }) => x.number)).toEqual([30]);
    expect(ok(await callTool("board", t, "detach_pr", { task: id, pr: 30 })).prs).toEqual([]);
    expect(toolError(await callTool("board", t, "detach_pr", { task: id, pr: 30 }))).toMatch(/isn't attached/);
  });
});

describe("merging", () => {
  it("one PR of several merged leaves the task in review; the last makes it done and ends its worker", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    gh.pull(p.repo, 40);
    gh.pull(p.repo, 41);
    await attach(p, w.id, 40);
    await attach(p, w.id, 41);
    await closed(p, 40, true);
    let t = await task(p, w.id);
    expect(t.state).toBe("in_review");
    expect(t.prs.map((x: { number: number; state: string }) => [x.number, x.state])).toEqual([[40, "merged"], [41, "open"]]);
    // A merged PR stays attached.
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${w.id}/prs/40`)).status).toBe(409);
    await closed(p, 41, true);
    t = await task(p, w.id);
    expect(t.state).toBe("done");
    await stub(p).drain();
    expect(fake.agents.get(w.worker)!.ended).toBe(true);
  });

  it("a PR closed without merging is detached with a note; the task is done if the rest merged", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    gh.pull(p.repo, 50);
    gh.pull(p.repo, 51);
    await attach(p, w.id, 50);
    await attach(p, w.id, 51);
    await closed(p, 50, false);
    let t = await task(p, w.id);
    expect(t.prs.map((x: { number: number }) => x.number)).toEqual([51]);
    expect(t.history.at(-1)).toMatchObject({ action: "pr_closed", actor: "app:github" });
    expect(t.state).toBe("in_review");
    await closed(p, 51, true);
    expect((await task(p, w.id)).state).toBe("done");
    // Closed with nothing merged: detached, the task stays.
    const v = await withWorker(p, "v");
    gh.pull(p.repo, 52);
    await attach(p, v.id, 52);
    await closed(p, 52, false);
    t = await task(p, v.id);
    expect(t.prs).toEqual([]);
    // Its worker still runs: back in progress, to open another (README.md#the-task-machine).
    expect(t.state).toBe("in_progress");
  });
});

describe("auto-merge", () => {
  it("covers every attached PR from the repo itself, and never a fork's", async () => {
    const p = await newProject({ auto_merge: true, merge_method: "squash" });
    const w = await withWorker(p);
    gh.pull(p.repo, 60, { ref: "not-the-task-branch" });
    gh.pull(p.repo, 61, { headRepo: `stranger/${rand()}` });
    gh.pull(p.repo, 62, { headRepo: null });
    await attach(p, w.id, 60);
    await attach(p, w.id, 61);
    await attach(p, w.id, 62);
    await stub(p).drain();
    expect(gh.autoMerge.get(prNode(p.repo, 60))).toEqual({ method: "SQUASH" });
    expect(gh.autoMerge.has(prNode(p.repo, 61))).toBe(false);
    expect(gh.autoMerge.has(prNode(p.repo, 62))).toBe(false);
    const t = await task(p, w.id);
    expect(t.prs.map((x: { number: number; fork: boolean; auto_merge: { state: string } | null }) => [x.number, x.fork, x.auto_merge?.state ?? null])).toEqual([
      [60, false, "enabled"], [61, true, null], [62, true, null],
    ]);
    // Detaching undoes it.
    await api(token, "DELETE", `/api/projects/${p.id}/tasks/${w.id}/prs/60`);
    await stub(p).drain();
    expect(gh.autoMerge.get(prNode(p.repo, 60))).toBeNull();
  });

  it("a worker's reported PR gets it once the webhook says it's from the repo", async () => {
    const p = await newProject({ auto_merge: true });
    const w = await withWorker(p);
    const wt = await nest.sign(agentClaims("task", w.worker, { project: p.id, role: "worker", task: w.id, start: "1" }));
    ok(await callTool("task", wt, "report_pr", { number: 70 }));
    await stub(p).drain();
    expect(gh.autoMerge.has(prNode(p.repo, 70))).toBe(false);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 70, sha: sha(), action: "opened", ref: "worker-branch", updated_at: later() }));
    await stub(p).drain();
    expect(gh.autoMerge.get(prNode(p.repo, 70))).toEqual({ method: "SQUASH" });
  });
});

describe("auto-merge's fork rule", () => {
  it("waits for GitHub to say a PR is from the repo: one not known either way isn't auto-merged", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    // As a PR attached before GitHub's webhook said where it's from, its node id known.
    await runInDurableObject(stub(p), (_o, st) => {
      st.storage.sql.exec("INSERT INTO task_prs (pr, task, state, node, fork, attached_by, attached_ms) VALUES (95, ?, 'open', ?, NULL, 'owner', 1)", w.id, prNode(p.repo, 95));
    });
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { auto_merge: true });
    await stub(p).drain();
    expect(gh.autoMerge.has(prNode(p.repo, 95))).toBe(false);
  });
});

describe("dependencies", () => {
  it("removing the last unfinished one makes the task assignable at once, and auto-assign takes it", async () => {
    const p = await newProject();
    const a = await readyTask(p, "a");
    const b = await readyTask(p, "b");
    await api(token, "POST", `/api/projects/${p.id}/tasks/${b}/dependencies`, { blocked_by: a });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${a}/cancel`, {});
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { auto_assign: true, max_workers: 10 });
    expect((await task(p, b)).state).toBe("ready");
    await api(token, "DELETE", `/api/projects/${p.id}/tasks/${b}/dependencies/${a}`);
    expect((await task(p, b)).state).toMatch(/^(assigned|in_progress)$/);
  });

  it("a task waiting on another can't be assigned, by the owner or the manager, the blockers named", async () => {
    const p = await newProject();
    const a = await readyTask(p, "a");
    const b = await readyTask(p, "b");
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${b}/dependencies`, { blocked_by: a })).body).toMatchObject({ waiting_on: [a], blocked_by: [{ id: a, state: "ready" }] });
    expect((await task(p, a)).blocks).toEqual([expect.objectContaining({ id: b })]);
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${b}/assign`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(`it waits on ${a} (ready): they must be done first`);
    expect(toolError(await callTool("board", await managerToken(p), "assign_task", { task: b }))).toMatch(/waits on/);
    // A cycle, by the manager, with its path.
    expect(toolError(await callTool("board", await managerToken(p), "add_dependency", { task: a, blocked_by: b }))).toBe(`it would make a cycle: ${a} → ${b} → ${a}`);
  });

  it("auto-assign skips it until the last blocker is done, then takes it; a cancelled blocker still holds it", async () => {
    const p = await newProject();
    const a = await readyTask(p, "a");
    const c = await readyTask(p, "c");
    const b = await readyTask(p, "b");
    await api(token, "POST", `/api/projects/${p.id}/tasks/${b}/dependencies`, { blocked_by: a });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${b}/dependencies`, { blocked_by: c });
    // a and c are taken first, b skipped though there's room.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { auto_assign: true, max_workers: 10 });
    expect([(await task(p, a)).state, (await task(p, c)).state, (await task(p, b)).state]).toEqual(["in_progress", "in_progress", "ready"]);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${c}/cancel`, {});
    expect((await task(p, b)).waiting_on).toEqual([a, c]);
    await api(token, "DELETE", `/api/projects/${p.id}/tasks/${b}/dependencies/${c}`);
    expect((await task(p, b)).state).toBe("ready");
    // a done (its PR merged): b is assignable, and auto-assign takes it.
    gh.pull(p.repo, 80);
    await attach(p, a, 80);
    await closed(p, 80, true);
    expect((await task(p, a)).state).toBe("done");
    const tb = await task(p, b);
    expect(tb.waiting_on).toEqual([]);
    expect(tb.state).toMatch(/^(assigned|in_progress)$/);
    expect(tb.history.some((h: { action: string }) => h.action === "dependency_done")).toBe(true);
  });

  it("a worker's get_task shows what it waits on, with each one's state", async () => {
    const p = await newProject();
    const w = await withWorker(p, "w");
    const other = await readyTask(p, "other");
    ok(await callTool("board", await managerToken(p), "add_dependency", { task: w.id, blocked_by: other }));
    const wt = await nest.sign(agentClaims("task", w.worker, { project: p.id, role: "worker", task: w.id, start: "1" }));
    expect(ok(await callTool("task", wt, "get_task")).dependencies).toEqual([{ id: other, title: "other", state: "ready" }]);
  });
});

describe("the live worker", () => {
  it("is told when PRs are attached or detached, and when its dependencies change or finish", async () => {
    const p = await newProject();
    const w = await withWorker(p);
    const dep = await readyTask(p, "dep");
    gh.pull(p.repo, 90);
    await attach(p, w.id, 90);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.id}/dependencies`, { blocked_by: dep });
    await afterWindow(p);
    const notes = () => fake.inbox.filter((m) => m.agent === w.worker && m.text.startsWith(`Your task ${w.id} was changed`));
    expect(notes()).toHaveLength(1);
    expect(notes()[0]!.text).toContain("Attached PRs, before: none");
    expect(notes()[0]!.text).toContain("Attached PRs, now: #90");
    expect(notes()[0]!.text).toContain(`It waits on, now: ${dep} (ready)`);
    await api(token, "DELETE", `/api/projects/${p.id}/tasks/${w.id}/prs/90`);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${dep}/done`);
    await afterWindow(p);
    expect(notes()).toHaveLength(2);
    expect(notes()[1]!.text).toContain("Attached PRs, now: none");
    expect(notes()[1]!.text).toContain(`It waits on, now: ${dep} (done)`);
    expect(notes()[1]!.text).toContain("Nothing it waits on is unfinished now.");
  });
});

describe("the migration", () => {
  it("makes a task's single pr its first attached PR, with its auto-merge", async () => {
    const id = env.PROJECT.idFromName(`prj_migrate${rand()}`);
    await runInDurableObject(env.PROJECT.get(id), (_o, st) => {
      const sql = st.storage.sql;
      // The shape before this step: no relation tables, a task with its one PR; and none of the steps after it.
      const step = MIGRATIONS.findIndex((m) => m.some((q) => q.includes("CREATE TABLE task_prs")));
      sql.exec("DROP TABLE task_prs");
      sql.exec("DROP TABLE task_deps");
      for (const t of ["waits", "layers", "frozen_egress", "secrets", "secret_requests", "agent_secrets", "start_specs", "minted", "abandoned", "pr_inputs", "issues", "issue_closes", "routines", "routine_runs", "run_turns", "memory", "proposals", "early_exits"]) sql.exec(`DROP TABLE ${t}`);
      for (const c of ["network", "network_rev", "workers_edit_workflows", "grant_seen", "secrets_next_ms", "comments_from_id", "comments_from_login", "comments_decided", "repo_owner_id", "repo_owner_login", "routine_cap", "tasks_done_total", "prs_merged_total", "attach_gen"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      sql.exec("ALTER TABLE tasks DROP COLUMN issue");
      sql.exec("DROP INDEX chat_request");
      sql.exec("ALTER TABLE chat DROP COLUMN request_id");
      sql.exec("ALTER TABLE stops DROP COLUMN failed_ms");
      sql.exec("ALTER TABLE messages DROP COLUMN ended_ms");
      for (const t of ["pr_facts", "comments_seen"]) sql.exec(`DROP TABLE ${t}`);
      sql.exec("ALTER TABLE settings DROP COLUMN manager_restarts");
      sql.exec("ALTER TABLE settings DROP COLUMN listed_ms");
      for (const c of ["manager_model", "worker_model"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      for (const t of ["model_templates", "agent_templates"]) sql.exec(`DROP TABLE ${t}`);
      // And the triage-trust step's columns.
      for (const c of ["issues_from", "issues_dropped", "issues_dropped_ms"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      for (const c of ["manager_running_model", "switch_next_ms", "switch_after_turn", "switch_attempts"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      expect(step).toBe(MIGRATIONS.length - 15);
      sql.exec("UPDATE schema_version SET v = ?", step);
      sql.exec(`INSERT INTO tasks (id, title, body, state, ord, pr, pr_node, am_status, created_ms, updated_ms) VALUES ('tsk_old', 't', '', 'in_review', 1, 7, 'PR_x', '{"state":"enabled"}', 1, 2)`);
      sql.exec(`INSERT INTO tasks (id, title, body, state, ord, pr, created_ms, updated_ms) VALUES ('tsk_done', 't', '', 'done', 2, 8, 1, 2)`);
      migrate(st.storage, MIGRATIONS);
      expect(sql.exec("SELECT pr, task, state, node, fork, am_status FROM task_prs ORDER BY pr").toArray()).toEqual([
        { pr: 7, task: "tsk_old", state: "open", node: "PR_x", fork: 0, am_status: '{"state":"enabled"}' },
        { pr: 8, task: "tsk_done", state: "merged", node: null, fork: null, am_status: null },
      ]);
    });
  });
});

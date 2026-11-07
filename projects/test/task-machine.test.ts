// The task machine in ProjectDO (README.md#the-task-machine): the cases a sweep of the app found broken
// (B2, B3, B4, B8), each from the owner's, GitHub's or nest's side, against the real DO and the fake
// nest and GitHub. Before the machine moved a task's PRs and worker with its state, each of these ended
// somewhere the flow has no way out of, or done with its PR still open.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, api, deliver, deliverGithub, FakeNest, installFetch, ownerIdOf, prEvent } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
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

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
let clock = Date.parse("2026-11-03T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

async function newProject() {
  const owner = `o-${rand()}`.toLowerCase();
  const repo = `${owner}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, repo, owner };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const task = async (p: P, id: string) => (await api(token, "GET", `/api/projects/${p.id}/tasks/${id}`)).body;
const attach = (p: P, id: string, pr: number) => api(token, "POST", `/api/projects/${p.id}/tasks/${id}/prs`, { pr });
const done = (p: P, id: string) => api(token, "POST", `/api/projects/${p.id}/tasks/${id}/done`);
const exited = (agent: string) => deliver({ id: `evt-${rand()}`, type: "agent.exited", agent, reason: "exited" });
const queued = (p: P, id: string) => runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM pr_inputs WHERE task = ?", id).one().n);
async function readyTask(p: P, title = "t") {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  return t.id as string;
}
const comment = (p: P, pr: number, body: string) => ({
  action: "created",
  issue: { number: pr, pull_request: { url: "x" } },
  comment: { id: Number(rand().replace(/\D/g, "").slice(0, 6) || 1), body, user: { login: p.owner, id: ownerIdOf(p.owner), type: "User" }, performed_via_github_app: null, html_url: `https://github.com/${p.repo}/pull/${pr}#c` },
  repository: { full_name: p.repo },
});

describe("done needs no open PR (B2)", () => {
  it("a ready task holding an open PR isn't marked done; once its PR is detached it is", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 21);
    expect((await attach(p, id, 21)).body.state).toBe("ready");
    const r = await done(p, id);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/PR is open/);
    expect((await task(p, id)).state).toBe("ready");
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${id}/prs/21`)).status).toBe(200);
    expect((await done(p, id)).body.state).toBe("done");
  });

  it("a revised worker starts in review (its PR is open), and its exit leaves it there: not stalled, not done by hand", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 29, sha: sha(), action: "opened", ref: `task/${id}`, updated_at: later() }));
    expect((await task(p, id)).state).toBe("in_review");
    await exited(a.assignee);
    expect((await deliverGithub("issue_comment", comment(p, 29, "please fix"))).status).toBe(200);
    await stub(p).drain();
    const t = await task(p, id);
    expect(t.assignee).not.toBe(a.assignee);
    expect(t.state).toBe("in_review");
    await exited(t.assignee);
    const after = await task(p, id);
    expect(after).toMatchObject({ state: "in_review", worker_live: false });
    expect((await done(p, id)).status).toBe(409);
  });

  it("a start that fails for good stalls a task with an open PR, which still isn't done by hand; its merge makes it done", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 22);
    await attach(p, id, 22);
    fake.fail(/^POST \/v1\/agents$/, 403);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body.state).toBe("stalled");
    expect((await done(p, id)).status).toBe(409);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 22, sha: sha(), action: "closed", merged: true, updated_at: later() }));
    expect((await task(p, id)).state).toBe("done");
  });
});

describe("in review with no PR and no worker (B3)", () => {
  it("its only PR closed unmerged after its worker exited: stalled, so it can be reassigned or marked done", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
    gh.pull(p.repo, 23);
    expect((await attach(p, id, 23)).body.state).toBe("in_review");
    await exited(a.assignee);
    expect((await task(p, id)).state).toBe("in_review");
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 23, sha: sha(), action: "closed", merged: false, updated_at: later() }));
    const t = await task(p, id);
    expect(t).toMatchObject({ state: "stalled", prs: [], worker_live: false });
    expect(t.history.at(-1)).toMatchObject({ action: "review_ended" });
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body.state).toBe("in_progress");
  });

  it("the other order, closed before the exit: back in progress, then stalled by the exit", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
    gh.pull(p.repo, 24);
    await attach(p, id, 24);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 24, sha: sha(), action: "closed", merged: false, updated_at: later() }));
    expect((await task(p, id)).state).toBe("in_progress");
    await exited(a.assignee);
    expect((await task(p, id)).state).toBe("stalled");
    expect((await done(p, id)).body.state).toBe("done");
  });
});

describe("comments queued for a worker that doesn't start (B8)", () => {
  it("are dropped (recorded) when the start fails, and never reach the next worker", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 28, { ref: `task/${id}` });
    await attach(p, id, 28);
    fake.fail(/^POST \/v1\/agents$/, 503);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body.state).toBe("assigned");
    expect((await deliverGithub("issue_comment", comment(p, 28, "old ask"))).status).toBe(200);
    expect(await queued(p, id)).toBe(1);
    fake.fail(/^POST \/v1\/agents$/, 403);
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"); });
    await stub(p).drain();
    const t = await task(p, id);
    expect(t.state).toBe("stalled");
    expect(await queued(p, id)).toBe(0);
    expect(t.history.find((h: { action: string }) => h.action === "pr_comment_dropped")).toMatchObject({ detail: expect.stringContaining("didn't start") });
    const again = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
    expect(again.state).toBe("in_review");
    await stub(p).drain();
    expect(fake.inbox.filter((m) => m.agent === again.assignee && m.text.includes("old ask"))).toEqual([]);
  });

  it("are dropped when the starting worker exits before its brief", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 30, { ref: `task/${id}` });
    await attach(p, id, 30);
    // The agent is made, its brief refused for now: it's starting, with an agent.
    fake.fail(/^POST \/v1\/agents\/[^/]+\/inbox$/, 503);
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`)).body;
    expect(a.state).toBe("assigned");
    const agent = (await task(p, id)).assignee as string;
    expect(agent).toBeTruthy();
    await deliverGithub("issue_comment", comment(p, 30, "early ask"));
    expect(await queued(p, id)).toBe(1);
    await exited(agent);
    expect((await task(p, id)).state).toBe("stalled");
    expect(await queued(p, id)).toBe(0);
  });
});

describe("deleting a draft (B4)", () => {
  it("is refused while it holds an open PR: detaching turns its auto-merge off on GitHub, which a delete mustn't do unseen", async () => {
    const p = await newProject();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "d" })).body;
    gh.pull(p.repo, 31);
    await attach(p, t.id, 31);
    const r = await api(token, "DELETE", `/api/projects/${p.id}/tasks/${t.id}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("#31");
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${t.id}/prs/31`)).status).toBe(200);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${t.id}`)).status).toBe(200);
    // The PR is free for another task.
    const other = await readyTask(p);
    expect((await attach(p, other, 31)).status).toBe(200);
  });

  it("takes with it what names it: dependencies both ways (noted on the task that waited), and its issue goes back to triage", async () => {
    const p = await newProject();
    const draft = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "the blocker" })).body.id as string;
    const waiter = await readyTask(p, "waits");
    const first = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "first" })).body.id as string;
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${waiter}/dependencies`, { blocked_by: draft })).status).toBe(200);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${draft}/dependencies`, { blocked_by: first })).status).toBe(200);
    // An issue accepted as this draft.
    await deliverGithub("issues", { action: "opened", sender: { id: 1 }, issue: { number: 9, title: "Bug", body: "b", state: "open", user: { login: "x" }, html_url: `https://github.com/${p.repo}/issues/9` }, repository: { full_name: p.repo } });
    const issue = (await api(token, "GET", `/api/projects/${p.id}/issues`)).body[0];
    const fromIssue = (await api(token, "POST", `/api/projects/${p.id}/issues/9/accept`, { updated_ms: issue.updated_ms })).body.id as string;
    expect((await api(token, "GET", `/api/projects/${p.id}/issues`)).body).toEqual([]);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${draft}`)).status).toBe(200);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${fromIssue}`)).status).toBe(200);
    const w = await task(p, waiter);
    expect(w.blocked_by).toEqual([]);
    expect(w.history.at(-1)).toMatchObject({ action: "dependency_removed" });
    expect(JSON.parse(w.history.at(-1).detail)).toMatchObject({ blocked_by: draft, why: "deleted" });
    expect((await task(p, first)).blocks).toEqual([]);
    const deps = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_deps WHERE task = ? OR blocker = ?", draft, draft).one().n);
    expect(deps).toBe(0);
    expect((await api(token, "GET", `/api/projects/${p.id}/issues`)).body.map((i: { number: number }) => i.number)).toEqual([9]);
  });
});

describe("done through a merged PR, a task made of an issue closes it, by whichever route", () => {
  async function fromIssue(p: P, n: number) {
    gh.issues.set(p.repo, new Map([[n, { title: `Issue ${n}`, body: "", state: "open" as const, login: "a", comments: [] as string[] }]]));
    await deliverGithub("issues", { action: "opened", sender: { id: 1 }, issue: { number: n, title: `Issue ${n}`, body: "b", state: "open", user: { login: "a" }, html_url: `https://github.com/${p.repo}/issues/${n}` }, repository: { full_name: p.repo } });
    const issue = (await api(token, "GET", `/api/projects/${p.id}/issues`)).body[0];
    const id = (await api(token, "POST", `/api/projects/${p.id}/issues/${n}/accept`, { updated_ms: issue.updated_ms })).body.id as string;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${id}/spec`, spec);
    return { id, issue: gh.issues.get(p.repo)!.get(n)! };
  }

  it("the last open PR detached by the owner after another merged: done, and the issue is closed naming the merged PR", async () => {
    const p = await newProject();
    const t = await fromIssue(p, 41);
    gh.pull(p.repo, 141);
    gh.pull(p.repo, 142);
    await attach(p, t.id, 141);
    await attach(p, t.id, 142);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 141, sha: sha(), action: "closed", merged: true, updated_at: later() }));
    expect((await task(p, t.id)).state).toBe("ready");
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${t.id}/prs/142`)).body.state).toBe("done");
    await stub(p).drain();
    expect(t.issue.state).toBe("closed");
    expect(t.issue.comments).toEqual(["Done in #141."]);
    expect((await task(p, t.id)).issue).toMatchObject({ number: 41, close: "closed" });
  });

  it("the last open PR closed unmerged after another merged: the same", async () => {
    const p = await newProject();
    const t = await fromIssue(p, 42);
    gh.pull(p.repo, 143);
    gh.pull(p.repo, 144);
    await attach(p, t.id, 143);
    await attach(p, t.id, 144);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 143, sha: sha(), action: "closed", merged: true, updated_at: later() }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 144, sha: sha(), action: "closed", merged: false, updated_at: later() }));
    expect((await task(p, t.id)).state).toBe("done");
    await stub(p).drain();
    expect(t.issue.state).toBe("closed");
    expect(t.issue.comments).toEqual(["Done in #143."]);
  });

  it("done by hand (no PR merged) leaves the issue to the owner", async () => {
    const p = await newProject();
    const t = await fromIssue(p, 43);
    expect((await done(p, t.id)).body.state).toBe("done");
    await stub(p).drain();
    expect(t.issue.state).toBe("open");
    expect((await task(p, t.id)).issue).toMatchObject({ number: 43, close: null });
  });
});

describe("a late opened for a merged PR (GitHub doesn't order deliveries)", () => {
  it("leaves the PR merged and the task done", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`);
    const s = sha();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 26, sha: s, action: "opened", ref: `task/${id}`, updated_at: later() }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 26, sha: s, action: "closed", merged: true, ref: `task/${id}`, updated_at: later() }));
    expect((await task(p, id)).state).toBe("done");
    // The opening again, as a redelivery under a new id, or a reopened that arrives late.
    for (const action of ["opened", "reopened"] as const) {
      await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 26, sha: s, action, ref: `task/${id}`, title: "Renamed", updated_at: later() }));
    }
    const t = await task(p, id);
    expect(t.state).toBe("done");
    expect(t.prs).toMatchObject([{ number: 26, state: "merged", title: "Renamed" }]);
  });
});

describe("a merged PR's close handled twice", () => {
  it("counts once: only an open PR merges", async () => {
    const p = await newProject();
    const id = await readyTask(p);
    gh.pull(p.repo, 25);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${id}/assign`);
    await attach(p, id, 25);
    const ev = prEvent({ repo: p.repo, number: 25, sha: sha(), action: "closed", merged: true, updated_at: later() });
    await deliverGithub("pull_request", ev);
    await deliverGithub("pull_request", ev);
    const totals = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT prs_merged_total AS prs, tasks_done_total AS tasks FROM settings").one());
    expect(totals).toEqual({ prs: 1, tasks: 1 });
    expect((await task(p, id)).history.filter((h: { action: string }) => h.action === "pr_merged")).toHaveLength(1);
  });
});

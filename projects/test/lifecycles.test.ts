// Lifecycles the state-machine sweep found without a way out or acting twice, against the real DOs and
// the fake nest and GitHub: a PR comment handled again (B6), GitHub's deliveries out of order (B7), a
// project whose create failed half-way (B10), and a manager that ended (B11).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MANAGER_RESTARTS } from "../src/manager";
import { AccessTeam, api, deliver, deliverGithub, FakeNest, installFetch, ownerIdOf, prEvent, shaOf } from "./fake-nest";

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
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
const at = (min: number) => new Date(Date.UTC(2026, 10, 6, 12, min)).toISOString();

async function newProject() {
  const owner = `o-${rand()}`.toLowerCase();
  const repo = `${owner}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, repo, owner, manager: p.settings.manager as string };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const task = async (p: P, id: string) => (await api(token, "GET", `/api/projects/${p.id}/tasks/${id}`)).body;
async function working(p: P) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
  return { id: t.id as string, worker: a.assignee as string };
}
const exited = (agent: string, reason = "exited") => deliver({ id: `evt-${rand()}`, type: "agent.exited", agent, reason });

describe("a PR comment handled again (B6)", () => {
  const comment = (p: P, pr: number, url: string) => ({
    action: "created",
    issue: { number: pr, pull_request: { url: "x" } },
    comment: { id: 7, body: "Rename the flag.", user: { login: p.owner, id: ownerIdOf(p.owner), type: "User" }, performed_via_github_app: null, html_url: url },
    repository: { full_name: p.repo },
  });

  it("reaches a running worker once, though delivered again under a new delivery id", async () => {
    const p = await newProject();
    const t = await working(p);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 70, sha: shaOf("a"), action: "opened", ref: `task/${t.id}` }));
    const url = `https://github.com/${p.repo}/pull/70#issuecomment-${rand()}`;
    for (let i = 0; i < 3; i++) expect((await deliverGithub("issue_comment", comment(p, 70, url))).status).toBe(200);
    await stub(p).drain();
    expect(fake.inbox.filter((m) => m.agent === t.worker && m.text.includes("Rename the flag."))).toHaveLength(1);
    expect((await task(p, t.id)).history.filter((h: { action: string }) => h.action === "pr_comment")).toHaveLength(1);
  });

  it("starts one worker again, not one per copy, and queues the comment once", async () => {
    const p = await newProject();
    const t = await working(p);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 71, sha: shaOf("b"), action: "opened", ref: `task/${t.id}` }));
    await exited(t.worker);
    const url = `https://github.com/${p.repo}/pull/71#issuecomment-${rand()}`;
    await deliverGithub("issue_comment", comment(p, 71, url));
    await deliverGithub("issue_comment", comment(p, 71, url));
    const h = (await task(p, t.id)).history.map((x: { action: string }) => x.action);
    expect(h.filter((a: string) => a === "revise")).toHaveLength(1);
    await stub(p).drain();
    const next = (await task(p, t.id)).assignee as string;
    expect(next).not.toBe(t.worker);
    expect(fake.inbox.filter((m) => m.agent === next && m.text.includes("Rename the flag."))).toHaveLength(1);
  });
});

describe("GitHub's deliveries out of order (B7)", () => {
  it("a merged close delivered before its opened: the late opened attaches nothing, and the task stays in progress", async () => {
    const p = await newProject();
    const t = await working(p);
    const s = shaOf(`c${rand()}`);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 72, sha: s, action: "closed", merged: true, ref: `task/${t.id}`, updated_at: at(10) }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 72, sha: s, action: "opened", ref: `task/${t.id}`, updated_at: at(1) }));
    const after = await task(p, t.id);
    expect(after.state).toBe("in_progress");
    expect(after.prs).toEqual([]);
    // Nor can it be attached by hand: GitHub has said it's merged.
    gh.pull(p.repo, 72, { updated_at: at(1) });
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/prs`, { pr: 72 });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("merged");
  });

  it("an attach that raced the PR's merge (its read older than the close) is refused", async () => {
    const p = await newProject();
    const t = await working(p);
    // GitHub's merge lands while the owner's attach reads the PR, which it read as open, a minute earlier.
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 73, sha: shaOf("d"), action: "closed", merged: true, updated_at: at(20) }));
    gh.pull(p.repo, 73, { updated_at: at(19) });
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/prs`, { pr: 73 })).status).toBe(409);
    // Reopened since (a newer read): attached.
    gh.pull(p.repo, 74, { updated_at: at(5) });
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 74, sha: shaOf("e"), action: "closed", merged: false, updated_at: at(4) }));
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/prs`, { pr: 74 })).status).toBe(200);
  });

  it("an opened as new as a recorded close is stale too (a reopen is its own, newer, event)", async () => {
    const p = await newProject();
    const t = await working(p);
    const s = shaOf(`h${rand()}`);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 76, sha: s, action: "closed", merged: true, ref: `task/${t.id}`, updated_at: at(30) }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 76, sha: s, action: "opened", ref: `task/${t.id}`, updated_at: at(30) }));
    expect((await task(p, t.id)).prs).toEqual([]);
  });

  it("a close older than the reopen already seen changes nothing", async () => {
    const p = await newProject();
    const t = await working(p);
    const s = shaOf(`f${rand()}`);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 75, sha: s, action: "opened", ref: `task/${t.id}`, updated_at: at(1) }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 75, sha: s, action: "reopened", ref: `task/${t.id}`, updated_at: at(3) }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 75, sha: s, action: "closed", merged: false, ref: `task/${t.id}`, updated_at: at(2) }));
    const after = await task(p, t.id);
    expect(after.state).toBe("in_review");
    expect(after.prs).toMatchObject([{ number: 75, state: "open" }]);
  });
});

describe("a project whose create failed half-way (B10)", () => {
  const dir = () => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));

  it("is pending until finished: its routes say so, the alarm finishes it, and then it works", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    // The Worker died after the directory row: nothing past it ran.
    const row = await dir().createProject({ name: "Half", repo }, { name: "Half", repo, max_workers: 3 });
    expect(row.ok && row.value.state).toBe("pending");
    const id = row.ok ? row.value.id : "";
    const r = await api(token, "GET", `/api/projects/${id}`);
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("being created");
    expect((await api(token, "GET", "/api/projects")).body.projects.find((x: { id: string }) => x.id === id)).toMatchObject({ state: "pending" });
    // Its GitHub events reach nothing yet.
    expect(await (await deliverGithub("pull_request", prEvent({ repo, number: 1, sha: shaOf("g"), action: "opened" }))).json()).toEqual({ ignored: "the project is still being created" });
    await runInDurableObject(dir(), (_o, st) => { st.storage.sql.exec("UPDATE projects SET next_ms = 0 WHERE id = ?", id); });
    await runDurableObjectAlarm(dir());
    const done = await api(token, "GET", `/api/projects/${id}`);
    expect(done.status).toBe(200);
    expect(done.body.settings).toMatchObject({ name: "Half", max_workers: 3 });
    expect((await api(token, "GET", "/api/projects")).body.projects.find((x: { id: string }) => x.id === id)).toMatchObject({ state: "ready" });
  });

  it("asked for again while pending, the same project's create is resumed, not refused", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    const row = await dir().createProject({ name: "Again", repo }, { name: "Again", repo });
    const id = row.ok ? row.value.id : "";
    const r = await api(token, "POST", "/api/projects", { name: "Again", repo });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id, state: "ready" });
    expect((await api(token, "GET", `/api/projects/${id}`)).status).toBe(200);
    // Ready, the repo is taken as before.
    expect((await api(token, "POST", "/api/projects", { name: "Third", repo })).status).toBe(409);
  });

  it("one that can't be finished is removed by the alarm, and its repo is free again", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    const row = await dir().createProject({ name: "Broken", repo }, { name: "Broken", repo });
    const id = row.ok ? row.value.id : "";
    await runInDurableObject(dir(), (_o, st) => { st.storage.sql.exec("UPDATE projects SET next_ms = 0, pending = '{not json' WHERE id = ?", id); });
    await runDurableObjectAlarm(dir());
    expect((await api(token, "GET", `/api/projects/${id}`)).status).toBe(404);
    expect((await api(token, "POST", "/api/projects", { name: "Fresh", repo })).status).toBe(201);
  });
});

describe("a manager that ended (B11)", () => {
  const settingsOf = (p: P) => runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT manager, manager_next_ms, manager_error, manager_starts FROM settings").one());
  const startDue = async (p: P) => {
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"); });
    await stub(p).drain();
  };
  const chat = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/chat`)).body as { sender: string; text: string }[]).filter((m) => m.sender === "app").map((m) => m.text);

  it("is replaced: the old one's sandbox goes, a new one starts and gets the owner's messages", async () => {
    const p = await newProject();
    await exited(p.manager);
    const s = await settingsOf(p);
    expect(s.manager).toBeNull();
    expect(s.manager_next_ms).not.toBeNull();
    expect(await chat(p)).toEqual(expect.arrayContaining(["The manager ended (exited).", "A new manager is starting."]));
    await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "Still there?" });
    await startDue(p);
    const next = (await settingsOf(p)).manager as string;
    expect(next).toBeTruthy();
    expect(next).not.toBe(p.manager);
    await stub(p).drain();
    expect(fake.inbox.filter((m) => m.agent === next && m.text === "Still there?")).toHaveLength(1);
    expect(fake.callsTo("POST", new RegExp(`^/v1/agents/${p.manager}/stop$`)).length).toBeGreaterThan(0);
    // An old manager's exit (not the current one) changes nothing.
    await exited(p.manager);
    expect((await settingsOf(p)).manager).toBe(next);
  });

  it(`after ${MANAGER_RESTARTS} automatic restarts in an hour it waits for the owner's Restart, which starts one once`, async () => {
    const p = await newProject();
    let m = p.manager;
    for (let i = 0; i < MANAGER_RESTARTS; i++) {
      await exited(m);
      await startDue(p);
      m = (await settingsOf(p)).manager as string;
      expect(m).toBeTruthy();
    }
    await exited(m);
    const s = await settingsOf(p);
    expect(s).toMatchObject({ manager: null, manager_next_ms: null });
    expect(s.manager_error).toContain("restart it when you're ready");
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "ended", agent: null });
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.manager_start_owed).toBe(false);
    const agents = fake.agents.size;
    // The owner's Restart, asked twice at once: one new manager.
    const [a, b] = await Promise.all([api(token, "POST", `/api/projects/${p.id}/manager/restart`), api(token, "POST", `/api/projects/${p.id}/manager/restart`)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    await stub(p).drain();
    expect((await settingsOf(p)).manager).toBeTruthy();
    expect(fake.agents.size).toBe(agents + 1);
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body.phase).toBe("running");
  });

  it("a brief nest refuses for good (the agent ended under it) is replaced too, not retried forever", async () => {
    const p = await newProject();
    // The next manager is made, its brief refused: nest has ended it.
    fake.fail(/^POST \/v1\/agents\/[^/]+\/inbox$/, 409);
    await api(token, "POST", `/api/projects/${p.id}/manager/restart`);
    const s = await settingsOf(p);
    expect(s.manager).toBeNull();
    expect(s.manager_error).toContain("its brief was refused");
    expect(s.manager_next_ms).not.toBeNull();
    // The next start is a start of its own (its creates' keys), not the refused one's agent again.
    const refused = [...fake.agents.values()].filter((a) => a.labels?.role === "manager" && a.labels?.project === p.id).map((a) => a.agent);
    fake.failures = [];
    await startDue(p);
    const next = (await settingsOf(p)).manager as string;
    expect(next).toBeTruthy();
    expect(refused).not.toContain(next);
  });
});

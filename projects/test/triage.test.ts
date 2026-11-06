// Triage (README.md#triage): the repo's issues come in by GitHub's `issues` events (never a PR's, never
// another repo's), wait untriaged, and the owner accepts one (a draft task, tainted, linked back) or
// declines it; a one-off import brings the open ones; a task made of an issue closes it when it's done
// through a merged PR, and a close GitHub refuses is recorded on the task.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, api, deliverGithub, FakeNest, GRANT_PERMISSIONS, installFetch, prEvent, shaOf } from "./fake-nest";

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

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, repo };
}
type P = Awaited<ReturnType<typeof newProject>>;
const issueEvent = (p: P, action: string, n: number, o: { title?: string; body?: string; login?: string; pr?: boolean; state?: string; repo?: string } = {}) => ({
  action,
  issue: {
    number: n, title: o.title ?? `Issue ${n}`, body: o.body ?? "It breaks.", state: o.state ?? (action === "closed" ? "closed" : "open"), user: { login: o.login ?? "someone" },
    html_url: `https://github.com/${o.repo ?? p.repo}/issues/${n}`, ...(o.pr ? { pull_request: { url: "x" } } : {}),
  },
  repository: { full_name: o.repo ?? p.repo },
});
const queue = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}/issues`)).body as { number: number; title: string; body: string; author: string; url: string }[];
const numbers = async (p: P) => (await queue(p)).map((i) => i.number);

describe("intake", () => {
  it("opened adds, edited updates, closed / deleted / transferred take an untriaged one out, reopened restores it", async () => {
    const p = await newProject();
    for (const n of [1, 2, 3, 4]) expect((await deliverGithub("issues", issueEvent(p, "opened", n))).status).toBe(200);
    expect(await numbers(p)).toEqual([1, 2, 3, 4]);
    await deliverGithub("issues", issueEvent(p, "edited", 1, { title: "Better title", body: "Steps: …" }));
    expect((await queue(p))[0]).toMatchObject({ number: 1, title: "Better title", body: "Steps: …", author: "someone", url: `https://github.com/${p.repo}/issues/1` });
    await deliverGithub("issues", issueEvent(p, "closed", 2));
    await deliverGithub("issues", issueEvent(p, "deleted", 3));
    await deliverGithub("issues", issueEvent(p, "transferred", 4));
    expect(await numbers(p)).toEqual([1]);
    await deliverGithub("issues", issueEvent(p, "reopened", 2));
    expect(await numbers(p)).toEqual([1, 2]);
    // An edit whose opening was missed adds it (open); one on a closed issue doesn't.
    await deliverGithub("issues", issueEvent(p, "edited", 5));
    await deliverGithub("issues", issueEvent(p, "edited", 6, { state: "closed" }));
    expect(await numbers(p)).toEqual([1, 2, 5]);
    // Counted in "Needs you", as one item.
    const attention = (await api(token, "GET", `/api/projects/${p.id}/attention`)).body;
    expect(attention.filter((a: { kind: string }) => a.kind === "triage")).toEqual([expect.objectContaining({ kind: "triage", count: 3 })]);
  });

  it("ignores a PR, another repo's issue (a fork's), and a delivery seen before", async () => {
    const p = await newProject();
    await deliverGithub("issues", issueEvent(p, "opened", 7, { pr: true }));
    await deliverGithub("issues", issueEvent(p, "opened", 8, { repo: `fork-${rand()}/r` }));
    expect(await numbers(p)).toEqual([]);
    const delivery = crypto.randomUUID();
    await deliverGithub("issues", issueEvent(p, "opened", 9), { delivery });
    await deliverGithub("issues", issueEvent(p, "closed", 9));
    // The opening again under its delivery id: deduplicated, so it doesn't come back.
    expect(await (await deliverGithub("issues", issueEvent(p, "opened", 9), { delivery })).json()).toEqual({ duplicate: true });
    expect(await numbers(p)).toEqual([]);
  });

  it("keeps the text as data: what's filed comes back exactly, markup and all, and capped", async () => {
    const p = await newProject();
    const hostile = `<img src=x onerror=alert(1)> <script>x</script> ](javascript:alert(1)) ${"z".repeat(30_000)}`;
    await deliverGithub("issues", issueEvent(p, "opened", 10, { title: "<b>bold</b>", body: hostile }));
    const [i] = await queue(p);
    expect(i!.title).toBe("<b>bold</b>");
    expect(i!.body).toBe(hostile.slice(0, 20_000));
  });
});

describe("the owner's triage", () => {
  it("accept makes a draft task of the issue (tainted, linked back); decline takes it out with a reason; neither twice", async () => {
    const p = await newProject();
    await deliverGithub("issues", issueEvent(p, "opened", 11, { title: "Crash on save", body: "Stack trace…", login: "reporter" }));
    await deliverGithub("issues", issueEvent(p, "opened", 12));
    const t = (await api(token, "POST", `/api/projects/${p.id}/issues/11/accept`)).body;
    expect(t).toMatchObject({ state: "draft", title: "Crash on save", tainted: true });
    expect(t.body).toBe(`Stack trace…\n\nFrom issue #11: https://github.com/${p.repo}/issues/11 (opened by reporter)`);
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/11/accept`)).status).toBe(409);
    const d = await api(token, "POST", `/api/projects/${p.id}/issues/12/decline`, { reason: "Duplicate of #3" });
    expect(d.body).toEqual({ declined: 12 });
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/12/decline`, {})).status).toBe(409);
    expect(await numbers(p)).toEqual([]);
    // Declining doesn't touch GitHub.
    expect(fake.github.calls.filter((c) => c.path.includes(`/issues/12`))).toEqual([]);
    // A closed then reopened accepted issue stays the task's; a declined one reopened comes back.
    await deliverGithub("issues", issueEvent(p, "reopened", 11));
    await deliverGithub("issues", issueEvent(p, "reopened", 12));
    expect(await numbers(p)).toEqual([12]);
  });

  it("import brings the repo's open issues once, PRs left out", async () => {
    const p = await newProject();
    const gh = new Map<number, { title: string; body: string; state: "open" | "closed"; login: string; pr?: boolean; comments: string[] }>();
    fake.github.issues.set(p.repo, gh);
    gh.set(21, { title: "Old bug", body: "b", state: "open", login: "a", comments: [] });
    gh.set(22, { title: "A PR", body: "", state: "open", login: "a", pr: true, comments: [] });
    gh.set(23, { title: "Closed", body: "", state: "closed", login: "a", comments: [] });
    await deliverGithub("issues", issueEvent(p, "opened", 24));
    gh.set(24, { title: "Issue 24", body: "", state: "open", login: "a", comments: [] });
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/import`)).body).toEqual({ imported: 1, known: 1 });
    expect((await numbers(p)).sort()).toEqual([21, 24]);
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/import`)).body).toEqual({ imported: 0, known: 2 });
  });
});

describe("a task made of an issue", () => {
  async function doneTask(p: P, n: number) {
    const gh = new Map([[n, { title: `Issue ${n}`, body: "", state: "open" as const, login: "a", comments: [] as string[] }]]);
    fake.github.issues.set(p.repo, gh);
    await deliverGithub("issues", issueEvent(p, "opened", n));
    const t = (await api(token, "POST", `/api/projects/${p.id}/issues/${n}/accept`)).body;
    const pr = 500 + n;
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: pr, sha: shaOf(`i${n}`), action: "opened", ref: `task/${t.id}` }));
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: pr, sha: shaOf(`i${n}`), action: "closed", merged: true, ref: `task/${t.id}` }));
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    return { task: t.id as string, pr, issue: gh.get(n)! };
  }

  it("closes the issue when it's done through its merged PR, with a line naming the PR", async () => {
    const p = await newProject();
    const d = await doneTask(p, 31);
    const t = (await api(token, "GET", `/api/projects/${p.id}/tasks/${d.task}`)).body;
    expect(t.state).toBe("done");
    expect(d.issue.state).toBe("closed");
    expect(d.issue.comments).toEqual([`Done in #${d.pr}.`]);
    expect(t.history.at(-1)).toMatchObject({ action: "issue_closed" });
  });

  it("a close GitHub refuses for good (no issues: write in the grant) is recorded on the task, not dropped silently", async () => {
    const p = await newProject();
    const saved = GRANT_PERMISSIONS.issues;
    delete GRANT_PERMISSIONS.issues;
    try {
      const d = await doneTask(p, 32);
      expect(d.issue.state).toBe("open");
      const t = (await api(token, "GET", `/api/projects/${p.id}/tasks/${d.task}`)).body;
      const last = t.history.at(-1);
      expect(last.action).toBe("issue_close_failed");
      expect(JSON.parse(last.detail)).toMatchObject({ issue: 32, error: expect.stringContaining("issues") });
    } finally {
      GRANT_PERMISSIONS.issues = saved!;
    }
  });
});

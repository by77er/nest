// GitHub's events reach a project by the repo's id (README.md#built-the-review-pipeline): a repo that's
// renamed or transferred keeps its project, and its old name, taken by another repo, reaches none. A
// project learns the id from the first event that names it, and is found by name until then.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { prCommentOf, sameRepo } from "../src/github-hook";
import { AccessTeam, api, deliverGithub, FakeNest, installFetch } from "./fake-nest";

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
let nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000);

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, repo };
}
type P = Awaited<ReturnType<typeof newProject>>;
const issue = (n: number, repository: Record<string, unknown>) => ({
  action: "opened", sender: { id: 1, login: "x" },
  issue: { number: n, title: `Issue ${n}`, body: "b", state: "open", user: { login: "someone" }, html_url: `https://github.com/x/y/issues/${n}` },
  repository,
});
const numbers = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/issues`)).body as { number: number }[]).map((i) => i.number);
const storedId = (p: P) => runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) =>
  st.storage.sql.exec("SELECT repo_id FROM projects WHERE id = ?", p.id).one().repo_id as number | null);

describe("routing by the repo's id", () => {
  it("a project takes its repo's id from the first event, and keeps its events when the repo is renamed or transferred", async () => {
    const p = await newProject();
    const id = nextId++;
    expect(await storedId(p)).toBeNull();
    await deliverGithub("issues", issue(1, { id, full_name: p.repo }));
    expect(await storedId(p)).toBe(id);
    // Renamed, then transferred to another owner: the id is the same.
    await deliverGithub("issues", issue(2, { id, full_name: `${p.repo}-renamed` }));
    await deliverGithub("issues", issue(3, { id, full_name: `elsewhere-${rand()}/moved` }));
    expect(await numbers(p)).toEqual([1, 2, 3]);
    expect(await storedId(p)).toBe(id);
  });

  it("the old name, taken by another repo, reaches no project; nor does an event that names no id", async () => {
    const p = await newProject();
    const id = nextId++;
    await deliverGithub("issues", issue(1, { id, full_name: p.repo }));
    const other = await deliverGithub("issues", issue(2, { id: nextId++, full_name: p.repo }));
    expect(await other.json()).toEqual({ ignored: "no project for this repo" });
    const unnamed = await deliverGithub("issues", issue(3, { full_name: p.repo }));
    expect(await unnamed.json()).toEqual({ ignored: "no project for this repo" });
    expect(await numbers(p)).toEqual([1]);
    expect(await storedId(p)).toBe(id);
  });

  it("a project with no id yet is found by its name, with or without an id on the event; an id that isn't one is not kept", async () => {
    const p = await newProject();
    await deliverGithub("issues", issue(1, { full_name: p.repo.toUpperCase() }));
    await deliverGithub("issues", issue(2, { id: "12", full_name: p.repo }));
    await deliverGithub("issues", issue(3, { id: -4, full_name: p.repo }));
    expect(await numbers(p)).toEqual([1, 2, 3]);
    expect(await storedId(p)).toBeNull();
  });

  it("one repo's id never moves to another project: a second project's name with the first's id is the first's event", async () => {
    const a = await newProject();
    const b = await newProject();
    const id = nextId++;
    await deliverGithub("issues", issue(1, { id, full_name: a.repo }));
    await deliverGithub("issues", issue(2, { id, full_name: b.repo }));
    expect(await numbers(a)).toEqual([1, 2]);
    expect(await numbers(b)).toEqual([]);
    expect(await storedId(b)).toBeNull();
  });
});

describe("a PR's head is the repo's own by id", () => {
  it("by both ids when the payload has them (a renamed repo is itself; a fork isn't, whatever it's called), else by the project's name", () => {
    expect(sameRepo({ id: 7, full_name: "new/name" }, { id: 7, full_name: "new/name" }, "old/name")).toBe(true);
    expect(sameRepo({ id: 8, full_name: "old/name" }, { id: 7, full_name: "new/name" }, "old/name")).toBe(false);
    expect(sameRepo({ full_name: "Old/Name" }, { id: 7 }, "old/name")).toBe(true);
    expect(sameRepo({ full_name: "fork/name" }, {}, "old/name")).toBe(false);
    expect(sameRepo({ id: 7, full_name: "fork/name" }, { full_name: "old/name" }, "old/name")).toBe(false);
    expect(sameRepo(null, null, "old/name")).toBe(false);
  });

  it("a review comment on a renamed repo's task PR still names its task", () => {
    const payload = (headId: number) => ({
      action: "created",
      comment: { user: { id: 5, login: "owner", type: "User" }, html_url: "https://github.com/new/name/pull/3#discussion_r1", body: "fix" },
      pull_request: { number: 3, head: { ref: "task/tsk_abc123", repo: { id: headId, full_name: "new/name" } } },
      repository: { id: 7, full_name: "new/name" },
    });
    expect(prCommentOf("pull_request_review_comment", payload(7), "old/name")).toMatchObject({ pr: 3, fork: false, headTask: "tsk_abc123" });
    expect(prCommentOf("pull_request_review_comment", payload(8), "old/name")).toMatchObject({ pr: 3, fork: true, headTask: null });
  });
});

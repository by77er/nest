// The owner's comments on a task's PR reach its worker (README.md#pr-comments): GitHub's comment events,
// only the repo owner's, only for a PR a task holds (never a fork's); delivered to a running worker, kept
// for one that's starting, a worker started again when none runs, dropped once the PR is over.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { PR_COMMENT_MAX } from "../src/do/project";
import { ownerComment } from "../src/github-hook";
import { AccessTeam, api, deliver, deliverGithub, FakeNest, installFetch, prEvent, shaOf } from "./fake-nest";

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
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
const OWNER = { login: "the-owner", type: "User" };
let prs = 100;

/** A project, a task with a running worker, and its PR from `task/<id>` (attached by the app). */
async function setup(o: { fork?: boolean } = {}) {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const worker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body.assignee as string;
  const pr = ++prs;
  await deliverGithub("pull_request", prEvent({ repo, number: pr, sha: shaOf(`s${pr}`), action: "opened", ref: `task/${t.id}`, ...(o.fork ? { headRepo: `fork-${rand()}/r` } : {}) }));
  return { project: p.id as string, repo, task: t.id as string, worker, pr };
}
type S = Awaited<ReturnType<typeof setup>>;
const drain = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.project)).drain();
const taskOf = async (s: S) => (await api(token, "GET", `/api/projects/${s.project}/tasks/${s.task}`)).body;
const said = (agent: string) => fake.inbox.filter((m) => m.agent === agent && m.text.startsWith("A PR comment from the owner"));

const issueComment = (s: S, o: { body?: string; user?: object; association?: string; onPr?: boolean; action?: string } = {}) => ({
  action: o.action ?? "created",
  issue: { number: s.pr, ...(o.onPr === false ? {} : { pull_request: { url: `https://api.github.com/repos/${s.repo}/pulls/${s.pr}` } }) },
  comment: { id: 1, body: o.body ?? "Please rename the flag.", user: o.user ?? OWNER, author_association: o.association ?? "OWNER", html_url: `https://github.com/${s.repo}/pull/${s.pr}#issuecomment-${rand()}` },
  repository: { full_name: s.repo },
});
const pullOf = (s: S, headRepo = s.repo) => ({ number: s.pr, head: { ref: `task/${s.task}`, sha: shaOf("x"), repo: { full_name: headRepo } } });

describe("the trust rule", () => {
  it("is the repo's owner, a person: never a member, a collaborator, anyone else, or a bot", () => {
    expect(ownerComment(OWNER, "OWNER")).toBe("the-owner");
    for (const a of ["MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", undefined]) expect(ownerComment(OWNER, a), String(a)).toBeNull();
    expect(ownerComment({ login: "nest-by77er[bot]", type: "Bot" }, "OWNER")).toBeNull();
  });

  it("delivers the owner's comment and nobody else's", async () => {
    const s = await setup();
    for (const [user, association] of [[OWNER, "COLLABORATOR"], [OWNER, "MEMBER"], [{ login: "someone", type: "User" }, "NONE"], [{ login: "app[bot]", type: "Bot" }, "OWNER"]] as const) {
      expect((await deliverGithub("issue_comment", issueComment(s, { user, association }))).status).toBe(200);
    }
    await drain(s);
    expect(said(s.worker)).toEqual([]);
    await deliverGithub("issue_comment", issueComment(s));
    await drain(s);
    expect(said(s.worker)).toHaveLength(1);
  });
});

describe("delivery", () => {
  it("reaches the running worker: framed as the owner's, with the link, the text between rules; once per delivery", async () => {
    const s = await setup();
    const payload = issueComment(s, { body: "Use `--dry-run` here." });
    const delivery = crypto.randomUUID();
    expect((await deliverGithub("issue_comment", payload, { delivery })).status).toBe(200);
    expect(await (await deliverGithub("issue_comment", payload, { delivery })).json()).toEqual({ duplicate: true });
    await drain(s);
    const got = said(s.worker);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toContain(`a comment by the-owner on PR #${s.pr}.`);
    expect(got[0]!.text).toContain(`Link: ${payload.comment.html_url}`);
    expect(got[0]!.text).toContain("-----\nUse `--dry-run` here.\n-----");
    // The owner's words: not relayed (no taint).
    expect(got[0]!.from).toBeUndefined();
    expect((await taskOf(s)).history.at(-1)).toMatchObject({ action: "pr_comment", actor: "app:github" });
  });

  it("a review requesting changes and a review comment on a line arrive; an approval with no text, an edit, and an issue that isn't a PR don't", async () => {
    const s = await setup();
    const review = (state: string, body: string) => ({ action: "submitted", review: { id: 2, body, state, user: OWNER, author_association: "OWNER", html_url: `https://github.com/${s.repo}/pull/${s.pr}#pullrequestreview-${rand()}` }, pull_request: pullOf(s), repository: { full_name: s.repo } });
    await deliverGithub("pull_request_review", review("approved", ""));
    await deliverGithub("issue_comment", issueComment(s, { action: "edited" }));
    await deliverGithub("issue_comment", issueComment(s, { onPr: false }));
    await drain(s);
    expect(said(s.worker)).toEqual([]);
    await deliverGithub("pull_request_review", review("changes_requested", ""));
    await deliverGithub("pull_request_review_comment", {
      action: "created", comment: { id: 3, body: "Off by one.", path: "src/x.ts", line: 12, user: OWNER, author_association: "OWNER", html_url: `https://github.com/${s.repo}/pull/${s.pr}#discussion_r${rand()}` },
      pull_request: pullOf(s), repository: { full_name: s.repo },
    });
    await drain(s);
    const got = said(s.worker).map((m) => m.text);
    expect(got).toHaveLength(2);
    expect(got[0]).toContain("a review requesting changes by the-owner");
    expect(got[0]).toContain("(no text)");
    expect(got[1]).toContain(`a review comment by the-owner on PR #${s.pr} on src/x.ts:12.`);
  });

  it("cuts a long comment, pointing at the link", async () => {
    const s = await setup();
    await deliverGithub("issue_comment", issueComment(s, { body: "y".repeat(PR_COMMENT_MAX + 500) }));
    await drain(s);
    const text = said(s.worker)[0]!.text;
    expect(text).toContain(`${"y".repeat(PR_COMMENT_MAX)}\n… (cut here`);
    expect(text).not.toContain("y".repeat(PR_COMMENT_MAX + 1));
  });

  it("starts a worker again when none runs and the task is open: the comment after its brief", async () => {
    const s = await setup();
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: s.worker, reason: "exited" });
    // Its PR is open: the task stays in review, with no worker.
    expect((await taskOf(s)).state).toBe("in_review");
    await deliverGithub("issue_comment", issueComment(s, { body: "Pick it up again: the CI fails." }));
    await drain(s);
    const t = await taskOf(s);
    expect(t.state).toBe("in_progress");
    expect(t.assignee).not.toBe(s.worker);
    const theirs = fake.inbox.filter((m) => m.agent === t.assignee);
    expect(theirs).toHaveLength(2);
    expect(theirs[1]!.text).toContain("Pick it up again: the CI fails.");
    expect(t.history.some((h: { action: string }) => h.action === "revise")).toBe(true);
    expect(said(s.worker)).toEqual([]);
  });

  it("drops a comment on a merged PR, a fork's PR, or a PR no task holds", async () => {
    const merged = await setup();
    await deliverGithub("pull_request", prEvent({ repo: merged.repo, number: merged.pr, sha: shaOf("m"), action: "closed", merged: true, ref: `task/${merged.task}` }));
    // Its task kept open (another PR of it still open, say): the merged PR's comment is still dropped.
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(merged.project)), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET state = 'in_review' WHERE id = ?", merged.task); });
    await deliverGithub("issue_comment", issueComment(merged));
    await drain(merged);
    expect(said(merged.worker)).toEqual([]);
    const last = (await taskOf(merged)).history.at(-1);
    expect(last.action).toBe("pr_comment_dropped");
    expect(JSON.parse(last.detail).why).toBe("the PR is merged");
    // A fork's PR naming the task's branch: never the task's, whichever event.
    const fork = await setup({ fork: true });
    await deliverGithub("issue_comment", issueComment(fork));
    await deliverGithub("pull_request_review_comment", {
      action: "created", comment: { id: 4, body: "x", path: "a", line: 1, user: OWNER, author_association: "OWNER", html_url: "https://github.com/x" },
      pull_request: pullOf(fork, `fork-${rand()}/r`), repository: { full_name: fork.repo },
    });
    await drain(fork);
    expect(said(fork.worker)).toEqual([]);
    expect((await taskOf(fork)).history.some((h: { action: string }) => h.action === "pr_comment")).toBe(false);
    // A PR of the repo no task holds.
    const other = await setup();
    await deliverGithub("issue_comment", { ...issueComment(other), issue: { number: 9999, pull_request: {} } });
    await drain(other);
    expect(said(other.worker)).toEqual([]);
  });
});

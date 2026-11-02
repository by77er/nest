// Attaching a repo (README.md#flows): the review check made required on the default branch,
// the owner's other protection kept, the manager started only once that's done, and a failure shown and
// retried. Against a fake GitHub (test/fake-nest.ts) that keeps protection in the shape GitHub's GET
// answers it, and writes it from PUT and PATCH bodies as GitHub's docs describe them.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHECK_NAME } from "../src/github";
import { AccessTeam, api, deliverGithub, FakeNest, GH_APP_ID, installFetch, prEvent } from "./fake-nest";

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

async function create(repo: string) {
  const r = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; settings: any };
}
/** Forget the App id a check run told the directory, as before any check run. */
const forgetAppId = () => runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => { st.storage.sql.exec("DELETE FROM sync WHERE k = 'github_app_id'"); });
const managersOf = (id: string) => [...fake.agents.values()].filter((a) => a.labels.project === id && a.labels.role === "manager");
const writes = (repo: string) => gh.calls.filter((c) => c.method !== "GET" && c.path.startsWith(`/repos/${repo}/branches/`));

/** A protected branch as GitHub's GET answers it: required checks from CI's app, reviews, admins, linear history, signatures. */
function protectedBranch() {
  return {
    url: "u",
    required_status_checks: { url: "u", strict: true, contexts: ["ci/build", "lint"], checks: [{ context: "ci/build", app_id: 15368 }, { context: "lint", app_id: null }], contexts_url: "u" },
    enforce_admins: { url: "u", enabled: true },
    required_pull_request_reviews: { url: "u", dismiss_stale_reviews: true, require_code_owner_reviews: true, required_approving_review_count: 2, require_last_push_approval: false },
    required_linear_history: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
    block_creations: { enabled: false }, required_conversation_resolution: { enabled: true }, lock_branch: { enabled: false }, allow_fork_syncing: { enabled: false },
    required_signatures: { url: "u", enabled: true },
  };
}

describe("attaching a repo", () => {
  it("protects an unprotected default branch minimally: the review check alone, not strict, nothing else", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    gh.repo(repo).default_branch = "trunk";
    const p = await create(repo);
    expect(p.settings).toMatchObject({ attached: true, attach_error: null, attach: { branch: "trunk", change: "created", app_id: GH_APP_ID } });
    const prot = gh.repo(repo).protection!;
    expect(prot.required_status_checks).toMatchObject({ strict: false, checks: [{ context: CHECK_NAME, app_id: GH_APP_ID }] });
    expect(prot.enforce_admins.enabled).toBe(false);
    expect(prot.required_pull_request_reviews).toBeUndefined();
    expect(prot.restrictions).toBeUndefined();
    expect(managersOf(p.id)).toHaveLength(1);
    // Its token: administration and metadata, nothing more.
    const minted = fake.calls.filter((c) => c.path === "/v1/clients/self/github-token" && c.body.repo.toLowerCase() === repo.toLowerCase());
    expect(minted.map((c) => c.body.permissions)).toEqual([{ administration: "write", metadata: "read" }]);
  });

  it("adds the check to existing required checks once, keeping every other setting", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    gh.repo(repo).protection = protectedBranch();
    const p = await create(repo);
    expect(p.settings.attach).toMatchObject({ branch: "main", change: "added" });
    const want = protectedBranch();
    const have = gh.repo(repo).protection!;
    expect(have.required_status_checks.checks).toEqual([...want.required_status_checks.checks, { context: CHECK_NAME, app_id: GH_APP_ID }]);
    expect(have.required_status_checks.strict).toBe(true);
    expect({ ...have, required_status_checks: undefined }).toEqual({ ...want, required_status_checks: undefined });
    expect(writes(repo.toLowerCase()).map((c) => `${c.method} ${c.path.split("/protection")[1]}`)).toEqual(["PATCH /required_status_checks"]);
    // Again: nothing written.
    const again = await api(token, "POST", `/api/projects/${p.id}/attach`);
    expect(again.body.attach.change).toBe("unchanged");
    expect(writes(repo.toLowerCase())).toHaveLength(1);
    expect(gh.repo(repo).protection!.required_status_checks.checks.filter((c: { context: string }) => c.context === CHECK_NAME)).toHaveLength(1);
  });

  it("adds required checks to a branch protected without them, writing the rest back as it was", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    const before = { ...protectedBranch(), required_status_checks: undefined };
    gh.repo(repo).protection = structuredClone(before);
    const p = await create(repo);
    expect(p.settings.attach.change).toBe("added");
    const have = gh.repo(repo).protection!;
    expect(have.required_status_checks).toMatchObject({ strict: false, checks: [{ context: CHECK_NAME, app_id: GH_APP_ID }] });
    expect({ ...have, required_status_checks: undefined }).toEqual(before);
  });

  it("pins the check to the App from the first attach, by the id nest's token answer names", async () => {
    // No check run has told the id (none of the app's has run).
    await forgetAppId();
    const repo = `o-${rand()}/r-${rand()}`;
    gh.repo(repo).protection = protectedBranch();
    const p = await create(repo);
    expect(p.settings.attach).toMatchObject({ change: "added", app_id: GH_APP_ID });
    // In one write: the check required from the App, never from any source first.
    const patches = writes(repo.toLowerCase());
    expect(patches.map((c) => c.body)).toEqual([{ checks: [{ context: "ci/build", app_id: 15368 }, { context: "lint", app_id: -1 }, { context: CHECK_NAME, app_id: GH_APP_ID }] }]);
  });

  it("without the App's id in nest's answer, requires the check from any source, then pins it once a check run tells the id", async () => {
    fake.githubApp = null;
    try {
      await forgetAppId();
      const repo = `o-${rand()}/r-${rand()}`;
      gh.repo(repo).protection = protectedBranch();
      const p = await create(repo);
      expect(p.settings.attach.app_id).toBeNull();
      expect(gh.repo(repo).protection!.required_status_checks.checks.at(-1)).toEqual({ context: CHECK_NAME, app_id: null });
      await deliverGithub("pull_request", prEvent({ repo, number: 1, sha: sha(), action: "opened" }));
      await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
      await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
      const s = (await api(token, "GET", `/api/projects/${p.id}/settings`)).body;
      expect(s.attach).toMatchObject({ change: "pinned", app_id: GH_APP_ID });
      const checks = gh.repo(repo).protection!.required_status_checks.checks;
      expect(checks).toEqual([{ context: "ci/build", app_id: 15368 }, { context: "lint", app_id: null }, { context: CHECK_NAME, app_id: GH_APP_ID }]);
    } finally {
      fake.githubApp = { app_id: GH_APP_ID, app_slug: "nest-test" };
    }
  });

  it("a refusal is shown, the manager waits, and the owner's retry attaches and starts it", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    gh.fail(/^PUT \/repos\/.*\/protection$/, 403, { message: "Resource not accessible by integration" });
    const p = await create(repo);
    expect(p.settings).toMatchObject({ attached: false, manager: null });
    expect(p.settings.attach_error).toMatch(/GitHub 403: Resource not accessible by integration/);
    expect(managersOf(p.id)).toHaveLength(0);
    // A refusal that will repeat isn't retried by itself.
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    expect(await runInDurableObject(stub, (_o, st) => st.storage.sql.exec("SELECT attach_next_ms AS n FROM settings").one().n)).toBeNull();
    // Nor does the manager's start run meanwhile.
    await stub.drain();
    expect(managersOf(p.id)).toHaveLength(0);
    const r = await api(token, "POST", `/api/projects/${p.id}/attach`);
    expect(r.body).toMatchObject({ attached: true, attach_error: null, attach: { change: "created" } });
    expect(r.body.manager).toMatch(/^agt_/);
    expect(managersOf(p.id)).toHaveLength(1);
  });

  it("a failure for now is retried from the alarm, twice", async () => {
    const repo = `o-${rand()}/r-${rand()}`;
    gh.fail(/^GET \/repos\/[^/]+\/[^/]+$/, 502, { times: 2 });
    const p = await create(repo);
    expect(p.settings.attach_error).toMatch(/502/);
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("UPDATE settings SET attach_next_ms = 0 WHERE attach_next_ms IS NOT NULL"); });
      await stub.drain();
    }
    const s = (await api(token, "GET", `/api/projects/${p.id}/settings`)).body;
    expect(s).toMatchObject({ attached: true, attach_error: null });
    expect(s.manager).toMatch(/^agt_/);
  });
});

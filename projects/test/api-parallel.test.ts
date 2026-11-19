// The polled read routes (src/api.ts): the project, its "Needs you" and the projects list ask DirectoryDO,
// ProjectDO, ReviewDO and nest in parallel where one read doesn't need another's answer, and answer exactly
// what they answered when they asked one after another. The oracle for "exactly" is the routes' composition
// as it was (each read awaited in turn, below), over the same objects, compared byte for byte.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { handleApi } from "../src/api";
import type { Env } from "../src/env";
import { clientIdOf, nestFrom } from "../src/nest";
import { DirectoryDO } from "../src/do/directory";
import { ProjectDO } from "../src/do/project";
import { ReviewDO } from "../src/do/review";
import { AccessTeam, api, APP, FakeNest, holdAsk, installFetch, NEST } from "./fake-nest";

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
afterEach(() => {
  fake.failures.length = 0;
  fake.github.failures.length = 0;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const E = env as unknown as Env;
const dir = () => E.DIRECTORY.get(E.DIRECTORY.idFromName("directory"));
const prj = (id: string) => E.PROJECT.get(E.PROJECT.idFromName(id));
const rev = (id: string) => E.REVIEW.get(E.REVIEW.idFromName(id));

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`;
  const r = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, manager: r.body.settings.manager as string };
}

/**
 * A project with something of every kind in "Needs you": a held review, a review backlog (a PR's head that got
 * no job), a blocked task, and an open ask of its manager in nest.
 */
async function seeded() {
  const p = await newProject();
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "blocked one" })).body as { id: string };
  await runInDurableObject(prj(p.id), async (_o, state) => {
    state.storage.sql.exec("UPDATE tasks SET blocked_ms = 1500, blocked_by = ?, blocked_role = 'manager', blocked_reason = 'which way?' WHERE id = ?", p.manager, t.id);
  });
  await runInDurableObject(rev(p.id), async (_o, state) => {
    const sql = state.storage.sql;
    sql.exec(
      "INSERT INTO jobs (pr, sha, state, title, base, author, author_id, fork, needs_approval, next_ms, created_ms, updated_ms) VALUES (7, ?, 'held', 'from a fork', 'main', 'stranger', 99, 1, 1, NULL, 1200, 1200)",
      "a".repeat(40),
    );
    sql.exec("INSERT INTO prs (pr, sha, base, title, updated_at, open, author, author_id, fork, skipped_ms) VALUES (9, ?, 'main', 'skipped', '2026-01-01T00:00:00Z', 1, 'other', 98, 1, 1800)", "b".repeat(40));
  });
  holdAsk(p.manager, `ask_${rand()}`, { question: "ok?", created_ms: 1000 });
  return p;
}

/** Run `body` with methods of a Durable Object class replaced (RPC sees only the prototype's), restored after. */
async function patched<T>(cls: { prototype: object }, methods: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
  const proto = cls.prototype as Record<string, unknown>;
  const had = Object.fromEntries(Object.keys(methods).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
  Object.assign(proto, methods);
  try {
    return await body();
  } finally {
    for (const [k, d] of Object.entries(had)) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}

// --- the routes as they were composed: every read awaited in turn ----------------------------------------

async function reviewItemsBefore(id: string) {
  const held = (await rev(id).held()).map((j) => ({ kind: "review" as const, pr: j.pr, sha: j.sha, title: j.title, author: j.author, fork: j.fork, at_ms: j.created_ms }));
  const skipped = await rev(id).skipped();
  const backlog = skipped.count ? [{ kind: "review_backlog" as const, count: skipped.count, at_ms: skipped.at_ms ?? Date.now() }] : [];
  return [...held, ...backlog];
}

async function attentionBefore(id: string) {
  const a = (await prj(id).attention()) as { ok: true; value: { kind: string; at_ms: number }[] } | { ok: false; status: number; error: string };
  if (!a.ok) return { status: a.status, body: JSON.stringify({ error: a.error }) };
  return { status: 200, body: JSON.stringify([...a.value, ...(await reviewItemsBefore(id))].sort((x, y) => x.at_ms - y.at_ms)) };
}

async function projectsBefore() {
  const rows = await dir().projects();
  let asks: Map<string, number> | null = new Map();
  if (rows.some((r) => r.state === "ready")) {
    try {
      const me = clientIdOf(E.NEST_CLIENT_TOKEN);
      for (const a of await nestFrom(E)!.openAsks({})) if (a.owner === me && a.labels.project) asks.set(a.labels.project, (asks.get(a.labels.project) ?? 0) + 1);
    } catch {
      asks = null;
    }
  }
  return JSON.stringify({ projects: await Promise.all(rows.map(async (r) => {
    if (r.state !== "ready") return { ...r, needs_you: 0 };
    const local = (await prj(r.id).localAttention()) as { ok: boolean; value?: unknown[] };
    const own = (local.ok ? local.value!.length : 0) + (await reviewItemsBefore(r.id)).length;
    return { ...r, needs_you: asks === null ? null : own + (asks.get(r.id) ?? 0) };
  })) });
}

/** The project route's answer, but for `repo_owner` (GitHub's, read through; compared from the route's own answer). */
async function projectBefore(id: string, repoOwner: unknown) {
  const row = await dir().getProject(id);
  await prj(id).refreshRepoAutoMerge();
  const s = (await prj(id).getSettings()) as { ok: true; value: Record<string, unknown> };
  const b = (await dir().binding(id))!;
  return JSON.stringify({ ...row, settings: { ...s.value, repo: b.repo, repo_owner: repoOwner, max_concurrent_reviews: await rev(id).maxConcurrent(), untrusted_reviews: await rev(id).untrustedPolicy() } });
}

const raw = async (path: string) => {
  const res = await handleApi(new Request(`${APP}${path}`), E, new URL(`${APP}${path}`));
  return { status: res.status, body: await res.text() };
};

describe("the polled read routes answer as they did", () => {
  it("the project, its Needs you and the projects list: the same bytes, for a project with a held review, a backlog, a blocked task and an ask", async () => {
    const p = await seeded();
    const other = await newProject();

    const a = await raw(`/api/projects/${p.id}/attention`);
    expect(a).toEqual(await attentionBefore(p.id));
    // Every kind is there, oldest first.
    expect((JSON.parse(a.body) as { kind: string }[]).map((x) => x.kind)).toEqual(["ask", "review", "blocked", "review_backlog"]);
    expect(await raw(`/api/projects/${other.id}/attention`)).toEqual(await attentionBefore(other.id));

    const one = await raw(`/api/projects/${p.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toBe(await projectBefore(p.id, JSON.parse(one.body).settings.repo_owner));

    const list = await raw("/api/projects");
    expect(list.status).toBe(200);
    expect(list.body).toBe(await projectsBefore());
    expect((JSON.parse(list.body).projects as { id: string; needs_you: number }[]).find((x) => x.id === p.id)!.needs_you).toBe(4);
  });

  it("nest's asks unreadable: Needs you lists the rest with the marker, and the list's counts are null, as before", async () => {
    const p = await seeded();
    fake.fail(/^GET \/v1\/asks$/, 503, { times: 1_000 });
    const a = await raw(`/api/projects/${p.id}/attention`);
    expect(a).toEqual(await attentionBefore(p.id));
    expect(JSON.parse(a.body)[0].kind).toBe("asks_unavailable");
    const list = await raw("/api/projects");
    expect(list.body).toBe(await projectsBefore());
    expect((JSON.parse(list.body).projects as { id: string; needs_you: number | null }[]).find((x) => x.id === p.id)!.needs_you).toBeNull();
  });

  it("an unknown project is 404 on every one, and nothing but the directory's row is read", async () => {
    const t = traced();
    for (const page of ["", "/attention", "/attention?local=1", "/settings", "/secrets", "/network"]) {
      const r = await t.ask(`/api/projects/prj_nosuch${page}`, 404);
      expect(r.body).toBe(JSON.stringify({ error: "unknown project" }));
      expect(r.trips, page).toEqual(["directory.getProject"]);
    }
  });

  it("each page's earlier refusal is still its answer whatever fails beside it, and a later read's failure still fails it", async () => {
    const p = await newProject();
    const refused = async () => ({ ok: false, status: 409, error: "refused here" });
    const down = (what: string) => async () => { throw new Error(`${what} down`); };
    const refusal = { status: 409, body: JSON.stringify({ error: "refused here" }) };
    // Whichever of ReviewDO's settings reads this release asks.
    const reviewSettings = { reviewSettings: down("review"), maxConcurrent: down("review"), untrustedPolicy: down("review") };
    const fails = (path: string, what: string) => expect(Promise.resolve().then(() => raw(path))).rejects.toThrow(`${what} down`);

    // The project and its settings: ProjectDO's refusal, then the binding's failure, then ReviewDO's.
    await patched(ProjectDO, { getSettings: refused, settingsLookedAt: refused, refreshRepoAutoMerge: async () => {} }, () =>
      patched(DirectoryDO, { binding: down("directory") }, () => patched(ReviewDO, reviewSettings, async () => {
        expect(await raw(`/api/projects/${p.id}`)).toEqual(refusal);
        expect(await raw(`/api/projects/${p.id}/settings`)).toEqual(refusal);
      })));
    await patched(DirectoryDO, { binding: down("directory") }, () => patched(ReviewDO, reviewSettings, async () => {
      await fails(`/api/projects/${p.id}`, "directory");
      await fails(`/api/projects/${p.id}/settings`, "directory");
    }));
    await patched(ReviewDO, reviewSettings, async () => {
      await fails(`/api/projects/${p.id}`, "review");
      await fails(`/api/projects/${p.id}/settings`, "review");
    });

    // Secrets: ProjectDO's refusal of its secrets, though nest's secrets and the workflow facts fail beside it.
    fake.fail(/^GET \/v1\/clients\/self\/secrets$/, 503, { times: 10 });
    await patched(ProjectDO, { secrets: refused, workflowWorkers: down("project"), workflowsRefused: down("project") }, async () => {
      expect(await raw(`/api/projects/${p.id}/secrets`)).toEqual(refusal);
    });
    await patched(ProjectDO, { workflowsRefused: down("project") }, () => fails(`/api/projects/${p.id}/secrets`, "project"));

    // Network: the rules' refusal, though the grant and the manager's sandbox fail beside them.
    fake.fail(/^GET \/v1\/clients\/self$/, 503, { times: 10 });
    await patched(ProjectDO, { network: refused, managerSandbox: down("project") }, async () => {
      expect(await raw(`/api/projects/${p.id}/network`)).toEqual(refusal);
    });
    await patched(ProjectDO, { managerSandbox: down("project") }, () => fails(`/api/projects/${p.id}/network`, "project"));
    fake.failures.length = 0;

    // The repos: GitHub's failure is the 502, though the directory fails beside it; the directory's alone is one too.
    await patched(DirectoryDO, { projects: down("directory") }, async () => {
      fake.github.fail(/^GET \/app\/installations$/, 502, { times: 10 });
      const r = await raw("/api/repos");
      expect(r.status).toBe(502);
      expect(JSON.parse(r.body).error).toMatch(/^GitHub couldn't say which repos the app's GitHub App reaches: (?!directory down).+/);
      fake.github.failures.length = 0;
      expect(await raw("/api/repos")).toEqual({ status: 502, body: JSON.stringify({ error: "GitHub couldn't say which repos the app's GitHub App reaches: directory down" }) });
    });
  });

  it("ProjectDO's attention refused: that refusal is the answer, though ReviewDO fails too; ReviewDO failing alone still fails the route", async () => {
    const p = await newProject();
    const proto = ProjectDO.prototype as unknown as Record<string, unknown>;
    const rproto = ReviewDO.prototype as unknown as Record<string, unknown>;
    // ReviewDO's reads for Needs you, whichever this release asks.
    const names = ["held", "needsYou"].filter((k) => typeof rproto[k] === "function");
    const had = { attention: proto.attention, ...Object.fromEntries(names.map((k) => [k, rproto[k]])) };
    try {
      for (const k of names) rproto[k] = async () => { throw new Error("review store down"); };
      await expect(Promise.resolve().then(() => raw(`/api/projects/${p.id}/attention`))).rejects.toThrow("review store down");
      proto.attention = async () => ({ ok: false, status: 409, error: "refused here" });
      expect(await raw(`/api/projects/${p.id}/attention`)).toEqual({ status: 409, body: JSON.stringify({ error: "refused here" }) });
    } finally {
      proto.attention = had.attention;
      for (const k of names) rproto[k] = (had as Record<string, unknown>)[k];
    }
  });
});

// --- round trips in sequence ----------------------------------------------------------------------------

/** nest as the Worker's own client reaches it in these tests: told apart from the objects' calls, which go to NEST. */
const WORKER_NEST = "https://nest-from-worker.test";

interface Trip { name: string; start: number; end: number | null }

/**
 * The Worker's env with every Durable Object call and every call to nest recorded where the Worker makes it: its
 * start when called, its end when it settles (a logical clock, no wall time). The depth is the longest chain of
 * calls each started after the one before it ended: the round trips the route waits on one after another.
 */
function traced() {
  const trips: Trip[] = [];
  let tick = 0;
  const track = (name: string, run: () => unknown): Promise<unknown> => {
    const t: Trip = { name, start: tick++, end: null };
    trips.push(t);
    const p = Promise.resolve(run());
    p.then(() => { t.end = tick++; }, () => { t.end = tick++; });
    return p;
  };
  const ns = (real: DurableObjectNamespace, label: string) => ({
    idFromName: (n: string) => real.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = real.get(id) as unknown as Record<string, (...a: unknown[]) => unknown>;
      return new Proxy({}, { get: (_t, k) => (typeof k === "string" && k !== "then" ? (...a: unknown[]) => track(`${label}.${k}`, () => stub[k]!(...a)) : undefined) });
    },
  });
  const traced = {
    ...E, NEST_CONTROL_PLANE: WORKER_NEST,
    DIRECTORY: ns(E.DIRECTORY as unknown as DurableObjectNamespace, "directory"),
    PROJECT: ns(E.PROJECT as unknown as DurableObjectNamespace, "project"),
    REVIEW: ns(E.REVIEW as unknown as DurableObjectNamespace, "review"),
  } as unknown as Env;
  const depth = () => {
    const d = new Map<Trip, number>();
    for (const t of trips) d.set(t, 1 + Math.max(0, ...trips.filter((x) => x.end !== null && x.end < t.start).map((x) => d.get(x)!)));
    return Math.max(0, ...d.values());
  };
  const ask = async (path: string, status = 200) => {
    trips.length = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      const u = new URL(req.url);
      if (u.origin !== WORKER_NEST) return inner(req);
      return track(`nest ${req.method} ${u.pathname}`, () => inner(new Request(`${NEST}${u.pathname}${u.search}`, req)));
    }) as typeof fetch;
    try {
      const res = await handleApi(new Request(`${APP}${path}`), traced, new URL(`${APP}${path}`));
      expect(res.status, await res.clone().text()).toBe(status);
      return { depth: depth(), trips: trips.map((t) => t.name), body: await res.text() };
    } finally {
      globalThis.fetch = inner;
    }
  };
  return { ask };
}

describe("the polled read routes wait on fewer round trips in a row", () => {
  // Before this change: the project 6 (getProject, refreshRepoAutoMerge, getSettings, binding, maxConcurrent,
  // untrustedPolicy), its Needs you 4 (getProject, attention, held, skipped), the list 5 (projects, nest's
  // asks, then each project's localAttention, held, skipped).
  it("the project: 2 (its row, then its settings, binding and review settings together)", async () => {
    const p = await seeded();
    const t = traced();
    // GitHub isn't traced: its owner read, kept a minute per Worker instance, adds one round trip on a miss, as before.
    const r = await t.ask(`/api/projects/${p.id}`);
    expect(r.body).toBe(await projectBefore(p.id, JSON.parse(r.body).settings.repo_owner));
    expect(r.depth, r.trips.join(", ")).toBe(2);
  });

  it("its Needs you: 2 (its row, then ProjectDO's and ReviewDO's items together)", async () => {
    const p = await seeded();
    const r = await traced().ask(`/api/projects/${p.id}/attention`);
    expect(r.body).toBe((await attentionBefore(p.id)).body);
    expect(r.depth, r.trips.join(", ")).toBe(2);
    expect(r.trips.filter((n) => n.startsWith("review."))).toHaveLength(1);
  });

  it("the projects list, of three or more: 2 (the rows, then nest's asks and every project's items together)", async () => {
    await seeded();
    await seeded();
    await seeded();
    const r = await traced().ask("/api/projects");
    expect(JSON.parse(r.body).projects.length).toBeGreaterThanOrEqual(3);
    expect(r.body).toBe(await projectsBefore());
    expect(r.depth, r.trips.join(", ")).toBe(2);
  });
});

describe("the project's other pages' reads wait on fewer round trips in a row", () => {
  // Before: settings 5 (getProject, getSettings, binding, maxConcurrent, untrustedPolicy), secrets 5 (getProject,
  // then four together, then nest's secrets, workflowWorkers, workflowsRefused), network 3 (getProject, network,
  // then the grant and the manager's sandbox together; its sandbox's policy after, when it has one), Needs you's
  // local items 4 (getProject, localAttention, held, skipped).
  it("settings, secrets, network and Needs you's local items: 2 each", async () => {
    const p = await seeded();
    const t = traced();
    for (const page of ["settings", "secrets", "network", "attention?local=1"]) {
      const r = await t.ask(`/api/projects/${p.id}/${page}`);
      expect(r.depth, `${page}: ${r.trips.join(", ")}`).toBe(2);
    }
  });
});

// The models a project's manager and workers run on (README.md#models): the defaults, the owner's choice
// in Settings, and how it reaches nest: a template of the project's own with `launch.model`, named for
// the role and the model, which each start names (frozen with the attempt, so a change applies to the
// next start).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { roleTemplate, TEMPLATE } from "../src/catalog";
import { DEFAULT_MODEL, MODELS, modelLabel, modelProblem, modelTemplateEntry } from "../src/models";
import { AccessTeam, api, deliver, FakeNest, installFetch } from "./fake-nest";

describe("model ids", () => {
  it("the defaults are the owner's: the manager on Fable 5.2, workers on Opus 5.5, both among the listed ones", () => {
    expect(DEFAULT_MODEL).toEqual({ manager: "claude-fable-5-2", worker: "claude-opus-5-5" });
    expect(MODELS.map((m) => m.id)).toEqual(["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(modelLabel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelLabel("my-own")).toBe("my-own");
  });

  it("takes what Claude Code's --model takes, and nothing that could read as an option or carry a space", () => {
    for (const ok of ["claude-opus-5-5", "opus", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-4-5@20251101"]) expect(modelProblem(ok), ok).toBeNull();
    for (const bad of ["", "-p", "--dangerously-skip-permissions", "a b", "a\nb", "a;b", "$(x)", "x".repeat(101)]) expect(modelProblem(bad), JSON.stringify(bad)).not.toBeNull();
  });

  it("names a template per project, role and model, within nest's entry names, never one for two ids", () => {
    expect(modelTemplateEntry("worker", "prj_abc123", "claude-opus-5-5")).toBe("worker-abc123-claude-opus-5-5");
    expect(modelTemplateEntry("manager", "prj_abc123", "claude-fable-5-2")).toBe("manager-abc123-claude-fable-5-2");
    const ids = ["claude-opus-5-5", "Claude-Opus-5-5", "claude.opus.5.5", "claude-opus-5-5[1m]", "claude_opus_5_5", "x".repeat(100), `${"x".repeat(99)}y`, "opus"];
    const names = ids.flatMap((m) => (["manager", "worker"] as const).map((r) => modelTemplateEntry(r, "prj_0123456789abcdef", m)));
    for (const n of names) expect(n, n).toMatch(/^[a-z][a-z0-9-]{0,62}$/);
    expect(new Set(names).size).toBe(names.length);
    // A plain id can't be chosen to take a hashed id's entry: hashed ones end `--<hash>`, plain ones never hold `--`.
    const hashed = modelTemplateEntry("worker", "prj_abc123", "Foo");
    expect(hashed).toMatch(/^worker-abc123-foo--[0-9a-f]{8}$/);
    const lookalike = hashed.replace("worker-abc123-", "");
    expect(modelTemplateEntry("worker", "prj_abc123", lookalike)).not.toBe(hashed);
    expect(modelTemplateEntry("worker", "prj_abc123", lookalike.replace("--", "-"))).not.toBe(hashed);
    // Another project's are its own.
    expect(modelTemplateEntry("worker", "prj_other", "opus")).not.toBe(modelTemplateEntry("worker", "prj_abc123", "opus"));
  });

  it("a role's template carries the model as launch.model and reaches only its project's repo", () => {
    const w = roleTemplate("worker", "prj_abc123", "Owner/Repo", "claude-haiku-5-5");
    expect(w.name).toBe("projects/worker-abc123-claude-haiku-5-5");
    expect(w.body).toMatchObject({ launch: { model: "claude-haiku-5-5" }, repos: ["owner/repo"] });
    const m = roleTemplate("manager", "prj_abc123", "owner/repo", "claude-fable-5-2");
    expect(m.body).toMatchObject({ launch: { model: "claude-fable-5-2" }, read_repos: ["owner/repo"] });
    expect((m.body as { repos?: unknown }).repos).toBeUndefined();
  });
});

describe("a project's models", () => {
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
    return { id: p.id as string, repo, manager: p.settings.manager as string, settings: p.settings };
  }
  type P = Awaited<ReturnType<typeof newProject>>;
  const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
  const entry = (p: P, role: "manager" | "worker", model: string) => `projects/${modelTemplateEntry(role, p.id, model)}`;
  const written = (name: string) => fake.catalog.get(`templates/${name}`) as { launch: { model?: string }; repos?: string[]; read_repos?: string[] } | undefined;
  async function assign(p: P, title = "t") {
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    return (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body as { id: string; assignee: string; state: string };
  }

  it("by default the manager starts on Fable 5.2 and a worker on Opus 5.5, each from the project's own template", async () => {
    const p = await newProject();
    expect(p.settings).toMatchObject({ manager_model: "claude-fable-5-2", worker_model: "claude-opus-5-5" });
    const m = entry(p, "manager", "claude-fable-5-2");
    expect(fake.agents.get(p.manager)!.template).toBe(m);
    expect(written(m)).toMatchObject({ launch: { model: "claude-fable-5-2" }, read_repos: [p.repo] });
    const w = await assign(p);
    const wt = entry(p, "worker", "claude-opus-5-5");
    expect(fake.agents.get(w.assignee)!.template).toBe(wt);
    expect(written(wt)).toMatchObject({ launch: { model: "claude-opus-5-5" }, repos: [p.repo] });
  });

  it("the owner's choice applies to the next start: workers started after it, and the manager once restarted", async () => {
    const p = await newProject();
    const first = await assign(p, "first");
    const r = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-haiku-5-5", manager_model: "claude-opus-5-5[1m]" });
    expect(r.body).toMatchObject({ worker_model: "claude-haiku-5-5", manager_model: "claude-opus-5-5[1m]" });
    // Running ones keep theirs.
    expect(fake.agents.get(first.assignee)!.template).toBe(entry(p, "worker", "claude-opus-5-5"));
    expect(fake.agents.get(p.manager)!.template).toBe(entry(p, "manager", "claude-fable-5-2"));
    const second = await assign(p, "second");
    const wt = entry(p, "worker", "claude-haiku-5-5");
    expect(fake.agents.get(second.assignee)!.template).toBe(wt);
    expect(written(wt)!.launch.model).toBe("claude-haiku-5-5");
    // A custom id: its template's name is a legal entry, its model the id as typed.
    await api(token, "POST", `/api/projects/${p.id}/manager/restart`);
    await stub(p).drain();
    const next = (await api(token, "GET", `/api/projects/${p.id}`)).body.settings.manager as string;
    expect(next).not.toBe(p.manager);
    const mt = fake.agents.get(next)!.template as string;
    expect(mt).toBe(entry(p, "manager", "claude-opus-5-5[1m]"));
    expect(mt).toMatch(/^projects\/[a-z][a-z0-9-]{0,62}$/);
    expect(written(mt)!.launch.model).toBe("claude-opus-5-5[1m]");
  });

  it("a start in flight keeps the model it froze, though the setting changes before its retry", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    const w = await assign(p);
    expect(w.state).toBe("assigned");
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-sonnet-5-5" });
    fake.failures = [];
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"); });
    await stub(p).drain();
    const t = (await api(token, "GET", `/api/projects/${p.id}/tasks/${w.id}`)).body;
    expect(t.state).toBe("in_progress");
    expect(fake.agents.get(t.assignee)!.template).toBe(entry(p, "worker", "claude-opus-5-5"));
  });

  it("a start frozen before models were chosen keeps the role's shared template", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    const w = await assign(p);
    // As the release before froze it: no model.
    await runInDurableObject(stub(p), (_o, st) => {
      for (const r of st.storage.sql.exec<{ key: string; spec: string }>("SELECT key, spec FROM start_specs").toArray()) {
        const { model: _m, ...spec } = JSON.parse(r.spec);
        st.storage.sql.exec("UPDATE start_specs SET spec = ? WHERE key = ?", JSON.stringify(spec), r.key);
      }
      st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL");
    });
    fake.failures = [];
    await stub(p).drain();
    const t = (await api(token, "GET", `/api/projects/${p.id}/tasks/${w.id}`)).body;
    expect(fake.agents.get(t.assignee)!.template).toBe(TEMPLATE.worker);
  });

  it("a model's template goes from nest's catalog once no start uses it: not the setting, no live agent started from it", async () => {
    const p = await newProject();
    const first = await assign(p, "first");
    const opus = `templates/${entry(p, "worker", "claude-opus-5-5")}`;
    const haiku = `templates/${entry(p, "worker", "claude-haiku-5-5")}`;
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-haiku-5-5" });
    const second = await assign(p, "second");
    await stub(p).drain();
    // The first worker still runs on Opus: its template stays.
    expect(fake.catalog.has(opus)).toBe(true);
    expect(fake.catalog.has(haiku)).toBe(true);
    // A delete nest can't take now is tried again at the next sweep.
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: first.assignee, reason: "exited" });
    await stub(p).drain();
    expect(fake.catalog.has(opus)).toBe(true);
    fake.failures = [];
    await stub(p).drain();
    expect(fake.catalog.has(opus)).toBe(false);
    // The current setting's, and the manager's, stay.
    expect(fake.catalog.has(haiku)).toBe(true);
    expect(fake.catalog.has(`templates/${entry(p, "manager", "claude-fable-5-2")}`)).toBe(true);
    // With no worker left at all, the setting's own template still stays: the next start names it.
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: second.assignee, reason: "exited" });
    await stub(p).drain();
    expect(fake.catalog.has(haiku)).toBe(true);
  });

  it("nothing is swept while a start is owed: it may be about to name the template", async () => {
    const p = await newProject();
    const first = await assign(p, "first");
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-haiku-5-5" });
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: first.assignee, reason: "exited" });
    // A start in flight (its agent create failing for now), frozen on Haiku; then the setting moves on to Sonnet.
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    const second = await assign(p, "second");
    expect(second.state).toBe("assigned");
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-sonnet-5-5" });
    await stub(p).drain();
    expect(fake.catalog.has(`templates/${entry(p, "worker", "claude-haiku-5-5")}`)).toBe(true);
    expect(fake.catalog.has(`templates/${entry(p, "worker", "claude-opus-5-5")}`)).toBe(true);
  });

  it("a project that's gone takes all its model templates with it", async () => {
    const p = await newProject();
    await assign(p);
    const mine = () => [...fake.catalog.keys()].filter((k) => k.includes(`-${p.id.replace("prj_", "")}-`));
    expect(mine()).toHaveLength(2);
    // Removed from the directory (as a create that couldn't be finished is): its object goes inert.
    await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => { st.storage.sql.exec("DELETE FROM projects WHERE id = ?", p.id); });
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET listed_ms = NULL"); });
    await runDurableObjectAlarm(stub(p));
    expect(mine()).toEqual([]);
  });

  it("refuses a model id that could be an option or carry a space, and changes nothing", async () => {
    const p = await newProject();
    for (const bad of ["--dangerously-skip-permissions", "opus 5", ""]) {
      expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: bad })).status, bad).toBe(400);
    }
    // ProjectDO checks it itself too, whoever calls it.
    const direct = await stub(p).updateSettings({ manager_model: "-p" });
    expect(direct).toMatchObject({ ok: false, status: 400 });
    const s = (await api(token, "GET", `/api/projects/${p.id}`)).body.settings;
    expect(s).toMatchObject({ worker_model: "claude-opus-5-5", manager_model: "claude-fable-5-2" });
  });
});

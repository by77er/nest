// The models a project's manager and workers run on (README.md#models): the defaults, the owner's choice
// in Settings, and how it reaches nest: a template of the project's own with `launch.model`, named for
// the role and the model, which each start names (frozen with the attempt, so a change applies to the
// next start).
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTBOX } from "../src/outbox";
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
  /** Run the project's alarm now, whether or not one is scheduled. */
  const alarm = (p: P) => runInDurableObject(stub(p), (o) => (o as unknown as { alarm(): Promise<void> }).alarm());
  // One test's injected failures never reach the next.
  beforeEach(() => { fake.failures = []; fake.holds = []; });
  const alarmOnly = (p: P) => stub(p).drain();
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

  it("the owner's choice applies to workers started after it; the running manager keeps its agent and template (it's switched, below)", async () => {
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

  describe("the running manager switched now (README.md#models)", () => {
    const settings = (p: P) => api(token, "GET", `/api/projects/${p.id}`).then((r) => r.body.settings);
    const appChat = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/chat`)).body as { sender: string; text: string }[]).filter((m) => m.sender === "app").map((m) => m.text);
    const setModel = (p: P, m: string) => api(token, "PATCH", `/api/projects/${p.id}/settings`, { manager_model: m });
    const managerAgents = (p: P) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "manager");

    it("an idle manager is restarted on the new model right away (in the save), keeping its agent and session; the chat says so", async () => {
      const p = await newProject();
      // Switched before the save answers: nothing is owed after it.
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toBeNull();
      const m = fake.agents.get(p.manager)!;
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
      // The same agent (its session resumed by nest), no new one.
      expect(managerAgents(p)).toHaveLength(1);
      expect((await settings(p)).manager).toBe(p.manager);
      expect((await settings(p)).manager_switch).toBeNull();
      expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
      // Done: more alarms restart nothing.
      await alarm(p);
      expect(m.restarts).toHaveLength(1);
    });

    it("a manager in a turn switches once it ends, never in it", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      m.state = "working";
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toEqual({ from: "claude-fable-5-2", to: "claude-sonnet-5-5", after_turn: true });
      await alarm(p);
      expect(m.restarts ?? []).toEqual([]);
      // Its turn ends: due now.
      m.state = "waiting_input";
      await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, text: "Done." });
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
      expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
    });

    it("a turn's end missed: it looks again, and still never mid-turn", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      m.state = "compacting";
      await setModel(p, "claude-sonnet-5-5");
      await alarm(p);
      const due = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT switch_next_ms FROM settings").one().switch_next_ms as number);
      expect(due).toBeGreaterThan(Date.now());
      expect(m.restarts ?? []).toEqual([]);
      m.state = "idle";
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET switch_next_ms = 0"); });
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
    });

    it("the last change wins: two quick changes during a turn switch once, to the second; changed back before the switch, nothing restarts", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      m.state = "working";
      await setModel(p, "claude-sonnet-5-5");
      await setModel(p, "claude-haiku-5-5");
      m.state = "waiting_input";
      await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, text: "Done." });
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-haiku-5-5" }]);
      m.state = "working";
      await setModel(p, "claude-opus-5-5");
      expect((await settings(p)).manager_switch).toEqual({ from: "claude-haiku-5-5", to: "claude-opus-5-5", after_turn: true });
      await setModel(p, "claude-haiku-5-5");
      expect((await settings(p)).manager_switch).toBeNull();
      m.state = "waiting_input";
      await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, text: "Done again." });
      await alarm(p);
      expect(m.restarts).toHaveLength(1);
    });

    it("changed again while a switch is at nest: the latest follows it", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      let release!: () => void;
      const hold = { match: new RegExp(`^POST /v1/agents/${p.manager}/start$`), release: new Promise<void>((r) => { release = r; }), reached: false };
      fake.holds.push(hold);
      const running = setModel(p, "claude-sonnet-5-5");
      await vi.waitFor(() => expect(hold.reached).toBe(true));
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_model = 'claude-haiku-5-5'"); });
      release();
      await running;
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-haiku-5-5" }]);
      expect((await settings(p)).manager_switch).toBeNull();
    });

    it("no running manager (a start pending, or it ended): nothing to switch; its start takes the setting's model", async () => {
      const p = await newProject();
      fake.agents.get(p.manager)!.ended = true;
      await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: p.manager, reason: "exited" });
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toBeNull();
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"); });
      await stub(p).drain();
      const next = (await settings(p)).manager as string;
      expect(next).not.toBe(p.manager);
      expect(fake.agents.get(next)!.template).toBe(entry(p, "manager", "claude-sonnet-5-5"));
      expect(fake.agents.get(next)!.restarts ?? []).toEqual([]);
      expect((await settings(p)).manager_switch).toBeNull();
    });

    it("a start frozen before the change runs the old model, then is switched to the new one", async () => {
      const p = await newProject();
      fake.agents.get(p.manager)!.ended = true;
      // nest can't take the new manager's create for a while (the client retries a retryable answer itself).
      fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
      await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: p.manager, reason: "exited" });
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"); });
      await stub(p).drain();
      expect((await settings(p)).manager).toBeNull();
      // Its attempt froze Fable; the setting changes before the retry (with no running manager, nothing to switch yet).
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toBeNull();
      fake.failures = [];
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"); });
      // The start, on the model it froze, then the switch onto the setting's, in the same drain.
      await stub(p).drain();
      const next = (await settings(p)).manager as string;
      expect(fake.agents.get(next)!.template).toBe(entry(p, "manager", "claude-fable-5-2"));
      await alarm(p);
      expect(fake.agents.get(next)!.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
      expect((await settings(p)).manager_switch).toBeNull();
    });

    it("a switch nest refuses for good is said in the chat and not tried again; one it can't take now is retried", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      // The client retries a retryable answer itself: nest can't take it for a while.
      fake.fail(new RegExp(`^POST /v1/agents/${p.manager}/start$`), 503, { retryable: true, times: 1000 });
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toEqual({ from: "claude-fable-5-2", to: "claude-sonnet-5-5", after_turn: false });
      expect(m.restarts ?? []).toEqual([]);
      fake.failures = [];
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET switch_next_ms = 0"); });
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
      fake.fail(new RegExp(`^POST /v1/agents/${p.manager}/start$`), 400, { times: 1 });
      await setModel(p, "claude-haiku-5-5");
      await alarm(p);
      expect(await appChat(p)).toEqual(expect.arrayContaining([expect.stringMatching(/^The manager couldn't be switched to Haiku/)]));
      expect((await settings(p)).manager_switch).toBeNull();
      await alarm(p);
      expect(m.restarts).toHaveLength(1);
    });

    it("a nest that ignored the launch (its answer names none) is said in the chat, and the manager's model isn't taken as switched", async () => {
      const p = await newProject();
      fake.launchIgnored = true;
      try {
        expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toBeNull();
        expect(await appChat(p)).toEqual(expect.arrayContaining([expect.stringMatching(/^The manager couldn't be switched to Sonnet 5\.5: nest didn't apply the model/)]));
        expect(await appChat(p)).not.toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
        expect(await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT manager_running_model AS m FROM settings").one().m)).not.toBe("claude-sonnet-5-5");
      } finally {
        fake.launchIgnored = false;
      }
    });

    it("changed back while the restart is at nest: what nest runs is recorded, and a switch back is owed", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      let release!: () => void;
      const hold = { match: new RegExp(`^POST /v1/agents/${p.manager}/start$`), release: new Promise<void>((r) => { release = r; }), reached: false };
      fake.holds.push(hold);
      const running = setModel(p, "claude-sonnet-5-5");
      await vi.waitFor(() => expect(hold.reached).toBe(true));
      // Back to Fable through the API while the restart onto Sonnet is out (it clears the owed switch; its
      // save then waits on the drain that holds the restart).
      const back = setModel(p, "claude-fable-5-2");
      await vi.waitFor(async () => expect(await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT manager_model AS m, switch_next_ms AS n FROM settings").one())).toEqual({ m: "claude-fable-5-2", n: null }));
      release();
      await running;
      await back;
      // nest runs Sonnet now: recorded, said, and the switch back to Fable owed (and made).
      expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-fable-5-2" }]);
      expect(await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT manager_running_model AS m FROM settings").one().m)).toBe("claude-fable-5-2");
      expect((await settings(p)).manager_switch).toBeNull();
    });

    it("restarts only when nest finds the manager idle: a turn running is nest's 409 busy, and the switch waits for its end", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      m.state = "working";
      expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toMatchObject({ after_turn: true });
      // Asked of nest with when: idle, and refused; nothing restarted, so no turn was cut.
      const asked = fake.callsTo("POST", new RegExp(`^/v1/agents/${p.manager}/start$`));
      expect(asked.at(-1)!.body).toEqual({ restart: true, launch: { model: "claude-sonnet-5-5" }, when: "idle" });
      expect(m.restarts ?? []).toEqual([]);
      m.state = "waiting_input";
      await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, text: "Done." });
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
    });

    it("a nest before when: idle (400) falls back to looking at the state itself", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      fake.whenUnsupported = true;
      try {
        m.state = "working";
        expect((await setModel(p, "claude-sonnet-5-5")).body.manager_switch).toMatchObject({ after_turn: true });
        expect(m.restarts ?? []).toEqual([]);
        m.state = "idle";
        await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, text: "Done." });
        await alarm(p);
        expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
        const last = fake.callsTo("POST", new RegExp(`^/v1/agents/${p.manager}/start$`)).at(-1)!;
        expect(last.body).toEqual({ restart: true, launch: { model: "claude-sonnet-5-5" } });
        expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
      } finally {
        fake.whenUnsupported = false;
      }
    });

    // nest gave an accepted restart up (README.md#models): on its record (`restart_error`, given-up time `ms`), then its event.
    const giveUp = async (p: P, ms: number, agent = p.manager) => {
      fake.agents.get(p.manager)!.restartError = { code: "unavailable", message: "the fleet didn't answer", ms };
      await deliver({ id: `evt-${rand()}`, type: "agent.error", agent, code: "restart_refused", message: "the restart failed after retries" });
      await alarm(p);
    };
    const row = (p: P) => runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT manager_running_model, switch_next_ms, refusal_check_ms FROM settings").one());
    const dueNow = (p: P) => runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET switch_next_ms = 0 WHERE switch_next_ms IS NOT NULL"); });
    const refusedLines = async (p: P) => (await appChat(p)).filter((t) => t.includes("didn't complete") || t.startsWith("Couldn't switch"));

    it("nest giving up an accepted restart (restart_refused) is said, and the switch is tried again after a backoff; a give-up counted once", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      await setModel(p, "claude-sonnet-5-5");
      expect(m.restarts).toHaveLength(1);
      expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
      const before = Date.now();
      await giveUp(p, 1_000);
      expect(await refusedLines(p)).toEqual(["The switch to Sonnet 5.5 didn't complete (nest couldn't restart the manager): trying again in 5 minutes."]);
      const r = await row(p);
      expect(r.manager_running_model).toBeNull();
      expect(r.switch_next_ms as number).toBeGreaterThanOrEqual(before + 5 * 60_000);
      expect(r.switch_next_ms as number).toBeLessThan(Date.now() + 5 * 60_000 + 1);
      expect((await settings(p)).manager_switch).toMatchObject({ to: "claude-sonnet-5-5", after_turn: false });
      // Not at once: a cause that lasts (no brain room) would hold the manager's turns again.
      await alarm(p);
      expect(m.restarts).toHaveLength(1);
      // Another event naming the same give-up, and one straight to the project past the webhook's dedup: counted once.
      await giveUp(p, 1_000);
      await runInDurableObject(stub(p), (o) => (o as unknown as { onEvent(e: unknown, r: unknown): Promise<void> }).onEvent({ id: `evt-${rand()}`, type: "agent.error", agent: p.manager, code: "restart_refused" }, { role: "manager", task: null }));
      await alarm(p);
      expect(await refusedLines(p)).toHaveLength(1);
      await dueNow(p);
      await alarm(p);
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-sonnet-5-5" }]);
      expect((await settings(p)).manager_switch).toBeNull();
    });

    it("nest giving up again and again: tried after 5, then 10 minutes, and given up at the third", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      await setModel(p, "claude-sonnet-5-5");
      for (const [n, wait] of [[1, 5], [2, 10]] as const) {
        const before = Date.now();
        await giveUp(p, n);
        expect((await refusedLines(p)).at(-1)).toBe(`The switch to Sonnet 5.5 didn't complete (nest couldn't restart the manager): trying again in ${wait} minutes.`);
        const next = (await row(p)).switch_next_ms as number;
        expect(next).toBeGreaterThanOrEqual(before + wait * 60_000);
        expect(next).toBeLessThan(Date.now() + wait * 60_000 + 1);
        await dueNow(p);
        await alarm(p);
        expect(m.restarts).toHaveLength(n + 1);
      }
      await giveUp(p, 3);
      expect((await refusedLines(p)).at(-1)).toBe("Couldn't switch to Sonnet 5.5: it takes effect when the manager next starts.");
      expect(await refusedLines(p)).toHaveLength(3);
      expect((await settings(p)).manager_switch).toBeNull();
      await dueNow(p);
      await alarm(p);
      expect(m.restarts).toHaveLength(3);
    });

    it("another model isn't held back or counted by nest's give-ups of the last", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      await setModel(p, "claude-sonnet-5-5");
      await giveUp(p, 1);
      await setModel(p, "claude-haiku-5-5");
      // Tried now, not at the end of the Sonnet switch's backoff.
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }, { model: "claude-haiku-5-5" }]);
      await giveUp(p, 2);
      expect((await refusedLines(p)).at(-1)).toBe("The switch to Haiku 5.5 didn't complete (nest couldn't restart the manager): trying again in 5 minutes.");
    });

    it("a refusal counted puts off a switch that was due in the same drain", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      await setModel(p, "claude-sonnet-5-5");
      m.state = "working";
      expect((await setModel(p, "claude-haiku-5-5")).body.manager_switch).toMatchObject({ after_turn: true });
      m.state = "idle";
      await dueNow(p);
      await giveUp(p, 1);
      expect((await refusedLines(p)).at(-1)).toBe("The switch to Haiku 5.5 didn't complete (nest couldn't restart the manager): trying again in 5 minutes.");
      expect(m.restarts).toEqual([{ model: "claude-sonnet-5-5" }]);
    });

    it("a late refusal of an earlier switch, after a later one was asked, changes nothing", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      await setModel(p, "claude-sonnet-5-5");
      // nest gave the Sonnet restart up, but its event comes only after the Haiku restart was asked (which clears nest's record).
      m.restartError = { code: "unavailable", message: "the fleet didn't answer", ms: 1 };
      await setModel(p, "claude-haiku-5-5");
      expect(await appChat(p)).toContain(`Switched to ${modelLabel("claude-haiku-5-5")}.`);
      await deliver({ id: `evt-${rand()}`, type: "agent.error", agent: p.manager, code: "restart_refused", message: "the restart failed after retries" });
      await alarm(p);
      expect(await refusedLines(p)).toEqual([]);
      expect((await row(p)).manager_running_model).toBe("claude-haiku-5-5");
      expect((await settings(p)).manager_switch).toBeNull();
      expect(m.restarts).toHaveLength(2);
    });

    it("a refusal from an agent that isn't the current manager is ignored", async () => {
      const p = await newProject();
      await setModel(p, "claude-sonnet-5-5");
      // The current manager's record shows a give-up, but the event is a replaced manager's.
      fake.agents.get(p.manager)!.restartError = { code: "unavailable", message: "the fleet didn't answer", ms: 1 };
      await runInDurableObject(stub(p), (o) => (o as unknown as { onEvent(e: unknown, r: unknown): Promise<void> }).onEvent({ id: `evt-${rand()}`, type: "agent.error", agent: "agt_replaced", code: "restart_refused" }, { role: "manager", task: null }));
      await alarm(p);
      expect((await row(p)).refusal_check_ms).toBeNull();
      expect(await refusedLines(p)).toEqual([]);
      expect((await row(p)).manager_running_model).toBe("claude-sonnet-5-5");
    });

    it("a 409 other than busy (the manager ended) is said and dropped, not waited on", async () => {
      const p = await newProject();
      const m = fake.agents.get(p.manager)!;
      m.ended = true;
      const body = (await setModel(p, "claude-sonnet-5-5")).body;
      expect(body.manager_switch).toBeNull();
      expect((await appChat(p)).filter((t) => t.startsWith("The manager couldn't be switched to Sonnet 5.5:"))).toHaveLength(1);
      const asked = fake.callsTo("POST", new RegExp(`^/v1/agents/${p.manager}/start$`)).length;
      await dueNow(p);
      await alarm(p);
      expect(fake.callsTo("POST", new RegExp(`^/v1/agents/${p.manager}/start$`))).toHaveLength(asked);
      expect((await row(p)).switch_next_ms).toBeNull();
    });

    it("a switch made stale by a move of the manager (it ended meanwhile) writes nothing", async () => {
      const p = await newProject();
      let release!: () => void;
      const hold = { match: new RegExp(`^POST /v1/agents/${p.manager}/start$`), release: new Promise<void>((r) => { release = r; }), reached: false };
      fake.holds.push(hold);
      const running = setModel(p, "claude-sonnet-5-5");
      await vi.waitFor(() => expect(hold.reached).toBe(true));
      await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: p.manager, reason: "exited" });
      release();
      await running;
      expect(await appChat(p)).not.toContain(`Switched to ${modelLabel("claude-sonnet-5-5")}.`);
      expect((await settings(p)).manager_switch).toBeNull();
    });
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
    // Once its backoff has passed.
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE model_templates SET del_next_ms = 0 WHERE del_next_ms IS NOT NULL"); });
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

  it("a delete nest can't take is backed off, not tried at every drain; one it refuses for good is recorded and left", async () => {
    const p = await newProject();
    const first = await assign(p, "first");
    const opus = `templates/${entry(p, "worker", "claude-opus-5-5")}`;
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-haiku-5-5" });
    const deletes = () => fake.callsTo("DELETE", new RegExp(`^/v1/catalog/templates/projects/${entry(p, "worker", "claude-opus-5-5").replace("projects/", "")}$`)).length;
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: first.assignee, reason: "exited" });
    await stub(p).drain();
    const tried = deletes();
    expect(tried).toBeGreaterThan(0);
    // More drains before it's due: not tried again; the alarm is set for when it is.
    await stub(p).drain();
    await stub(p).drain();
    expect(deletes()).toBe(tried);
    const row = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT del_next_ms, del_attempts FROM model_templates WHERE del_next_ms IS NOT NULL").one());
    expect(row.del_next_ms as number).toBeGreaterThan(Date.now());
    expect(row.del_attempts).toBe(1);
    // The alarm's own run arms the next one no later than the retry.
    await runInDurableObject(stub(p), (_o, st) => st.storage.deleteAlarm());
    await alarm(p);
    const armed = await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed as number).toBeLessThanOrEqual(row.del_next_ms as number);
    expect(deletes()).toBe(tried);
    // Due, and refused for good this time: recorded among the errors, not tried again.
    fake.failures = [];
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 403, { times: 1 });
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE model_templates SET del_next_ms = 0 WHERE del_next_ms IS NOT NULL"); });
    await stub(p).drain();
    const after = deletes();
    expect(after).toBeGreaterThan(tried);
    await stub(p).drain();
    expect(deletes()).toBe(after);
    expect(fake.catalog.has(opus)).toBe(true);
    const errors = (await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { code: string; message: string }[];
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: "template_delete_failed" })]));
    // Chosen again, the template is the setting's: a start writes it, and its delete is no longer owed or failed.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: "claude-opus-5-5" });
    const writtenAt = () => runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT at_ms FROM model_templates WHERE name = ?", entry(p, "worker", "claude-opus-5-5")).one().at_ms as number);
    const was = await writtenAt();
    await assign(p, "third");
    // Each write is told from the last, so a delete in flight across it sees the row is the start's now.
    expect(await writtenAt()).toBeGreaterThan(was);
    const reset = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT del_next_ms, del_error FROM model_templates WHERE name = ?", entry(p, "worker", "claude-opus-5-5")).one());
    expect(reset).toEqual({ del_next_ms: null, del_error: null });
  });

  it("a project that's gone keeps trying the deletes nest couldn't take, from its own alarm", async () => {
    const p = await newProject();
    await assign(p);
    const mine = () => [...fake.catalog.keys()].filter((k) => k.includes(`-${p.id.replace("prj_", "")}-`));
    expect(mine()).toHaveLength(2);
    await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => { st.storage.sql.exec("DELETE FROM projects WHERE id = ?", p.id); });
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET listed_ms = NULL"); });
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    await alarm(p);
    expect(mine()).toHaveLength(2);
    // The project is gone, its templates still owed: an alarm is set for their retry.
    const state = await runInDurableObject(stub(p), async (_o, st) => ({
      settings: st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM settings").one().n,
      alarm: await st.storage.getAlarm(),
    }));
    expect(state.settings).toBe(0);
    expect(state.alarm).not.toBeNull();
    fake.failures = [];
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE model_templates SET del_next_ms = 0"); });
    await alarm(p);
    expect(mine()).toEqual([]);
    expect(await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM model_templates").one().n)).toBe(0);
  });

  /** A live project whose worker templates for `models` are stale, each with one failed delete that's due again. */
  async function staleWorkerTemplates(models: string[], then: string) {
    const p = await newProject();
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    for (const [i, m] of models.entries()) {
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: m });
      const t = await assign(p, `t${i}`);
      await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: t.assignee, reason: "exited" });
    }
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { worker_model: then });
    await stub(p).drain();
    fake.failures = [];
    const names = models.map((m) => entry(p, "worker", m));
    await runInDurableObject(stub(p), (_o, st) => {
      for (const n of names) expect(st.storage.sql.exec("SELECT del_attempts FROM model_templates WHERE name = ?", n).one().del_attempts, n).toBe(1);
      st.storage.sql.exec("UPDATE model_templates SET del_next_ms = 1 WHERE del_next_ms IS NOT NULL");
    });
    return { p, names };
  }
  const delRow = (p: P, name: string) => runInDurableObject(stub(p), (_o, st) =>
    st.storage.sql.exec("SELECT del_next_ms, del_attempts, del_error FROM model_templates WHERE name = ?", name).toArray()[0] ?? null);
  /** Hold the next template delete; `during` runs once it's waiting at nest, then it's let go. */
  async function duringDelete(p: P, run: () => Promise<unknown>, during: () => Promise<unknown>) {
    let release!: () => void;
    const hold = { match: /^DELETE \/v1\/catalog\/templates\//, release: new Promise<void>((r) => { release = r; }), reached: false };
    fake.holds.push(hold);
    const running = run();
    await vi.waitFor(() => expect(hold.reached).toBe(true));
    await during();
    release();
    await running;
  }

  it("a template that's kept again is owed no delete: an earlier failed one doesn't keep the alarm busy", async () => {
    const { p, names } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
    // Back to the model whose template's delete failed, with no start.
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET worker_model = 'claude-opus-5-5'"); });
    await runInDurableObject(stub(p), (_o, st) => st.storage.deleteAlarm());
    await alarm(p);
    const next = await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm());
    if (next !== null) expect(next).toBeGreaterThan(Date.now());
    expect(await delRow(p, names[0]!)).toEqual({ del_next_ms: null, del_attempts: 0, del_error: null });
    expect(fake.catalog.has(`templates/${names[0]}`)).toBe(true);
  });

  it("a backed-off delete doesn't keep the alarm busy while a start is owed either", async () => {
    const { p } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
    const far = Date.now() + 3_600_000;
    await runInDurableObject(stub(p), async (_o, st) => {
      st.storage.sql.exec("UPDATE settings SET manager_next_ms = ?", far);
      await st.storage.deleteAlarm();
    });
    await alarm(p);
    // The delete isn't one the sweep would make now, so it's no reason to wake (an alarm set for a past
    // time runs at once, so the reason is asked for itself).
    expect(await runInDurableObject(stub(p), (o) => (o as unknown as { templateDeleteDue(): number | null }).templateDeleteDue())).toBeNull();
    const next = await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm());
    if (next !== null) expect(next).toBeGreaterThan(Date.now());
  });

  it("a delete is given up after its attempts run out, so a removed project's object rests", async () => {
    const { p, names } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
    await runInDurableObject(stub(p), async (_o, st) => {
      st.storage.sql.exec("DELETE FROM settings");
      st.storage.sql.exec("UPDATE model_templates SET del_attempts = ? WHERE name = ?", OUTBOX.templates.maxAttempts! - 2, names[0]!);
      st.storage.sql.exec("DELETE FROM model_templates WHERE name <> ?", names[0]!);
      await st.storage.deleteAlarm();
    });
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    await alarm(p);
    // One short of the limit: still owed, and armed.
    expect((await delRow(p, names[0]!))!.del_next_ms).not.toBeNull();
    expect(await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm())).not.toBeNull();
    await runInDurableObject(stub(p), async (_o, st) => {
      st.storage.sql.exec("UPDATE model_templates SET del_next_ms = 1");
      await st.storage.deleteAlarm();
    });
    await alarm(p);
    expect(await delRow(p, names[0]!)).toMatchObject({ del_next_ms: null, del_attempts: OUTBOX.templates.maxAttempts });
    expect(await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm())).toBeNull();
  });

  it.each(["being removed", "already removed"])("a project %s arms nothing for its deletes when no sweep ran (no nest client)", async (when) => {
    const { p } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
    await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => { st.storage.sql.exec("DELETE FROM projects WHERE id = ?", p.id); });
    const before = fake.callsTo("DELETE", /^\/v1\/catalog\/templates\//).length;
    const armed = await runInDurableObject(stub(p), async (o, st) => {
      st.storage.sql.exec(when === "being removed" ? "UPDATE settings SET listed_ms = NULL" : "DELETE FROM settings");
      await st.storage.deleteAlarm();
      const held = o as unknown as { env: Record<string, unknown>; alarm(): Promise<void> };
      const real = held.env;
      held.env = { ...real, NEST_CLIENT_TOKEN: undefined };
      try {
        await held.alarm();
      } finally {
        held.env = real;
      }
      return st.storage.getAlarm();
    });
    expect(fake.callsTo("DELETE", /^\/v1\/catalog\/templates\//).length).toBe(before);
    expect(armed).toBeNull();
  });

  it("a template a start wrote again while its delete was at nest is that start's: its row isn't dropped or backed off", async () => {
    for (const fails of [false, true]) {
      const { p, names } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
      if (fails) fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
      await duringDelete(p, () => stub(p).drain(), () => runInDurableObject(stub(p), (_o, st) => {
        // As `templateFor` writes it.
        st.storage.sql.exec("UPDATE model_templates SET at_ms = at_ms + 1, del_next_ms = NULL, del_attempts = 0, del_error = NULL WHERE name = ?", names[0]!);
      }));
      expect(await delRow(p, names[0]!), `fails: ${fails}`).toEqual({ del_next_ms: null, del_attempts: 0, del_error: null });
      fake.failures = [];
    }
  });

  it("each delete is decided afresh: a template kept again during an earlier delete's wait isn't deleted after it", async () => {
    const { p, names } = await staleWorkerTemplates(["claude-opus-5-5", "claude-haiku-5-5"], "claude-sonnet-5");
    const calls = (n: string) => fake.callsTo("DELETE", new RegExp(`^/v1/catalog/templates/${n}$`)).length;
    const before = names.map(calls);
    let held = "";
    await duringDelete(p, () => stub(p).drain(), async () => {
      // Whichever is at nest now, the setting comes back to the other one.
      held = names.find((n, i) => calls(n) > before[i]!)!;
      const other = names.find((n) => n !== held)!;
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET worker_model = ?", other === names[0] ? "claude-opus-5-5" : "claude-haiku-5-5"); });
    });
    const other = names.find((n) => n !== held)!;
    expect(calls(other)).toBe(before[names.indexOf(other)]);
    expect(fake.catalog.has(`templates/${other}`)).toBe(true);
    expect(fake.catalog.has(`templates/${held}`)).toBe(false);
    expect(await delRow(p, other)).toEqual({ del_next_ms: null, del_attempts: 0, del_error: null });
  });

  it("a delete that fails while a start has come to be owed isn't backed off: the start may name the template", async () => {
    const { p, names } = await staleWorkerTemplates(["claude-opus-5-5"], "claude-haiku-5-5");
    fake.fail(/^DELETE \/v1\/catalog\/templates\//, 503, { retryable: true, times: 1000 });
    await duringDelete(p, () => alarmOnly(p), () => runInDurableObject(stub(p), (_o, st) => {
      st.storage.sql.exec("UPDATE settings SET manager_next_ms = ?", Date.now() + 3_600_000);
    }));
    expect(await delRow(p, names[0]!)).toMatchObject({ del_next_ms: 1, del_attempts: 1 });
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
    await alarm(p);
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

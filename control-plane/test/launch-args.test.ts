// A launch's model and effort become arguments of the brain's command (docs/control-plane/durable-objects/
// catalog/): plain tokens only, checked where a launch is written, for the operator and every API client
// alike. A template stored before the rule is read as it is.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LAUNCH_ARG, launchProblem } from "../src/lib/spec";
import { admin, adminJson, BASE, eventually, uniqueCell } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const launch = (extra: Record<string, unknown> = {}) => ({ builtin_tools: [], system_prompt: { mode: "append", text: "" }, ...extra });
const template = (l: Record<string, unknown>) => ({ capabilities: ["nest"], launch: launch(l), hands: "forbidden", credential: "claude_oauth_token" });

async function asClient(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: res.status, body: await res.json() };
}

async function newClient() {
  const cell = uniqueCell();
  const name = `la-${rand()}`;
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 10, max_sandboxes: 10 } } }, 201);
  return { name, token: c.token as string, cell };
}

const GOOD = ["claude-opus-5-5", "opus", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-4-5@20251101", "high"];
const BAD = ["", "-p", "--dangerously-skip-permissions", "a b", "a\nb", "a;b", "$(x)", "x".repeat(101)];

describe("a launch's model and effort", () => {
  it("are plain tokens: what Claude Code takes, never an option, a space or a control character", () => {
    for (const v of GOOD) expect(LAUNCH_ARG.test(v), v).toBe(true);
    for (const v of BAD) expect(LAUNCH_ARG.test(v), JSON.stringify(v)).toBe(false);
    expect(launchProblem(undefined)).toBeNull();
    expect(launchProblem({})).toBeNull();
    expect(launchProblem({ model: "opus", effort: "high" })).toBeNull();
    expect(launchProblem({ model: "--x" })).toContain("launch.model");
    expect(launchProblem({ model: "opus", effort: "-x" })).toContain("launch.effort");
  });

  it("a client's template is held to it when written; a good one is taken", async () => {
    const c = await newClient();
    for (const model of ["--dangerously-skip-permissions", "opus 5"]) {
      const r = await asClient(c.token, `/v1/catalog/templates/${c.name}/bad`, { method: "PUT", body: template({ model }) });
      expect(r.status, model).toBe(400);
      expect(r.body.error.message).toContain("launch.model");
    }
    expect((await asClient(c.token, `/v1/catalog/templates/${c.name}/bad`, { method: "PUT", body: template({ effort: "-max" }) })).status).toBe(400);
    expect((await asClient(c.token, `/v1/catalog/templates/${c.name}/bad`)).status).toBe(404);
    expect((await asClient(c.token, `/v1/catalog/templates/${c.name}/good`, { method: "PUT", body: template({ model: "claude-opus-5-5[1m]", effort: "high" }) })).status).toBe(200);
  });

  it("the operator's template and spawn override are held to it too", async () => {
    const name = `la-op-${rand()}`;
    const r = await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: template({ model: "-p" }) }, 400);
    expect(r.error.message).toContain("launch.model");
    await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: template({ model: "opus" }) });
    const cell = uniqueCell();
    const refused = await adminJson(`/v1/agents?cell=${cell}`, { body: { template: name, launch: launch({ model: "--x" }), start: false } }, 400);
    expect(refused.error.message).toContain("launch.model");
  });

  it("the operator's launch in overrides is held to it too", async () => {
    const name = `la-ov-${rand()}`;
    await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: template({ model: "opus" }) });
    const cell = uniqueCell();
    const refused = await adminJson(`/v1/agents?cell=${cell}`, { body: { template: name, overrides: { launch: launch({ effort: "--x" }) }, start: false } }, 400);
    expect(refused.error.message).toContain("launch.effort");
    await adminJson(`/v1/agents?cell=${cell}`, { body: { template: name, overrides: { launch: launch({ model: "claude-opus-5-5", effort: "high" }) }, start: false } }, 201);
  });

  it("a template stored before the rule still reads, and doesn't block a capability write, but nothing spawns from it until it's written again", async () => {
    const cap = `la-cap-${rand()}`;
    const tpl = `la-old-${rand()}`;
    await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: { tools: ["agent_stop"] } });
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: { ...template({ model: "opus" }), capabilities: ["nest", cap] } });
    // As a release before the rule could have stored it.
    await runInDurableObject(env.CATALOG.get(env.CATALOG.idFromName("catalog")), (_o, st) => {
      const row = st.storage.sql.exec<{ body: string }>("SELECT body FROM templates WHERE name = ?", tpl).one();
      const body = JSON.parse(row.body);
      body.launch.model = "--dangerously-skip-permissions";
      st.storage.sql.exec("UPDATE templates SET body = ? WHERE name = ?", JSON.stringify(body), tpl);
    });
    expect((await adminJson("/v1/admin/catalog")).templates[tpl].launch.model).toBe("--dangerously-skip-permissions");
    // A capability it lists is written again (its templates are re-checked): not blocked by the old launch.
    await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: { tools: ["agent_stop", "agent_spawn"], spawn: [tpl] } });
    // No spawn from it.
    const cell = uniqueCell();
    const refused = await adminJson(`/v1/agents?cell=${cell}`, { body: { template: tpl, start: false } }, 400);
    expect(refused.error.message).toContain(`template ${tpl}: launch.model`);
    // Written again with a good model, it spawns.
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: { ...template({ model: "opus" }), capabilities: ["nest", cap] } });
    await adminJson(`/v1/agents?cell=${cell}`, { body: { template: tpl, start: false } }, 201);
  });

  it("an agent whose stored spec has a bad model starts no brain: the start fails for good, with why", async () => {
    const tpl = `la-ag-${rand()}`;
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: template({ model: "opus" }) });
    const cell = uniqueCell();
    const a = await adminJson(`/v1/agents?cell=${cell}`, { body: { template: tpl, start: false } }, 201);
    // Its spec as a release before the rule could have stored it.
    const stub = env.AGENT.get(env.AGENT.idFromName(a.agent));
    await runInDurableObject(stub, (_o, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.launch.model = "-p";
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    await admin(`/v1/agents/${a.agent}/start`, { method: "POST" }).then((r) => r.text());
    const after: any = await eventually("the start's refusal on the record", async () => {
      const v = await adminJson(`/v1/agents/${a.agent}`);
      return v.start_error ? v : null;
    });
    expect(after.start_error.message).toContain("launch.model");
    expect(after.brain ?? null).toBeNull();
  });
});

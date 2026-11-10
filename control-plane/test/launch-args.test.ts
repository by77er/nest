// A launch's model and effort become arguments of the brain's command (docs/control-plane/durable-objects/
// catalog/): plain tokens only, checked where a launch is written, for the operator and every API client
// alike. A template stored before the rule is read as it is.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LAUNCH_ARG, launchProblem } from "../src/lib/spec";
import { adminJson, BASE, uniqueCell } from "./helpers";

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

  it("a template stored before the rule still reads and expands: only writing is checked", async () => {
    const c = await newClient();
    const tpl = `${c.name}/old`;
    await asClient(c.token, `/v1/catalog/templates/${tpl}`, { method: "PUT", body: template({ model: "opus" }) });
    // As a release before the rule could have stored it.
    await runInDurableObject(env.CATALOG.get(env.CATALOG.idFromName("catalog")), (_o, st) => {
      const row = st.storage.sql.exec<{ body: string }>("SELECT body FROM templates WHERE name = ?", tpl).one();
      const body = JSON.parse(row.body);
      body.launch.model = "an old model id";
      st.storage.sql.exec("UPDATE templates SET body = ? WHERE name = ?", JSON.stringify(body), tpl);
    });
    const read = await asClient(c.token, `/v1/catalog/templates/${tpl}`);
    expect(read.status).toBe(200);
    expect(read.body.launch.model).toBe("an old model id");
    const made = await asClient(c.token, "/v1/agents", { body: { cell: c.cell, template: tpl, labels: {}, start: false } });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    // Writing it again is held to the rule.
    expect((await asClient(c.token, `/v1/catalog/templates/${tpl}`, { method: "PUT", body: template({ model: "an old model id" }) })).status).toBe(400);
  });
});

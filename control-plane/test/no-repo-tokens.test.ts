// The kernel mints no repo tokens (docs/sandbox/networking/egress/policy/#no-repo-tokens): what templates,
// specs and sandbox layers stored of nest's former GitHub access (`repos`, `read_repos`, `github_push`) reads
// as pruned and is never acted on, what a release before this one keeps for a sandbox goes, and the tokens it
// minted never resolve again. The writes that refuse or drop the fields are in client-layer.test.ts.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CatalogDO } from "../src/do/catalog";
import { SandboxDO } from "../src/do/sandbox";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { type Catalog, expandSpec, SEED_CATALOG, Template } from "../src/lib/spec";
import { adminJson, connectHost, nextCommands, uniqueCell, type Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const TPL = { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token" } as const;
/** What a release before this one stored in a template, a spec or a layer. */
const OLD = { repos: ["acme/app"], read_repos: ["acme/lib"], github_push: { workflows: true } };
const REMOVED = ["repos", "read_repos", "github_push"];
const has = (v: object) => REMOVED.filter((k) => Object.hasOwn(v, k));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const catalogStub = () => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const broker = () => env.BROKER.get(env.BROKER.idFromName("broker"));

async function placed(policy: Record<string, unknown> = {}): Promise<{ sandbox: string; cell: string; ws: Ws }> {
  const cell = uniqueCell();
  const h = await connectHost(cell);
  const sbx = await adminJson("/v1/sandboxes", { body: { cell, policy } }, 201);
  await nextCommands(h.ws, (c) => c.type === "sandbox_create");
  return { sandbox: sbx.sandbox, cell, ws: h.ws };
}

describe("specs and templates", () => {
  it("a template read with them is read without them, and expands into a spec without them, whatever the overrides that grant nothing", () => {
    const tpl = Template.parse({ ...TPL, ...OLD });
    expect(has(tpl)).toEqual([]);
    const cat: Catalog = { ...SEED_CATALOG, templates: { ...SEED_CATALOG.templates, old: tpl } };
    for (const spec of [
      { template: "old", hands: true, by: "operator" as const, overrides: { repos: [], read_repos: [], github_push: { workflows: false as const } } },
      { template: "old", hands: true, by: "spawner" as const, overrides: { repos: [], read_repos: [] } },
    ]) {
      const r = expandSpec(cat, PLATFORM_TOOL_NAMES, spec);
      expect(r.ok && has(r.value), spec.by).toEqual([]);
    }
    // A spawner's narrowing to a repo is refused: there is nothing to narrow.
    const r = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "old", hands: true, by: "spawner", overrides: { repos: ["acme/app"] } });
    expect(!r.ok && r.error).toContain("repos is no longer accepted");
  });

  it("a stored template row holding them reads pruned in the catalog, stays as stored, and an agent spawns from it without them", async () => {
    const name = `old-${rand()}`;
    const row = JSON.stringify({ ...TPL, ...OLD });
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO templates (name, body) VALUES (?, ?)", name, row);
    });
    const cat = await adminJson("/v1/admin/catalog");
    expect(cat.templates[name]).toEqual(TPL);
    const { sandbox } = await placed();
    const a = await adminJson("/v1/agents", { body: { template: name, sandbox, start: false } }, 201);
    expect(has(a)).toEqual([]);
    const policy = await adminJson(`/v1/sandboxes/${sandbox}/policy`);
    expect(policy.inject).toEqual([]);
    expect(policy.allow.filter((r: any) => r.host === "api.github.com")).toEqual([]);
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => {
      expect(st.storage.sql.exec<{ body: string }>("SELECT body FROM templates WHERE name = ?", name).one().body).toBe(row);
    });
  });

  it("a template a Worker of the previous release hands CatalogDO with them is refused if they grant anything, else stored without them", async () => {
    const name = `prev-${rand()}`;
    await expect(Promise.resolve().then(() => catalogStub().putTemplate(name, { ...TPL, repos: ["acme/app"] } as never))).rejects.toThrow(/repos is no longer accepted/);
    await expect(Promise.resolve().then(() => catalogStub().putTemplate(name, { ...TPL, github_push: { workflows: true } } as never))).rejects.toThrow(/github_push.workflows is no longer accepted/);
    await catalogStub().putTemplate(name, { ...TPL, repos: [], read_repos: [], github_push: { workflows: false } } as never);
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => {
      expect(has(JSON.parse(st.storage.sql.exec<{ body: string }>("SELECT body FROM templates WHERE name = ?", name).one().body))).toEqual([]);
    });
  });

  it("an agent's spec stored with them keeps them in its record and leaves them out of its view", async () => {
    const { sandbox } = await placed();
    const a = await adminJson("/v1/agents", { body: { template: "worker", sandbox, start: false } }, 201);
    const stub = env.AGENT.get(env.AGENT.idFromName(a.agent));
    await runInDurableObject(stub, (_i, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...info, ...OLD }));
    });
    expect(has(await adminJson(`/v1/agents/${a.agent}`))).toEqual([]);
    await runInDurableObject(stub, (_i, st) => {
      expect(has(JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value))).toEqual(REMOVED);
    });
  });
});

describe("a sandbox", () => {
  it("drops what a release before this one kept to mint from (its agents' repos, the push opt-ins, the read-token flag) at its next start", async () => {
    const { sandbox } = await placed();
    const stub = sandboxStub(sandbox);
    const keys = ["agent_repos", "agent_read_repos", "github_push", "agent_github_push", "read_token"];
    await runInDurableObject(stub, (_i: SandboxDO, st) => {
      for (const k of [...keys, "agent_inject"]) st.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", k, JSON.stringify({ agt_x: ["acme/app"] }));
      new SandboxDO(st as never, env as never);
      const left = st.storage.sql.exec<{ key: string }>(`SELECT key FROM kv WHERE key IN (${[...keys, "agent_inject"].map(() => "?").join(", ")})`, ...keys, "agent_inject")
        .toArray().map((r) => r.key);
      // Only the generic key stays (its own reader, `clientInjections`, ignores an agent not attached).
      expect(left).toEqual(["agent_inject"]);
    });
  });

  it("an operator layer a Worker of the previous release hands it with them is refused if they grant anything, else stored without them", async () => {
    const { sandbox } = await placed();
    const stub = sandboxStub(sandbox);
    for (const layer of [{ repos: ["acme/app"] }, { read_repos: ["acme/lib"] }, { github_push: { workflows: true } }]) {
      await expect(Promise.resolve().then(() => stub.setPolicy(layer as never)), JSON.stringify(layer)).rejects.toThrow(/is no longer accepted/);
    }
    await stub.setPolicy({ allow: [{ host: "api.example.com" }], repos: [], read_repos: [], github_push: { workflows: false } } as never);
    await runInDurableObject(stub, (_i: SandboxDO, st) => {
      const stored = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one().value);
      expect([has(stored), stored.allow]).toEqual([[], [{ host: "api.example.com" }]]);
    });
  });

  it("guards are only the base layer's, the operator's and its client's: nest constructs none of its own", async () => {
    const { sandbox, ws } = await placed({});
    expect((await adminJson(`/v1/sandboxes/${sandbox}/policy`)).guards).toEqual([]);
    const mine = { name: "registry-publish", hosts: ["registry.npmjs.org"], scope: [{ methods: ["PUT"] }], reason: "no publishing" };
    const policy = await sandboxStub(sandbox).setPolicy({ guards: [mine] });
    expect(policy.guards).toEqual([mine]);
    const [update] = (await nextCommands(ws, (c) => c.type === "policy_update")).filter((c) => c.type === "policy_update");
    expect(update.policy.guards).toEqual([mine]);
  });

  it("a token a release before this one minted for it never resolves under an operator binding of the same name: a full push forgets it first", async () => {
    const { sandbox, ws } = await placed();
    const b = `gh${rand()}`;
    // What the previous release left: a minted token under the sandbox's most specific name, and its row.
    await broker().putSecret(`inject:${b}:${sandbox}`, "minted-token-value", Date.now() + 3_600_000);
    await runInDurableObject(broker(), (_i, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO injections (sandbox, binding, source, covers, expires_ms, minted_ms) VALUES (?, ?, 'k', '[]', ?, 0)",
        sandbox, b, Date.now() + 3_600_000);
    });
    // The operator's own static binding of that name, and its value.
    await broker().putSecret(`inject:${b}`, "operator-value");
    await sandboxStub(sandbox).setPolicy({ inject: [{ name: b, hosts: ["api.example.com"], placeholder: `nest-ph-${b}`, locations: [{ type: "authorization_bearer" }] }] });
    const secrets = (await nextCommands(ws, (c) => c.type === "secrets_update")).find((c) => c.type === "secrets_update")!.secrets;
    expect(secrets).toEqual([{ binding: b, value: "operator-value" }]);
    await runInDurableObject(broker(), (_i, st) => {
      expect(st.storage.sql.exec("SELECT 1 FROM secrets WHERE name = ?", `inject:${b}:${sandbox}`).toArray()).toEqual([]);
      expect(st.storage.sql.exec("SELECT 1 FROM injections WHERE sandbox = ?", sandbox).toArray()).toEqual([]);
    });
  });

  it("static injection secrets are keyed by sandbox first, then the old workstream key, then the binding", async () => {
    const b = `svc-${rand()}`;
    await broker().putSecret(`inject:${b}`, "global-value");
    await broker().putSecret(`inject:${b}:ws_old`, "ws-value");
    const ref = async (scope: Parameters<ReturnType<typeof broker>["injectionSecretRefs"]>[1]) => (await broker().injectionSecretRefs([b], scope))[0]!.value;
    expect(await ref({ sandbox: "sbx_none", workstream: "ws_old" })).toBe(`$nest-secret:inject:${b}:ws_old`);
    expect(await ref("ws_old")).toBe(`$nest-secret:inject:${b}:ws_old`);
    await broker().putSecret(`inject:${b}:sbx_mine`, "sandbox-value");
    expect(await ref({ sandbox: "sbx_mine", workstream: "ws_old" })).toBe(`$nest-secret:inject:${b}:sbx_mine`);
    expect(await ref({ sandbox: "sbx_other" })).toBe(`$nest-secret:inject:${b}`);
  });
});

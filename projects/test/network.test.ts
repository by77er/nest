// A project's network rules (README.md#network): per role, within the grant's egress_hosts (refused
// outside it); new agents get them at their sandbox's create, live ones through their sandbox's client
// layer, which `clientLayerFor` builds whole, keeping what the other pages put there. The pure parts first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { clientLayerFor, hostAllowed, NO_RULES, normalizeRules, rulesProblems } from "../src/network";
import { env, runInDurableObject } from "cloudflare:test";
import { AccessTeam, api, CLIENT, FakeNest, installFetch } from "./fake-nest";

describe("the rules (pure)", () => {
  it("refuses hosts outside the grant, saying the operator must widen it; and malformed rules", () => {
    const grant = ["registry.npmjs.org", "*.pythonhosted.org"];
    expect(rulesProblems([{ host: "registry.npmjs.org" }, { host: "files.pythonhosted.org", ports: [443] }], grant)).toEqual({});
    expect(rulesProblems([{ host: "nodejs.org" }], grant)["nodejs.org"]).toMatch(/outside the hosts this app may open.*the operator must widen the grant's egress_hosts/);
    expect(Object.keys(rulesProblems([{ host: "a.b.example" }, { host: "a.b.example" }], null))).toEqual(["a.b.example"]);
    for (const bad of ["1.2.3.4", "*.com", "Bad Host", ""]) expect(Object.keys(rulesProblems([{ host: bad }], null)), bad).toHaveLength(1);
    expect(rulesProblems([{ host: "x.example.com", ports: [] }], null)["x.example.com"]).toMatch(/1 to 16 ports/);
    expect(rulesProblems([{ host: "x.example.com", ports: [70000] }], null)["x.example.com"]).toMatch(/1 to 65535/);
    // A wildcard grant covers its subdomains and narrower wildcards, never the bare name.
    expect(hostAllowed("a.pythonhosted.org", grant)).toBe(true);
    expect(hostAllowed("*.x.pythonhosted.org", grant)).toBe(true);
    expect(hostAllowed("pythonhosted.org", grant)).toBe(false);
  });

  it("stores rules lowercase, ports sorted, and the web ports as none", () => {
    expect(normalizeRules([{ host: " NodeJS.org " }, { host: "x.example.com", ports: [443, 80] }, { host: "y.example.com", ports: [8443, 443, 8443] }]))
      .toEqual([{ host: "nodejs.org" }, { host: "x.example.com" }, { host: "y.example.com", ports: [443, 8443] }]);
  });

  it("builds the whole layer: the role's rules, and each other part from its feed, else as the sandbox has it", () => {
    const rules = { worker: [{ host: "registry.npmjs.org" }], manager: [] };
    // As `GET …/client-policy` answers a binding: held, with whose it is and its placeholder, which the PUT refuses.
    const binding = { name: "npm_token", secret: "npm", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" as const }] };
    const current = { egress: { allow: [{ host: "old.example.com" }] }, inject: [{ ...binding, client: "cli_app", placeholder: "nest-ph.cli_app.npm_token." }], env: { NPM_TOKEN: "nest-ph.cli_app.npm_token." } };
    expect(clientLayerFor(rules, "worker", {}, current)).toEqual({ egress: { allow: [{ host: "registry.npmjs.org" }] }, inject: [binding], env: current.env });
    expect(clientLayerFor(rules, "manager", { inject: [], env: { A: "1" } }, current)).toEqual({ egress: { allow: [] }, inject: [], env: { A: "1" } });
    expect(clientLayerFor(NO_RULES, "worker", {}, null)).toEqual({ egress: { allow: [] }, inject: [], env: {} });
  });
});

// --- Through the app ------------------------------------------------------------------------------------

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

async function setup() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, manager: p.settings.manager as string };
}
/** nest's name for a project's secret: `<project>-<name>-<generation>`, the generation new at each creation. */
const nestKey = (p: { id: string }, name: string) => [...fake.secrets.keys()].find((k) => new RegExp(`^${p.id}-${name}-[a-z0-9]{6}$`).test(k));
const sandboxOf = (agent: string) => fake.sandboxes.get(fake.agents.get(agent)!.sandbox!)!;
const drain = (id: string) => env.PROJECT.get(env.PROJECT.idFromName(id)).drain();

describe("the network page's API", () => {
  it("refuses a host outside the grant (403) and a malformed one (400), and keeps the rules as they were", async () => {
    const s = await setup();
    const out = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "evil.example.com" }], manager: [] });
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/the operator must widen the grant/);
    expect(out.body.problems).toHaveProperty("worker.evil.example.com");
    expect((await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "not a host" }], manager: [] })).status).toBe(400);
    const view = (await api(token, "GET", `/api/projects/${s.id}/network`)).body;
    expect(view.rules).toEqual({ worker: [], manager: [] });
    expect(view.egress_hosts).toEqual(fake.egressHosts);
  });

  it("shows the operator's rules from the manager's sandbox by nest's source: defaults, the operator's, the repo allowlists'; not the app's own or grants", async () => {
    const s = await setup();
    // The manager's sandbox becomes known once its layer is first applied. A rule the same as the
    // operator's is the operator's by its source, and the app's own as well.
    fake.operatorRules = [{ host: "mirror.internal.example", ports: [8443] }, { host: "nodejs.org" }];
    await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }, { host: "pypi.org", ports: [443] }] });
    const before = fake.callsTo("GET", /\/client-policy$/).length;
    const view = (await api(token, "GET", `/api/projects/${s.id}/network`)).body;
    expect(view.base).toEqual([
      { host: "github.com", ports: [443], source: "base" },
      { host: "mirror.internal.example", ports: [8443], source: "operator" },
      { host: "nodejs.org", ports: [80, 443], source: "operator" },
      { host: "api.github.com", ports: [443], source: "repos" },
    ]);
    // With `source`, the client's own layer isn't read to tell them apart.
    expect(fake.callsTo("GET", /\/client-policy$/).length).toBe(before);
  });

  it("falls back, on a control plane without source, to the layers less the app's own rules", async () => {
    const s = await setup();
    fake.legacyPolicy = true;
    try {
      fake.operatorRules = [{ host: "mirror.internal.example", ports: [8443] }, { host: "nodejs.org" }];
      await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }, { host: "pypi.org", ports: [443] }] });
      const view = (await api(token, "GET", `/api/projects/${s.id}/network`)).body;
      // There the repo allowlists' rules can't be told from the operator's, and one of two equal rules is the app's.
      expect(view.base).toEqual([
        { host: "github.com", ports: [443], source: "base" },
        { host: "mirror.internal.example", ports: [8443], source: "operator" },
        { host: "api.github.com", ports: [443], source: "operator" },
        { host: "nodejs.org", ports: [80, 443], source: "operator" },
      ]);
    } finally {
      fake.legacyPolicy = false;
    }
  });
});

describe("applying the rules", () => {
  it("new workers get their role's rules at their sandbox's create", async () => {
    const s = await setup();
    expect((await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "registry.npmjs.org" }, { host: "pypi.org", ports: [443] }], manager: [] })).status).toBe(200);
    const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "t" })).body.id;
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${t}/spec`, spec);
    const worker = (await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/assign`)).body.assignee as string;
    const create = fake.callsTo("POST", /^\/v1\/sandboxes$/).find((c) => c.body.labels?.task === t)!;
    expect(create.body.egress).toEqual({ allow: [{ host: "registry.npmjs.org" }, { host: "pypi.org", ports: [443] }] });
    expect(sandboxOf(worker).layer.egress.allow).toEqual(create.body.egress.allow);
    // The manager's role had none: its sandbox's create carried no egress.
    expect(fake.callsTo("POST", /^\/v1\/sandboxes$/).find((c) => c.body.labels?.role === "manager" && c.body.labels?.project === s.id)!.body.egress).toBeUndefined();
  });

  it("live agents get them through their sandbox's client layer, which keeps its bindings and env", async () => {
    const s = await setup();
    const sb = sandboxOf(s.manager);
    // A secret of the manager's on the Secrets page: its binding and variable are in the layer.
    const secret = { value: "v-0123456789abcdef", description: "", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }], roles: ["manager"], env: "NPM_TOKEN" };
    expect((await api(token, "PUT", `/api/projects/${s.id}/secrets/npm_token`, secret)).status).toBe(200);
    await drain(s.id);
    const binding = { name: "npm_token", secret: nestKey(s, "npm_token")!, hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] };
    const vars = { NPM_TOKEN: `nest-ph.${CLIENT}.npm_token.` };
    const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] });
    expect(r.status).toBe(200);
    const put = fake.callsTo("PUT", /\/client-policy$/).at(-1)!;
    expect(put.path).toBe(`/v1/sandboxes/${sb.sandbox}/client-policy`);
    // Sent in the PUT's strict shape (nest refuses a held binding's `client` and `placeholder`), so it applied.
    expect(put.body).toEqual({ egress: { allow: [{ host: "nodejs.org" }] }, inject: [binding], env: vars });
    expect(sb.layer).toEqual({ egress: { allow: [{ host: "nodejs.org" }] }, inject: [binding], env: vars });
    expect(r.body.agents).toEqual([expect.objectContaining({ agent: s.manager, role: "manager", state: "applied", sandbox: sb.sandbox })]);
    // A change to the other role's rules writes nothing to this one's sandbox.
    const before = fake.callsTo("PUT", /\/client-policy$/).length;
    await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "pypi.org" }], manager: [{ host: "nodejs.org" }] });
    expect(fake.callsTo("PUT", /\/client-policy$/).length).toBe(before);
  });

  it("a network change on a live sandbox keeps the Secrets page's bindings and env, change after change", async () => {
    const s = await setup();
    // Two of the workers' secrets: one a header, one on a `*.` host (so `wildcard`).
    const put = (name: string, b: Record<string, unknown>) => api(token, "PUT", `/api/projects/${s.id}/secrets/${name}`, { value: `v-${name}-0123456789`, description: "", roles: ["worker"], ...b });
    expect((await put("npm_token", { hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }], env: "NPM_TOKEN" })).status).toBe(200);
    expect((await put("upload", { hosts: ["*.uploads.example.com"], locations: [{ type: "header", name: "X-Upload-Token" }, { type: "authorization_basic_password" }], env: "UPLOAD_TOKEN" })).status).toBe(200);
    const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "t" })).body.id;
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${t}/spec`, spec);
    const worker = (await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/assign`)).body.assignee as string;
    const sb = sandboxOf(worker);
    const bindings = [
      { name: "npm_token", secret: nestKey(s, "npm_token")!, hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] },
      { name: "upload", secret: nestKey(s, "upload")!, hosts: ["*.uploads.example.com"], locations: [{ type: "header", name: "X-Upload-Token" }, { type: "authorization_basic_password" }], wildcard: true },
    ];
    const vars = { NPM_TOKEN: `nest-ph.${CLIENT}.npm_token.`, UPLOAD_TOKEN: `nest-ph.${CLIENT}.upload.` };
    expect(sb.layer).toEqual({ egress: { allow: [] }, inject: bindings, env: vars });
    for (const worker_rules of [[{ host: "pypi.org" }], [{ host: "nodejs.org", ports: [443] }], []]) {
      const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: worker_rules, manager: [] });
      expect(r.status).toBe(200);
      expect(fake.callsTo("PUT", new RegExp(`/v1/sandboxes/${sb.sandbox}/client-policy$`)).at(-1)!.body).toEqual({ egress: { allow: worker_rules }, inject: bindings, env: vars });
      expect(sb.layer).toEqual({ egress: { allow: worker_rules }, inject: bindings, env: vars });
      expect(r.body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: worker, state: "applied", error: null })]));
    }
  });

  it("a refusal that will repeat shows as failed, not retried; a transient one stays pending and goes on", async () => {
    const s = await setup();
    // nest's grant narrowed since the app's check: nest refuses the write (403).
    const grant = [...fake.egressHosts];
    fake.egressHosts = ["registry.npmjs.org"];
    try {
      const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "registry.npmjs.org" }, { host: "nodejs.org" }] });
      // The app's own check read the narrowed grant too: refused before anything was written.
      expect(r.status).toBe(403);
    } finally {
      fake.egressHosts = grant;
    }
    // Accepted by the app, refused by nest (the fake's grant narrowed only for the write).
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403, { times: 2 });
    let r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] });
    expect(r.body.agents).toEqual([expect.objectContaining({ agent: s.manager, state: "failed", error: expect.stringContaining("403") })]);
    // A transient failure: pending, then applied on the next try.
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 503);
    r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "pypi.org" }] });
    expect(r.body.agents[0].state).toBe("pending");
    // Its retry, due now.
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(s.id)), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE layers SET next_ms = 0 WHERE next_ms IS NOT NULL");
    });
    await drain(s.id);
    r = await api(token, "GET", `/api/projects/${s.id}/network`);
    expect(r.body.agents[0]).toMatchObject({ state: "applied" });
    expect(sandboxOf(s.manager).layer.egress.allow).toEqual([{ host: "pypi.org" }]);
  });
});

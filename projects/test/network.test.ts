// A project's network rules (README.md#network): per role, within the grant's egress_hosts (refused
// outside it); new agents get them at their sandbox's create, live ones through their sandbox's client
// layer, which `clientLayerFor` builds whole, keeping what the other pages put there. The pure parts first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { clientLayerFor, hostAllowed, NO_RULES, normalizeRules, rulesProblems } from "../src/network";
import { env, runInDurableObject } from "cloudflare:test";
import { AccessTeam, api, CLIENT, FakeNest, installFetch } from "./fake-nest";

describe("the rules (pure)", () => {
  it("refuses hosts outside the grant, saying the operator must add them; and malformed rules", () => {
    const grant = ["registry.npmjs.org", "*.pythonhosted.org"];
    expect(rulesProblems([{ host: "registry.npmjs.org" }, { host: "files.pythonhosted.org", ports: [443] }], grant)).toEqual({});
    expect(rulesProblems([{ host: "nodejs.org" }], grant)["nodejs.org"]).toMatch(/^nodejs.org isn't in this app's grant; the operator must add it$/);
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
const sandboxOf = (agent: string) => fake.sandboxes.get(fake.agents.get(agent)!.sandbox!)!;
const drain = (id: string) => env.PROJECT.get(env.PROJECT.idFromName(id)).drain();

describe("the network page's API", () => {
  it("refuses a host outside the grant (403) and a malformed one (400), and keeps the rules as they were", async () => {
    const s = await setup();
    const out = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "evil.example.com" }], manager: [] });
    expect(out.status).toBe(403);
    expect(out.body.error).toMatch(/isn't in this app's grant; the operator must add it/);
    expect(out.body.problems).toHaveProperty("worker.evil.example.com");
    expect((await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "not a host" }], manager: [] })).status).toBe(400);
    const view = (await api(token, "GET", `/api/projects/${s.id}/network`)).body;
    expect(view.rules).toEqual({ worker: [], manager: [] });
    expect(view.egress_hosts).toEqual(fake.egressHosts);
  });

  it("after the operator narrows the grant, a save that removes or keeps rules goes through; the revoked host is kept but not applied", async () => {
    const s = await setup();
    const sb = sandboxOf(s.manager);
    expect((await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "pypi.org" }], manager: [{ host: "nodejs.org" }, { host: "pypi.org" }] })).status).toBe(200);
    const was = [...fake.egressHosts];
    fake.egressHosts = was.filter((h) => h !== "nodejs.org");
    try {
      // Dropping pypi.org while the revoked nodejs.org stays: not refused (it was there already).
      const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] });
      expect(r.status).toBe(200);
      expect(r.body.rules).toEqual({ worker: [], manager: [{ host: "nodejs.org" }] });
      // The narrowing reached the live layer: what's still in the grant (here nothing), never the revoked host.
      await drain(s.id);
      expect(sb.layer.egress.allow).toEqual([]);
      expect(fake.callsTo("PUT", new RegExp(`/v1/sandboxes/${sb.sandbox}/client-policy$`)).at(-1)!.body.egress).toEqual({ allow: [] });
      // A host newly added outside the grant is still refused, whole.
      const added = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "nodejs.org" }], manager: [{ host: "nodejs.org" }] });
      expect(added.status).toBe(403);
      expect(added.body.problems).toEqual({ "worker.nodejs.org": "nodejs.org isn't in this app's grant; the operator must add it" });
      // A new worker's sandbox is made with the granted rules only.
      expect((await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }, { host: "pypi.org" }] })).status).toBe(200);
    } finally {
      fake.egressHosts = was;
    }
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
    sb.layer = { egress: { allow: [] }, inject: [{ name: "npm_token", secret: "x", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] }], env: { NPM_TOKEN: "nest-ph.cli_app.npm_token." } };
    const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] });
    expect(r.status).toBe(200);
    const put = fake.callsTo("PUT", /\/client-policy$/).at(-1)!;
    expect(put.path).toBe(`/v1/sandboxes/${sb.sandbox}/client-policy`);
    expect(put.body).toEqual({ egress: { allow: [{ host: "nodejs.org" }] }, inject: sb.layer.inject, env: { NPM_TOKEN: "nest-ph.cli_app.npm_token." } });
    expect(sb.layer.egress.allow).toEqual([{ host: "nodejs.org" }]);
    expect(r.body.agents).toEqual([expect.objectContaining({ agent: s.manager, role: "manager", state: "applied", sandbox: sb.sandbox })]);
    // A change to the other role's rules writes nothing to this one's sandbox.
    const before = fake.callsTo("PUT", /\/client-policy$/).length;
    await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: [{ host: "pypi.org" }], manager: [{ host: "nodejs.org" }] });
    expect(fake.callsTo("PUT", /\/client-policy$/).length).toBe(before);
  });

  it("a network change on a live sandbox keeps the Secrets page's bindings and env, change after change", async () => {
    const s = await setup();
    const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "t" })).body.id;
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${t}/spec`, spec);
    const worker = (await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/assign`)).body.assignee as string;
    const sb = sandboxOf(worker);
    // What the Secrets page (#133) puts in a worker's layer: bindings `{name, secret, hosts, locations}` (one
    // a header, one `*.` with wildcard) and env carrying their placeholders, `nest-ph.<client>.<name>.`.
    const bindings = [
      { name: "npm_token", secret: "npm", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] },
      { name: "pypi", secret: "pypi_upload", hosts: ["*.pythonhosted.org"], locations: [{ type: "header", name: "X-Upload-Token" }, { type: "authorization_basic_password" }], wildcard: true },
    ];
    const vars = { NPM_TOKEN: `nest-ph.${CLIENT}.npm_token.`, PYPI_TOKEN: `nest-ph.${CLIENT}.pypi.`, CI: "1" };
    sb.layer = { egress: { allow: [{ host: "registry.npmjs.org" }] }, inject: structuredClone(bindings), env: { ...vars } };
    for (const worker_rules of [[{ host: "pypi.org" }], [{ host: "nodejs.org", ports: [443] }], []]) {
      const r = await api(token, "PUT", `/api/projects/${s.id}/network`, { worker: worker_rules, manager: [] });
      expect(r.status).toBe(200);
      // Sent in the PUT's strict shape (nest refuses a held binding's `client` and `placeholder`), so it applied.
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
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403);
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

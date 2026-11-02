// API clients (docs/control-plane/api/clients/): a client's token, its grant (the ceiling of everything in
// its subtree), its subtree (everything else is 404), labels, and its catalog namespace. The pure checks
// first, then each through the Worker and the Durable Objects.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { ClientDO } from "../src/do/client";
import { RESERVE_CHECK_MS } from "../src/do/client";
import {
  capabilityOutsideGrant, entryVisible, Grant, Labels, labelsMatch, mcpUrlAllowed, newClientToken, parseClientToken, parseLabelFilters, specOutsideGrant,
  tokenHash,
} from "../src/lib/clients";
import { expandSpec, mcpPrefix } from "../src/lib/spec";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const clientStub = (id: string) => env.CLIENT.get(env.CLIENT.idFromName(id));

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const res = await as(token, path, init);
  const text = await res.text();
  if (status !== undefined) expect(res.status, `${path}: ${text}`).toBe(status);
  else expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
/** A template a client may write: no hands, the default credential. */
const basic = (extra: Record<string, unknown> = {}) => ({ capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token", ...extra });

/** A client named `<prefix>-<rand>` with a grant on a fresh cell (`grant` overrides), and a `basic` template in its namespace. */
async function newClient(grant: Record<string, unknown> = {}, prefix = "c") {
  const cell = uniqueCell();
  const name = `${prefix}-${rand()}`;
  const g = { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 10, max_sandboxes: 10, ...grant };
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: g } }, 201);
  await asJson(c.token, `/v1/catalog/templates/${name}/basic`, { method: "PUT", body: basic() });
  return { id: c.client as string, name, token: c.token as string, cell, tpl: `${name}/basic` };
}
type Client = Awaited<ReturnType<typeof newClient>>;

const createAgent = (c: Client, body: Record<string, unknown> = {}, status = 201) =>
  asJson(c.token, "/v1/agents", { body: { template: c.tpl, cell: c.cell, start: false, ...body } }, status);

// --- Pure ------------------------------------------------------------------------------------------------

describe("grants, tokens and labels (pure)", () => {
  const grant = Grant.parse({
    cells: ["c1"], credentials: ["claude_oauth_token", "cap:board"], repos: ["Acme/App"],
    mcp_urls: ["https://board.example.com/mcp", "https://tools.example.com/v1/"],
  });

  it("an mcp URL is in the grant exactly, or under an entry ending in /", () => {
    expect(mcpUrlAllowed(grant, "https://board.example.com/mcp")).toBe(true);
    expect(mcpUrlAllowed(grant, "https://tools.example.com/v1/x/mcp")).toBe(true);
    // An exact entry is not a prefix, and a prefix is whole segments of one origin.
    expect(mcpUrlAllowed(grant, "https://board.example.com/mcp/x")).toBe(false);
    expect(mcpUrlAllowed(grant, "https://board.example.com/mcpx")).toBe(false);
    expect(mcpUrlAllowed(grant, "https://tools.example.com/v10/mcp")).toBe(false);
    expect(mcpUrlAllowed(grant, "https://tools.example.com.evil.net/v1/mcp")).toBe(false);
    expect(mcpUrlAllowed(grant, "https://tools.example.com/v1/../admin")).toBe(false);
    // A grant entry must be canonical, so an exact one can't become a prefix by normalization.
    expect(Grant.safeParse({ mcp_urls: ["https://board.example.com"] }).success).toBe(false);
    expect(Grant.safeParse({ mcp_urls: ["https://u:p@board.example.com/mcp"] }).success).toBe(false);
    expect(Grant.safeParse({ unknown_field: 1 }).success).toBe(false);
  });

  it("a spec is outside the grant by its credential, mcp servers and their secrets, repos, and brokered actions", () => {
    const within = { credential: "claude_oauth_token", repos: ["acme/app"] };
    expect(specOutsideGrant(within, grant)).toEqual([]);
    expect(specOutsideGrant({ ...within, credential: "claude_oauth_token:worker" }, grant)).toEqual(["credential claude_oauth_token:worker"]);
    expect(specOutsideGrant({ ...within, repos: ["acme/app", "acme/other"] }, grant)).toEqual(["repos acme/other"]);
    const mcp = (url: string, auth: string, client?: string) => ({
      capability: "x", url, auth, tools: null, idempotent: {}, trusted: false, ...(client ? { oauth: { client, scopes: null } } : {}),
    });
    expect(specOutsideGrant({ ...within, mcp: [mcp("https://board.example.com/mcp", "cap:board")] }, grant)).toEqual([]);
    expect(specOutsideGrant({ ...within, mcp: [mcp("https://evil.example.com/mcp", "cap:board")] }, grant)).toHaveLength(1);
    expect(specOutsideGrant({ ...within, mcp: [mcp("https://board.example.com/mcp", "cap:github")] }, grant)).toEqual(["credential cap:github (x)"]);
    expect(specOutsideGrant({ ...within, mcp: [mcp("https://board.example.com/mcp", "cap:board", "cap:other-client")] }, grant)).toHaveLength(1);
    const gh = (action: string, repos: string[] | null) => ({ capability: "b", action, repos, when_tainted: "approve", per_hour: 30 }) as any;
    expect(specOutsideGrant({ ...within, brokered: [gh("github.comment", ["acme/app"])] }, grant)).toEqual([]);
    expect(specOutsideGrant({ ...within, brokered: [gh("github.comment", null)] }, grant)).toHaveLength(1);
    expect(specOutsideGrant({ ...within, brokered: [gh("github.comment", ["acme/other"])] }, grant)).toHaveLength(1);
    expect(specOutsideGrant({ ...within, brokered: [gh("github.fork", ["acme/app"])] }, grant)).toHaveLength(1);
    expect(specOutsideGrant({ ...within, brokered: [{ capability: "h", action: "http.request" } as any] }, grant)).toHaveLength(1);
    // A capability on its own, as a client writes it.
    expect(capabilityOutsideGrant("n/x", { tools: [], rules: [], prompt: "", mcp: { url: "https://board.example.com/mcp", auth: "cap:board" } as any }, grant)).toEqual([]);
    expect(capabilityOutsideGrant("n/x", { tools: [], rules: [], prompt: "", mcp: { url: "https://board.example.com/mcp", auth: { oauth: "cap:board", client: "cap:z" } } as any }, grant))
      .toEqual(["credential cap:z"]);
  });

  it("a client token names its client; anything else is no client token", async () => {
    const t = newClientToken("cli_abc123");
    expect(parseClientToken(t)).toMatchObject({ client: "cli_abc123" });
    expect(parseClientToken(`${t}0`)).toBeNull();
    expect(parseClientToken("nest_cli_abc_short")).toBeNull();
    expect(parseClientToken("test-admin-token")).toBeNull();
    expect(await tokenHash(t)).not.toBe(await tokenHash(newClientToken("cli_abc123")));
  });

  it("labels: keys, values and count are bounded; filters are key=value and all must hold", () => {
    expect(Labels.safeParse({ project: "x", "a.b_c-d": "" }).success).toBe(true);
    for (const bad of [{ Project: "x" }, { "1x": "x" }, { "x/y": "x" }, { ["k".repeat(64)]: "x" }, { k: "v".repeat(257) }]) {
      expect(Labels.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
    expect(Labels.safeParse(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"]))).success).toBe(true);
    expect(Labels.safeParse(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))).success).toBe(false);
    expect(parseLabelFilters(["project=a=b", "x="])).toEqual([["project", "a=b"], ["x", ""]]);
    expect(() => parseLabelFilters(["=x"])).toThrow();
    expect(() => parseLabelFilters(["X=y"])).toThrow();
    expect(labelsMatch({ a: "1", b: "2" }, [["a", "1"], ["b", "2"]])).toBe(true);
    expect(labelsMatch({ a: "1" }, [["a", "1"], ["b", "2"]])).toBe(false);
  });

  it("a client sees the operator's entries and its own namespace; an mcp capability's tools take its name with - for /", () => {
    expect(entryVisible("worker", "board")).toBe(true);
    expect(entryVisible("board/x", "board")).toBe(true);
    expect(entryVisible("other/x", "board")).toBe(false);
    expect(entryVisible("other/x", null)).toBe(true);
    expect(mcpPrefix("board/tasks")).toBe("board-tasks");
    // Two capabilities whose tools would share names are refused at expansion.
    const mcpCap = { tools: [], rules: [], prompt: "", mcp: { url: "https://a.example.com/mcp", auth: "cap:a", trusted: false, when_tainted: "approve" } } as any;
    const r = expandSpec({ capabilities: { "board-tasks": mcpCap, "board/tasks": mcpCap }, templates: { t: basic({ capabilities: ["board-tasks", "board/tasks"] }) as any } },
      PLATFORM_TOOL_NAMES, { template: "t", hands: false, by: "operator" });
    expect(r).toMatchObject({ ok: false });
  });
});

// --- Tokens and the operator's routes ---------------------------------------------------------------------

describe("clients and their tokens", () => {
  it("shows the token once, keeps only its hash, and refuses a wrong secret, a rotated token and a deleted client's", async () => {
    const c = await newClient();
    expect((await as(c.token, "/v1/agents")).status).toBe(200);
    const view = await adminJson(`/v1/admin/clients/${c.id}`);
    expect(view).toMatchObject({ client: c.id, name: c.name, live: { agents: 0, sandboxes: 0 } });
    expect(JSON.stringify(view)).not.toContain(c.token.slice(-64));
    expect(JSON.stringify(view)).not.toContain("hash");
    // The same client id with another secret.
    const forged = `${c.token.slice(0, -64)}${"a".repeat(64)}`;
    expect((await as(forged, "/v1/agents")).status).toBe(401);
    // A client token is never the admin token.
    expect((await as(c.token, "/v1/admin/catalog")).status).toBe(401);

    const rotated = await adminJson(`/v1/admin/clients/${c.id}/rotate`, { method: "POST" });
    expect((await as(c.token, "/v1/agents")).status).toBe(401);
    expect((await as(rotated.token, "/v1/agents")).status).toBe(200);
    expect(rotated.rotated_ms).toBeGreaterThan(0);

    // Names are unique.
    expect((await adminJson("/v1/admin/clients", { body: { name: c.name, grant: {} } }, 409)).error.code).toBe("conflict");
    expect((await adminJson("/v1/admin/clients")).clients.map((x: any) => x.client)).toContain(c.id);

    const del = await adminJson(`/v1/admin/clients/${c.id}`, { method: "DELETE" });
    expect(del).toMatchObject({ deleted: c.id, catalog_entries: 1 });
    expect((await as(rotated.token, "/v1/agents")).status).toBe(401);
    expect((await adminJson("/v1/admin/catalog")).templates[c.tpl]).toBeUndefined();
    // The name is free again.
    await adminJson("/v1/admin/clients", { body: { name: c.name, grant: {} } }, 201);
  });

  it("a delete is refused while its subtree lives", async () => {
    const c = await newClient();
    const a = await createAgent(c);
    expect((await adminJson(`/v1/admin/clients/${c.id}`, { method: "DELETE" }, 409)).error.message).toContain("1 live agents");
    expect((await as(c.token, "/v1/agents")).status).toBe(200);
    await asJson(c.token, `/v1/agents/${a.agent}/stop`, { body: { end: true } });
    await eventually("the end reported to the client", async () => (await adminJson(`/v1/admin/clients/${c.id}`)).live.agents === 0);
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "DELETE" });
  });

  it("PATCH replaces the grant; a grant naming a cell outside CELLS or with an unknown field is refused", async () => {
    const c = await newClient();
    const v = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], max_agents: 0 } } });
    expect(v.grant).toMatchObject({ cells: [c.cell], max_agents: 0, credentials: [] });
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: ["Bad Cell"] } } }, 400);
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { widen: true } } }, 400);
  });
});

// --- The subtree ----------------------------------------------------------------------------------------

describe("a client acts only on its subtree", () => {
  it("another client's agent and sandbox, and the operator's, answer exactly as ids that never existed", async () => {
    const a = await newClient();
    const b = await newClient({ cells: [a.cell] });
    const mine = await createAgent(a, { labels: { project: "p1" } });
    expect(mine).toMatchObject({ client: a.id, owner: a.id, labels: { project: "p1" } });
    const operators = await adminJson("/v1/agents", { body: { template: "captain", cell: a.cell, start: false } }, 201);
    const never = "agt_0000000000nevernevernever";

    const probe = async (token: string, id: string) => {
      const out: Record<string, unknown> = {};
      for (const [m, path, body] of [
        ["GET", `/v1/agents/${id}`], ["GET", `/v1/agents/${id}/turns`], ["GET", `/v1/agents/${id}/transcript`], ["GET", `/v1/agents/${id}/asks`],
        ["GET", `/v1/agents/${id}/children`], ["GET", `/v1/agents/${id}/brokered`],
        ["POST", `/v1/agents/${id}/inbox`, { text: "hi" }], ["POST", `/v1/agents/${id}/turns`, { text: "hi" }], ["POST", `/v1/agents/${id}/interrupt`],
        ["POST", `/v1/agents/${id}/stop`, { end: true }], ["POST", `/v1/agents/${id}/start`], ["POST", `/v1/agents/${id}/asks/ask_x/answer`, { answer: "yes" }],
      ] as [string, string, unknown?][]) {
        const res = await as(token, path, { method: m, ...(body ? { body } : m === "POST" ? { body: {} } : {}) });
        out[`${m} ${path.replace(id, "<id>")}`] = [res.status, await res.json()];
      }
      return out;
    };
    const nothing = await probe(b.token, never);
    for (const v of Object.values(nothing)) expect(v).toEqual([404, { error: { code: "unknown_agent", message: "unknown agent", retryable: false } }]);
    expect(await probe(b.token, mine.agent)).toEqual(nothing);
    expect(await probe(a.token, operators.agent)).toEqual(nothing);
    // Its own answers; it can't name another's as an owner either.
    expect((await asJson(a.token, `/v1/agents/${mine.agent}`)).agent).toBe(mine.agent);
    expect((await createAgent(b, { owner: mine.agent }, 404)).error.code).toBe("unknown_agent");
    // The operator sees every one.
    expect((await adminJson(`/v1/agents/${mine.agent}`)).client).toBe(a.id);

    const sbx = await asJson(a.token, "/v1/sandboxes", { body: { cell: a.cell } }, 202);
    expect(sbx).toMatchObject({ client: a.id });
    for (const [m, path, body] of [["GET", ""], ["GET", "/policy"], ["DELETE", ""], ["PUT", "/lifetime", { idle_ttl_ms: null }]] as [string, string, unknown?][]) {
      const res = await as(b.token, `/v1/sandboxes/${sbx.sandbox}${path}`, { method: m, ...(body ? { body } : {}) });
      expect([res.status, (await res.json<any>()).error?.code], `${m} ${path}`).toEqual([404, "unknown_sandbox"]);
    }
    expect((await createAgent(b, { template: b.tpl, sandbox: sbx.sandbox }, 404)).error.code).toBe("unknown_sandbox");
    expect((await asJson(a.token, `/v1/sandboxes/${sbx.sandbox}`)).sandbox).toBe(sbx.sandbox);

    // Listings hold only its own.
    expect((await asJson(b.token, "/v1/agents")).agents).toEqual([]);
    expect((await asJson(a.token, "/v1/agents")).agents.map((x: any) => x.agent)).toEqual([mine.agent]);
    expect((await asJson(a.token, "/v1/sandboxes")).sandboxes.map((x: any) => x.sandbox)).toEqual([sbx.sandbox]);
    expect((await asJson(b.token, `/v1/agents?client=${a.id}`)).agents).toEqual([]);
  });

  it("refuses the operator's levers: policy layers, a brain's host, rules, share links", async () => {
    const c = await newClient();
    expect((await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell, policy: { allow: [{ host: "evil.example.com" }] } } }, 403)).error.code).toBe("forbidden");
    const a = await createAgent(c);
    expect((await asJson(c.token, `/v1/agents/${a.agent}/start`, { body: { host: "hst_x" } }, 403)).error.code).toBe("forbidden");
    expect((await as(c.token, `/v1/agents/${a.agent}/rules`, { method: "PUT", body: [] })).status).toBe(401);
    // Overrides only narrow, as an agent's spawn: no credential, launch or rules of its own.
    await createAgent(c, { overrides: { credential: "claude_oauth_token:captain" } }, 400);
    await createAgent(c, { launch: LAUNCH }, 400);
  });

  it("a client's inbox post is trusted as its own, and taints under another name", async () => {
    const c = await newClient();
    const a = await createAgent(c);
    await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "from me" } }, 201);
    const tainted = () => runInDurableObject(agentStub(a.agent), (i: AgentDO) => (i as any).tainted((i as any).load()) as boolean);
    expect(await tainted()).toBe(false);
    await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "relayed", from: "someone" } }, 201);
    expect(await tainted()).toBe(true);
  });
});

// --- The grant -----------------------------------------------------------------------------------------

describe("the grant bounds everything in the subtree", () => {
  it("refuses a cell, a credential and repos outside it, through the client's templates and the operator's", async () => {
    const c = await newClient({ repos: ["acme/app"] });
    // A cell not in the grant.
    expect((await createAgent(c, { cell: uniqueCell() }, 403)).error.message).toContain("cell");
    // The operator's captain runs on claude_oauth_token:captain, which the grant doesn't name.
    expect((await createAgent(c, { template: "captain" }, 403)).error.message).toContain("credential claude_oauth_token:captain");
    // Another client's namespace isn't visible.
    const other = await newClient();
    expect((await createAgent(c, { template: other.tpl }, 400)).error.message).toContain("unknown template");
    // Repos: a template naming one outside is refused when written; a narrower one spawns.
    expect((await asJson(c.token, `/v1/catalog/templates/${c.name}/wide`, { method: "PUT", body: basic({ repos: ["acme/app", "acme/secret"] }) }, 403)).error.message)
      .toContain("repos acme/secret");
    await asJson(c.token, `/v1/catalog/templates/${c.name}/pusher`, { method: "PUT", body: basic({ repos: ["Acme/App"] }) });
    expect((await createAgent(c, { template: `${c.name}/pusher` })).repos).toEqual(["acme/app"]);
    // An entry the operator wrote into the namespace is held to the same grant at spawn.
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token"], max_agents: 10 } } });
    expect((await createAgent(c, { template: `${c.name}/pusher` }, 403)).error.message).toContain("repos acme/app");
  });

  it("mcp capabilities: the URL in mcp_urls and its auth in credentials, when written and again at spawn", async () => {
    const c = await newClient({ mcp_urls: ["https://board.example.com/"], credentials: ["claude_oauth_token", "cap:board"] });
    const cap = (url: string, auth = "cap:board") => ({ mcp: { url, auth } });
    expect((await asJson(c.token, `/v1/catalog/capabilities/${c.name}/tasks`, { method: "PUT", body: cap("https://evil.example.com/mcp") }, 403)).error.message)
      .toContain("mcp url");
    // The operator's secret for another server, pointed at the client's own: refused.
    expect((await asJson(c.token, `/v1/catalog/capabilities/${c.name}/tasks`, { method: "PUT", body: cap("https://board.example.com/mcp", "cap:github") }, 403)).error.message)
      .toContain("credential cap:github");
    await asJson(c.token, `/v1/catalog/capabilities/${c.name}/tasks`, { method: "PUT", body: cap("https://board.example.com/mcp") });
    await asJson(c.token, `/v1/catalog/templates/${c.name}/boarder`, { method: "PUT", body: basic({ capabilities: ["nest", `${c.name}/tasks`] }) });
    const a = await createAgent(c, { template: `${c.name}/boarder` });
    expect(a.mcp).toEqual([expect.objectContaining({ capability: `${c.name}-tasks`, url: "https://board.example.com/mcp" })]);
    // Narrowed: the same template no longer spawns.
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token", "cap:board"], max_agents: 10 } } });
    expect((await createAgent(c, { template: `${c.name}/boarder` }, 403)).error.message).toContain("mcp url");
  });

  it("max_agents and max_sandboxes count the whole subtree: parallel creates can't pass them, and an end or a destroy frees a place", async () => {
    const c = await newClient({ max_agents: 2, max_sandboxes: 1 });
    const results = await Promise.all(Array.from({ length: 5 }, () => as(c.token, "/v1/agents", { body: { template: c.tpl, cell: c.cell, start: false } })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 403, 403, 403]);
    const made = (await asJson(c.token, "/v1/agents")).agents;
    expect(made).toHaveLength(2);
    expect((await createAgent(c, {}, 403)).error.message).toContain("max_agents");

    await asJson(c.token, `/v1/agents/${made[0].agent}/stop`, { body: { end: true } });
    await eventually("the ended agent's place", async () => (await adminJson(`/v1/admin/clients/${c.id}`)).live.agents === 1);
    await createAgent(c);

    const s1 = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
    await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 403);
    await asJson(c.token, `/v1/sandboxes/${s1.sandbox}`, { method: "DELETE" });
    await eventually("the destroyed sandbox's place", async () => (await adminJson(`/v1/admin/clients/${c.id}`)).live.sandboxes === 0);
    await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
  });

  it("a reservation whose create never happened is dropped by the reconcile; one whose object exists stays counted", async () => {
    const c = await newClient({ max_agents: 2 });
    const real = await createAgent(c);
    const stub = clientStub(c.id);
    await stub.admit({ kind: "agent", id: "agt_neverneverneverneverneverx", cell: c.cell, owner: c.id, labels: {} });
    // `real` reported itself (its registry deadline); put it back to reserved, as if its report were lost.
    await eventually("the agent's report", async () => (await stub.list("agent")).items.find((m) => m.id === real.agent)?.state === "live");
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("UPDATE members SET state = 'reserved', created_ms = ?", Date.now() - RESERVE_CHECK_MS - 1);
    });
    expect((await createAgent(c, {}, 403)).error.message).toContain("max_agents");
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'reconcile'");
    });
    await runDue(stub);
    expect((await stub.list("agent", { state: "all" })).items.map((m) => [m.id, m.state])).toEqual([[real.agent, "live"]]);
    await createAgent(c);
  });
});

// --- Labels and listings -----------------------------------------------------------------------------------

describe("labels", () => {
  it("are validated, fixed at creation, shown, and filter both a client's listing and the cell's", async () => {
    const c = await newClient();
    for (const labels of [{ Bad: "x" }, { k: "v".repeat(257) }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))]) {
      await createAgent(c, { labels }, 400);
    }
    const x = await createAgent(c, { labels: { project: "x", "team.name": "a" } });
    const y = await createAgent(c, { labels: { project: "y" } });
    const z = await createAgent(c);
    expect(z.labels).toEqual({});
    const ids = async (path: string, token = c.token) => (await asJson(token, path)).agents.map((a: any) => a.agent);
    expect(await ids("/v1/agents?label=project=x")).toEqual([x.agent]);
    expect(await ids("/v1/agents?label=project=x&label=team.name=a")).toEqual([x.agent]);
    expect(await ids("/v1/agents?label=project=x&label=team.name=b")).toEqual([]);
    expect(await ids("/v1/agents")).toEqual([x.agent, y.agent, z.agent]);
    await asJson(c.token, "/v1/agents?label=Project=x", {}, 400);
    // Paging.
    const p1 = await asJson(c.token, "/v1/agents?limit=2");
    expect(p1.agents).toHaveLength(2);
    expect((await asJson(c.token, `/v1/agents?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`)).agents.map((a: any) => a.agent)).toEqual([z.agent]);

    // The operator's agents carry labels too, and the cell's listing (FleetDO's registry, filled from each agent's alarm) filters by them.
    const op = await adminJson("/v1/agents", { body: { template: "captain", cell: c.cell, start: false, labels: { project: "x" } } }, 201);
    expect(op.labels).toEqual({ project: "x" });
    await eventually("the cell's registry", async () => (await ids(`/v1/agents?cell=${c.cell}&label=project=x`, "test-admin-token")).length === 2);
    expect(await ids(`/v1/agents?cell=${c.cell}&label=project=x`, "test-admin-token")).toEqual(expect.arrayContaining([x.agent, op.agent]));
    const rows = (await adminJson(`/v1/agents?cell=${c.cell}&label=project=x`)).agents;
    expect(rows.find((r: any) => r.agent === x.agent)).toMatchObject({ client: c.id, labels: { project: "x", "team.name": "a" } });
    expect(rows.find((r: any) => r.agent === op.agent)).toMatchObject({ client: null });
    expect(await ids(`/v1/agents?client=${c.id}&label=project=y`, "test-admin-token")).toEqual([y.agent]);

    // Sandboxes too.
    const s = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell, labels: { project: "x" } } }, 202);
    expect(s.labels).toEqual({ project: "x" });
    expect((await asJson(c.token, "/v1/sandboxes?label=project=x")).sandboxes.map((r: any) => r.sandbox)).toEqual([s.sandbox]);
    expect((await adminJson(`/v1/sandboxes?cell=${c.cell}&label=project=x`)).sandboxes.map((r: any) => r.sandbox)).toEqual([s.sandbox]);
  });

  it("an agent or sandbox stored before clients reads as the operator's, with no labels, and lists unfiltered only", async () => {
    const cell = uniqueCell();
    const a = await adminJson("/v1/agents", { body: { template: "captain", cell, start: false } }, 201);
    // The record as the previous release wrote it: no client, no labels fields.
    await runInDurableObject(agentStub(a.agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      delete info.client;
      delete info.labels;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    expect(await adminJson(`/v1/agents/${a.agent}`)).toMatchObject({ client: null, labels: {}, owner: null });
    // A registry row from before the columns: null client and labels.
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    await eventually("registered", async () => (await fleet.listRegistry("agent")).items.length === 1);
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE agent_registry SET client = NULL, labels = NULL");
    });
    expect((await adminJson(`/v1/agents?cell=${cell}`)).agents).toEqual([expect.objectContaining({ agent: a.agent, client: null, labels: {} })]);
    expect((await adminJson(`/v1/agents?cell=${cell}&label=project=x`)).agents).toEqual([]);
  });
});

// --- The catalog -------------------------------------------------------------------------------------------

describe("a client's catalog", () => {
  it("writes and reads only its own namespace, names only what it sees, and the operator writes any client's", async () => {
    const a = await newClient();
    const b = await newClient();
    expect((await asJson(a.token, `/v1/catalog/templates/${b.name}/x`, { method: "PUT", body: basic() }, 403)).error.code).toBe("forbidden");
    expect((await as(a.token, `/v1/catalog/templates/${b.name}/basic`)).status).toBe(403);
    expect((await as(a.token, `/v1/catalog/templates/${b.name}/basic`, { method: "DELETE" })).status).toBe(403);
    expect(await asJson(a.token, `/v1/catalog/templates/${a.name}/basic`)).toMatchObject({ hands: "forbidden" });
    // A capability or template naming another client's entry, or a spawn of one.
    await asJson(b.token, `/v1/catalog/capabilities/${b.name}/c`, { method: "PUT", body: { tools: ["read_transcript"] } });
    expect((await asJson(a.token, `/v1/catalog/templates/${a.name}/t`, { method: "PUT", body: basic({ capabilities: [`${b.name}/c`] }) }, 400)).error.message)
      .toContain(`unknown ${b.name}/c`);
    expect((await asJson(a.token, `/v1/catalog/capabilities/${a.name}/s`, { method: "PUT", body: { tools: ["agent_spawn"], spawn: [b.tpl] } }, 400)).error.message)
      .toContain(`unknown ${b.tpl}`);
    // Its view of the catalog: the operator's entries and its own.
    const cat = await asJson(a.token, "/v1/catalog");
    expect(Object.keys(cat.templates)).toEqual(expect.arrayContaining(["worker", "captain", a.tpl]));
    expect(Object.keys(cat.templates)).not.toContain(b.tpl);
    expect(Object.keys(cat.capabilities)).not.toContain(`${b.name}/c`);
    // The operator writes into a client's namespace (held to that client's grant), not into one no client has.
    await adminJson(`/v1/catalog/templates/${a.name}/ops`, { method: "PUT", body: basic() });
    await adminJson(`/v1/catalog/templates/${a.name}/ops2`, { method: "PUT", body: basic({ credential: "claude_oauth_token:captain" }) }, 403);
    await adminJson(`/v1/catalog/templates/nobody-${rand()}/x`, { method: "PUT", body: basic() }, 404);
    expect((await createAgent(a, { template: `${a.name}/ops` })).template).toBe(`${a.name}/ops`);
    await asJson(a.token, `/v1/catalog/templates/${a.name}/ops`, { method: "DELETE" });
    await createAgent(a, { template: `${a.name}/ops` }, 400);
  });
});

// --- agent_spawn in a client's subtree ------------------------------------------------------------------------

describe("agent_spawn in a client's subtree", () => {
  it("the child inherits the client and takes the spawner's labels; the grant and the subtree's count bound every spawn", async () => {
    const c = await newClient({ max_agents: 2, max_sandboxes: 0 });
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
    const brain = await connectHost(c.cell, "brain");
    await asJson(c.token, `/v1/catalog/capabilities/${c.name}/spawning`, { method: "PUT", body: { tools: ["agent_spawn"], spawn: [c.tpl, "captain"] } });
    await asJson(c.token, `/v1/catalog/templates/${c.name}/parent`, { method: "PUT", body: basic({ capabilities: ["nest", `${c.name}/spawning`] }) });
    const p = await asJson(c.token, "/v1/agents", { body: { template: `${c.name}/parent`, cell: c.cell, labels: { project: "parent" } } }, 201);
    const [start] = await nextCommands(brain.ws, (x) => x.type === "agent_start" && x.agent === p.agent);
    const ws = await Ws.connect(`/v1/agents/${p.agent}/session`, brain.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: p.agent, host: brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b" });
    await ws.next("hello_ack");
    let seq = 0;
    const run = async (args: Record<string, unknown>) => {
      const call = `cal_${rand()}`;
      ws.send({ type: "tool_call", seq: ++seq, call, turn: "trn_x", name: "agent_spawn", arguments: { task: "t", ...args } });
      return (await ws.next("tool_result", (m) => m.call === call, 8000)).outcome;
    };

    // Labels are validated.
    expect(await run({ template: c.tpl, labels: { Bad: "x" } })).toMatchObject({ status: "error", error: { code: "invalid_message" } });
    // An operator template outside the grant (captain's credential) is refused, whatever the capability's spawn list says.
    expect(await run({ template: "captain" })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    const ok = await run({ template: c.tpl, labels: { task: "t1" } });
    expect(ok.status, JSON.stringify(ok)).toBe("ok");
    const kid = ok.content.find((x: any) => x.type === "json").value.agent;
    expect(await agentStub(kid).info()).toMatchObject({ client: c.id, owner: p.agent, labels: { task: "t1" } });
    // The client sees and lists the child; its labels filter.
    expect((await asJson(c.token, `/v1/agents/${kid}`)).labels).toEqual({ task: "t1" });
    expect((await asJson(c.token, "/v1/agents?label=task=t1")).agents.map((a: any) => a.agent)).toEqual([kid]);
    // The subtree is at max_agents (parent and child): the next spawn is refused, as is a sandbox (max_sandboxes 0).
    expect(await run({ template: c.tpl })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect((await adminJson(`/v1/admin/clients/${c.id}`)).live.agents).toBe(2);
    ws.close();
  });
});

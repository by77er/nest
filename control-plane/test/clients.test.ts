// API clients (docs/control-plane/api/clients/): a client's token, its grant (the ceiling of everything in
// its subtree), its subtree (everything else is 404), labels, and its catalog namespace. The pure checks
// first, then each through the Worker and the Durable Objects.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { ClientDO } from "../src/do/client";
import { ClientDO as ClientDOClass, RESERVE_CHECK_MS } from "../src/do/client";
import { MEMBER_EVENTS, MEMBER_STATES, memberStep } from "../src/lib/members";
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
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));

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

  it("read_repos: a spec may read a repo in repos or read_repos, push only to repos; a grant stored before read_repos reads none", () => {
    const g2 = Grant.parse({ credentials: ["c"], repos: ["acme/app"], read_repos: ["Acme/Lib"] });
    const spec = (repos: string[], read_repos: string[]) => ({ credential: "c", repos, read_repos });
    expect(specOutsideGrant(spec(["acme/app"], ["acme/lib"]), g2)).toEqual([]);
    expect(specOutsideGrant(spec([], ["ACME/APP", "acme/lib"]), g2)).toEqual([]);
    // Reading is no licence to push.
    expect(specOutsideGrant(spec(["acme/lib"], []), g2)).toEqual(["repos acme/lib"]);
    expect(specOutsideGrant(spec([], ["acme/lib", "acme/secret"]), g2)).toEqual(["read_repos acme/secret"]);
    const { read_repos: _, ...old } = g2;
    expect(specOutsideGrant(spec([], ["acme/lib"]), old as never)).toEqual(["read_repos acme/lib"]);
    expect(specOutsideGrant(spec([], ["acme/app"]), old as never)).toEqual([]);
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
    // The name is held as a tombstone until the directory's sweep frees it (test/client-names.test.ts).
    expect(del.name_free_ms).toBeGreaterThan(Date.now());
    expect((await adminJson("/v1/admin/clients", { body: { name: c.name, grant: {} } }, 409)).error.message).toContain("was deleted");
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

  // Who a post says it is from (docs/control-plane/api/clients/#inbox-senders).
  const turnTexts = async (agent: string) =>
    ((await adminJson(`/v1/agents/${agent}/turns`)) as { input: { text: string } }[]).map((t) => t.input.text);
  const setQuiet = (agent: string) => runInDurableObject(agentStub(agent), (i: AgentDO) => (i as any).update((x: any) => { x.stop_quiet = true; }));
  const quiet = async (agent: string) => (await agentStub(agent).info()).stop_quiet === true;

  it("a client can't claim nest's senders: system, timer, the operator's, or any principal's id (403); nest and the operator still can", async () => {
    const c = await newClient();
    const other = await newClient();
    const a = await createAgent(c);
    for (const from of ["system", "System", "TIMER", "timer", "user", "agt_01jb7n5c0p", "relay of agt_x", other.id, "sbx_1", "hst_1"]) {
      const r = await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "hi", from } }, 403);
      expect(r.error.message, from).toContain("nest's senders");
    }
    // Malformed: what could forge a spawner's name (`<template>:<agent>`), the via mark, or a message header.
    for (const from of ["", "worker:agt_x", "x (via client cli_y)", "a\n[message from system]", " lead", "x".repeat(65)]) {
      await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "hi", from } }, 400);
    }
    expect(await turnTexts(a.agent)).toEqual([]);
    // The operator names any sender, and nest's own posts go on as they did: a note, a fired timer.
    await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "op", from: "system" } }, 201);
    await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "op2", from: "worker:agt_x" } }, 201);
    await runInDurableObject(agentStub(a.agent), async (i: AgentDO) => {
      await (i as any).systemNote("a note");
      await i.postInbox("timer", "fired");
    });
    expect(await turnTexts(a.agent)).toEqual(["Message from system: op", "Message from worker:agt_x: op2", "Message from system: a note", "Message from timer: fired"]);
  });

  it("a client's post says which client sent it: its own id, or its label marked (via client <id>)", async () => {
    const c = await newClient();
    const a = await createAgent(c);
    await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "mine" } }, 201);
    await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "self", from: c.id } }, 201);
    await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "relayed", from: "projects/board" } }, 201);
    expect(await turnTexts(a.agent)).toEqual([
      `Message from ${c.id}: mine`, `Message from ${c.id}: self`, `Message from projects/board (via client ${c.id}): relayed`,
    ]);
  });

  it("every post through the API is input, whatever it says it is from; only nest's own notes aren't", async () => {
    const c = await newClient();
    const a = await createAgent(c);
    await setQuiet(a.agent);
    await runInDurableObject(agentStub(a.agent), (i: AgentDO) => (i as any).systemNote("moved"));
    expect(await quiet(a.agent)).toBe(true);
    await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "x", from: "system" } }, 201);
    expect(await quiet(a.agent)).toBe(false);
  });

  it("an ended agent refuses every post (404), a client's, the operator's under any sender, and a spawner's; nest's notes are dropped", async () => {
    const c = await newClient();
    const a = await createAgent(c);
    await asJson(c.token, `/v1/agents/${a.agent}/stop`, { body: { end: true } });
    await eventually("the end", async () => (await agentStub(a.agent).info()).ended);
    expect((await asJson(c.token, `/v1/agents/${a.agent}/inbox`, { body: { text: "hi" } }, 404)).error.message).toContain("has ended");
    for (const from of [undefined, "system", "timer"]) {
      expect((await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "hi", ...(from ? { from } : {}) } }, 404)).error.code).toBe("unknown_agent");
    }
    const spawner = await runInDurableObject(agentStub(a.agent), (i: AgentDO) => i.postInbox("worker:agt_x", "task").then(() => "posted", (e: Error) => e.message));
    expect(spawner).toContain("has ended");
    await runInDurableObject(agentStub(a.agent), (i: AgentDO) => (i as any).systemNote("moved"));
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

  it("read_repos: within the grant when written and again at spawn, and a client's overrides only narrow them", async () => {
    const c = await newClient({ repos: ["acme/app"], read_repos: ["acme/lib", "acme/docs"] });
    // Outside both lists, refused when written; a read-only repo can't be made pushable.
    expect((await asJson(c.token, `/v1/catalog/templates/${c.name}/peek`, { method: "PUT", body: basic({ read_repos: ["acme/lib", "acme/secret"] }) }, 403)).error.message)
      .toContain("read_repos acme/secret");
    expect((await asJson(c.token, `/v1/catalog/templates/${c.name}/sneak`, { method: "PUT", body: basic({ repos: ["acme/lib"] }) }, 403)).error.message)
      .toContain("repos acme/lib");
    await asJson(c.token, `/v1/catalog/templates/${c.name}/reader`, { method: "PUT", body: basic({ repos: ["acme/app"], read_repos: ["Acme/Lib", "acme/docs"] }) });
    const a = await createAgent(c, { template: `${c.name}/reader` });
    expect([a.repos, a.read_repos]).toEqual([["acme/app"], ["acme/docs", "acme/lib"]]);
    // A client's overrides narrow, never widen: to a subset, or down from push to read.
    const n = await createAgent(c, { template: `${c.name}/reader`, overrides: { repos: [], read_repos: ["acme/app"] } });
    expect([n.repos, n.read_repos]).toEqual([undefined, ["acme/app"]]);
    expect((await createAgent(c, { template: `${c.name}/reader`, overrides: { read_repos: ["acme/other"] } }, 400)).error.message).toContain("can't widen the repos it may read with acme/other");
    // The operator narrowing the grant refuses the same template at spawn.
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token"], repos: ["acme/app"], read_repos: ["acme/docs"], max_agents: 10 } } });
    expect((await createAgent(c, { template: `${c.name}/reader` }, 403)).error.message).toContain("read_repos acme/lib");
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

  it("ending its agent with destroy_sandbox destroys the client's own sandbox once no other agent is attached, and frees its place", async () => {
    const c = await newClient({ max_sandboxes: 1 });
    await asJson(c.token, `/v1/catalog/templates/${c.name}/hands`, { method: "PUT", body: basic({ capabilities: ["nest", "hands"], hands: "required" }) });
    const s = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
    const a1 = await createAgent(c, { template: `${c.name}/hands`, sandbox: s.sandbox });
    const a2 = await createAgent(c, { template: `${c.name}/hands`, sandbox: s.sandbox });
    const step = (agent: string) => eventually(`${agent}'s sandbox step`, async () => (await agentStub(agent).info()).ended?.sandbox);
    const sbx = () => asJson(c.token, `/v1/sandboxes/${s.sandbox}`);
    // Another agent is attached: detached, kept.
    await asJson(c.token, `/v1/agents/${a1.agent}/stop`, { body: { end: true, destroy_sandbox: true } });
    expect(await step(a1.agent)).toBe("detached");
    expect(await sbx()).toMatchObject({ attached: [a2.agent] });
    expect((await sbx()).state).not.toBe("destroyed");
    // Alone in it: destroyed by the client's end, and its place in max_sandboxes is free again.
    await asJson(c.token, `/v1/agents/${a2.agent}/stop`, { body: { end: true, destroy_sandbox: true } });
    expect(await step(a2.agent)).toBe("destroyed");
    expect((await agentStub(a2.agent).info()).ended).toMatchObject({ by: c.id, destroy_sandbox: true });
    expect((await sbx()).state).toBe("destroyed");
    // A retry of the release (AgentDO reset before recording it) finds it destroyed, and says so again.
    expect(await sandboxStub(s.sandbox).release(a2.agent, true, c.id)).toEqual({ destroyed: true });
    await eventually("the destroyed sandbox's place", async () => (await adminJson(`/v1/admin/clients/${c.id}`)).live.sandboxes === 0);
    await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
  });

  it("an ephemeral agent's own default destroys only a sandbox made for it: the client's end without destroy_sandbox keeps the client's", async () => {
    const c = await newClient();
    await asJson(c.token, `/v1/catalog/templates/${c.name}/eph`, { method: "PUT", body: basic({ capabilities: ["nest", "hands"], hands: "required", ephemeral: true }) });
    const s = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
    const a = await createAgent(c, { template: `${c.name}/eph`, sandbox: s.sandbox });
    await asJson(c.token, `/v1/agents/${a.agent}/stop`, { body: { end: true } });
    expect(await eventually("its sandbox step", async () => (await agentStub(a.agent).info()).ended?.sandbox)).toBe("detached");
    expect((await agentStub(a.agent).info()).ended).toMatchObject({ by: c.id, destroy_sandbox: true });
    expect((await asJson(c.token, `/v1/sandboxes/${s.sandbox}`)).state).not.toBe("destroyed");
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

  it("memberStep: every state and event; ended is final and a check never creates a row", () => {
    const table = Object.fromEntries((["none", ...MEMBER_STATES] as const).map((st) => [st, Object.fromEntries(MEMBER_EVENTS.map((e) => [e, memberStep(st, e)]))]));
    expect(table).toEqual({
      none: { admit: "reserved", release: "refuse", report_live: "live", report_ended: "ended", check_live: "refuse", check_ended: "refuse", check_gone: "refuse", expire: "refuse" },
      reserved: { admit: "refuse", release: "none", report_live: "live", report_ended: "ended", check_live: "live", check_ended: "ended", check_gone: "none", expire: "refuse" },
      live: { admit: "refuse", release: "refuse", report_live: "refuse", report_ended: "ended", check_live: "refuse", check_ended: "ended", check_gone: "ended", expire: "refuse" },
      ended: { admit: "refuse", release: "refuse", report_live: "refuse", report_ended: "refuse", check_live: "refuse", check_ended: "refuse", check_gone: "refuse", expire: "none" },
    });
  });

  it("the registry's guards: ended is final, only a reservation is released, a report is believed with no row, and old ended rows go", async () => {
    const c = await newClient({ max_agents: 5 });
    const stub = clientStub(c.id);
    const facts = (id: string) => ({ kind: "agent" as const, id, cell: c.cell, owner: c.id, labels: {} });
    const states = async () => Object.fromEntries((await stub.list("agent", { state: "all" })).items.map((m) => [m.id, [m.state, m.ended_ms]]));
    // Ended is final: a late live report, a release and a second admit change nothing, and it holds no place.
    await stub.admit(facts("agt_e"));
    await stub.report({ ...facts("agt_e"), ended_ms: 5 });
    await stub.report({ ...facts("agt_e"), ended_ms: null });
    await stub.report({ ...facts("agt_e"), ended_ms: 9 });
    await stub.release("agt_e");
    await stub.admit(facts("agt_e"));
    expect((await states()).agt_e).toEqual(["ended", 5]);
    expect((await adminJson(`/v1/admin/clients/${c.id}`)).live.agents).toBe(0);
    // Only a reservation is released: one whose object reported itself keeps its place.
    await stub.admit(facts("agt_l"));
    await stub.report({ ...facts("agt_l"), ended_ms: null });
    await stub.release("agt_l");
    await stub.admit(facts("agt_r"));
    await stub.release("agt_r");
    // A report with no row (one the reconcile dropped) is recorded.
    await stub.report({ ...facts("agt_n"), ended_ms: null });
    expect(await states()).toEqual({ agt_e: ["ended", 5], agt_l: ["live", null], agt_n: ["live", null] });
    // Past its retention an ended row goes; a recently ended one and live ones stay.
    await stub.report({ ...facts("agt_recent"), ended_ms: Date.now() });
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(stub);
    expect(Object.keys(await states()).sort()).toEqual(["agt_l", "agt_n", "agt_recent"]);
  });

  it("a reservation that became live while the reconcile asked about it keeps its place, whatever the answer was", async () => {
    const c = await newClient({ max_agents: 5 });
    const stub = clientStub(c.id);
    await stub.admit({ kind: "agent", id: "agt_raced", cell: c.cell, owner: c.id, labels: {} });
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("UPDATE members SET created_ms = ?", Date.now() - RESERVE_CHECK_MS - 1);
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'reconcile'");
    });
    // The object's own report lands while the reconcile waits for its answer (which was read before the object existed).
    const proto = ClientDOClass.prototype as unknown as { exists: (kind: string, id: string) => Promise<string> };
    const real = proto.exists;
    proto.exists = async function (this: ClientDO, _kind: string, id: string) {
      await this.report({ kind: "agent", id, cell: c.cell, owner: c.id, labels: {}, ended_ms: null });
      return "gone";
    };
    try {
      await runDue(stub);
    } finally {
      proto.exists = real;
    }
    expect((await stub.list("agent", { state: "all" })).items.map((m) => [m.id, m.state])).toEqual([["agt_raced", "live"]]);
  });

  it("a retried admit of the same id finds its place even at the maximum; another id is refused", async () => {
    const c = await newClient({ max_agents: 1 });
    const stub = clientStub(c.id);
    const facts = (id: string) => ({ kind: "agent" as const, id, cell: c.cell, owner: c.id, labels: {} });
    await stub.admit(facts("agt_once"));
    await stub.admit(facts("agt_once"));
    await expect(Promise.resolve().then(() => stub.admit(facts("agt_other")))).rejects.toThrow(/max_agents/);
    expect((await stub.list("agent", { state: "all" })).items.map((m) => [m.id, m.state])).toEqual([["agt_once", "reserved"]]);
  });

  it("a report retried after its client was purged leaves nothing behind", async () => {
    const stub = clientStub(`cli_gone${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`);
    await stub.report({ kind: "agent", id: "agt_late", cell: "c", owner: null, labels: {}, ended_ms: null });
    expect(await runInDurableObject(stub, (_i: ClientDO, st) => st.storage.sql.exec("SELECT 1 FROM members").toArray().length)).toBe(0);
  });

  it("the hourly recheck frees the place of a destroyed sandbox whose report never came, and keeps a live one", async () => {
    const c = await newClient({ max_sandboxes: 2 });
    const gone = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
    const kept = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell } }, 202);
    await asJson(c.token, `/v1/sandboxes/${gone.sandbox}`, { method: "DELETE" });
    const stub = clientStub(c.id);
    await eventually("the destroy reported", async () => (await stub.info()).live.sandboxes === 1);
    // As if the report had been lost (a rollback ran when it was due): the row says live again.
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("UPDATE members SET state = 'live', ended_ms = NULL");
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    expect((await stub.info()).live.sandboxes).toBe(2);
    await runDue(stub);
    expect((await stub.list("sandbox", { state: "all" })).items.map((m) => [m.id, m.state]))
      .toEqual([[gone.sandbox, "ended"], [kept.sandbox, "live"]]);
  });

  it("the hourly recheck judges only a row that is still live: one admitted afresh while it asked keeps its reservation", async () => {
    const c = await newClient({ max_agents: 5 });
    const stub = clientStub(c.id);
    const facts = { kind: "agent" as const, id: "agt_again", cell: c.cell, owner: c.id, labels: {} };
    await stub.report({ ...facts, ended_ms: null });
    await runInDurableObject(stub, (_i: ClientDO, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    // While the recheck asks about the live row, the row goes and the same id is admitted again (a reservation).
    const proto = ClientDOClass.prototype as unknown as { exists: (kind: string, id: string) => Promise<string> };
    const real = proto.exists;
    proto.exists = async function (this: ClientDO, _kind: string, id: string) {
      if (id !== facts.id) return "live";
      this.ctx.storage.sql.exec("DELETE FROM members WHERE id = ?", id);
      await this.admit(facts);
      return "gone";
    };
    try {
      await runDue(stub);
    } finally {
      proto.exists = real;
    }
    expect((await stub.list("agent", { state: "all" })).items.map((m) => [m.id, m.state])).toEqual([["agt_again", "reserved"]]);
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

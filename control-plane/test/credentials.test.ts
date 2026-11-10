// Which Claude setup token a brain starts on (`credentialFor`, docs/control-plane/durable-objects/broker/):
// the operator's agents may fall back to the default; an API client's agent runs only on the credential
// its spec names, while its grant names it, or its start is refused, visibly. Pure table first, then
// through the Worker, AgentDO, BrokerDO and FleetDO (the value a brain host actually receives).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerDO, secretRef } from "../src/do/broker";
import { ErrorCodes } from "../src/protocol/model";
import { NestError } from "../src/lib/util";
import { credentialFor, type CredentialPrincipal, DEFAULT_CREDENTIAL } from "../src/lib/credentials";
import { adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell } from "./helpers";

// --- Pure -------------------------------------------------------------------------------------------------

const NAMED = "claude_oauth_token:tenant";
const OTHER = "claude_oauth_token:other";
const op: CredentialPrincipal = { kind: "operator" };
const cli: CredentialPrincipal = { kind: "client", client: "cli_a" };
const avail = (...names: string[]) => (n: string) => names.includes(n);

describe("credentialFor (pure)", () => {
  // [requested, stored, expected]: the operator's agents, whose grant plays no part.
  const operator: [string, string[], string | "unavailable" | "not_a_credential"][] = [
    [DEFAULT_CREDENTIAL, [DEFAULT_CREDENTIAL], DEFAULT_CREDENTIAL],
    [DEFAULT_CREDENTIAL, [NAMED], "unavailable"],
    [DEFAULT_CREDENTIAL, [], "unavailable"],
    [NAMED, [NAMED, DEFAULT_CREDENTIAL], NAMED],
    [NAMED, [NAMED], NAMED],
    [NAMED, [DEFAULT_CREDENTIAL], DEFAULT_CREDENTIAL],
    [NAMED, [OTHER], "unavailable"],
    [NAMED, [], "unavailable"],
    ["cap:board", [DEFAULT_CREDENTIAL, "cap:board"], "not_a_credential"],
    ["claude_oauth_token:", [DEFAULT_CREDENTIAL], "not_a_credential"],
  ];
  it.each(operator)("operator: %s with %j stored -> %s", (req, stored, want) => {
    for (const grant of [null, { credentials: [] }, { credentials: [OTHER] }]) {
      const c = credentialFor(op, req, grant, avail(...stored));
      if (want === "unavailable" || want === "not_a_credential") expect(c).toMatchObject({ ok: false, reason: want });
      else expect(c).toMatchObject({ ok: true, name: want, fallback: want !== req });
    }
  });

  // [requested, grant's credentials (null: no client), stored, expected]: a client's agents.
  const G = (...c: string[]) => c;
  const client: [string, string[] | null, string[], string | "unavailable" | "not_granted" | "not_a_credential"][] = [
    [NAMED, G(NAMED), [NAMED, DEFAULT_CREDENTIAL], NAMED],
    [NAMED, G(NAMED), [NAMED], NAMED],
    // The bug: named one missing or expired, default stored. Never the default.
    [NAMED, G(NAMED), [DEFAULT_CREDENTIAL], "unavailable"],
    // Even when the grant also names the default: exactly the spec's credential.
    [NAMED, G(NAMED, DEFAULT_CREDENTIAL), [DEFAULT_CREDENTIAL], "unavailable"],
    [NAMED, G(NAMED, OTHER), [OTHER], "unavailable"],
    [NAMED, G(NAMED), [], "unavailable"],
    // Not (or no longer) in the grant: refused whatever is stored.
    [NAMED, G(DEFAULT_CREDENTIAL), [NAMED, DEFAULT_CREDENTIAL], "not_granted"],
    [NAMED, G(), [NAMED], "not_granted"],
    [NAMED, null, [NAMED, DEFAULT_CREDENTIAL], "not_granted"],
    [DEFAULT_CREDENTIAL, G(DEFAULT_CREDENTIAL), [DEFAULT_CREDENTIAL], DEFAULT_CREDENTIAL],
    [DEFAULT_CREDENTIAL, G(DEFAULT_CREDENTIAL), [NAMED], "unavailable"],
    [DEFAULT_CREDENTIAL, G(NAMED), [DEFAULT_CREDENTIAL, NAMED], "not_granted"],
    [DEFAULT_CREDENTIAL, null, [DEFAULT_CREDENTIAL], "not_granted"],
    ["cap:board", G("cap:board"), ["cap:board"], "not_a_credential"],
  ];
  it.each(client)("client: %s, grant %j, %j stored -> %s", (req, grant, stored, want) => {
    const c = credentialFor(cli, req, grant ? { credentials: grant } : null, avail(...stored));
    if (want === NAMED || want === DEFAULT_CREDENTIAL) expect(c).toEqual({ ok: true, name: want, fallback: false });
    else expect(c).toMatchObject({ ok: false, reason: want });
  });

  it("a client's choice is always exactly what it asked for, granted and stored: every combination", () => {
    const names = [DEFAULT_CREDENTIAL, NAMED, OTHER];
    const subsets = (xs: string[]): string[][] => xs.reduce<string[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);
    let n = 0;
    for (const req of names) {
      for (const grant of [null, ...subsets(names)]) {
        for (const stored of subsets(names)) {
          const c = credentialFor(cli, req, grant ? { credentials: grant } : null, avail(...stored));
          if (c.ok) {
            expect(c.name).toBe(req);
            expect(c.fallback).toBe(false);
            expect(grant).toContain(req);
            expect(stored).toContain(req);
          } else {
            expect(!grant?.includes(req) || !stored.includes(req)).toBe(true);
          }
          n++;
        }
      }
    }
    expect(n).toBe(3 * 9 * 8);
  });
});

// --- Through the Worker -------------------------------------------------------------------------------------

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const r = await as(token, path, init);
  const text = await r.text();
  if (status !== undefined) expect(r.status, `${path}: ${text}`).toBe(status);
  else expect(r.ok, `${path}: ${r.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

/** A webhook stub (https://hook.test/<id>): the events a client receives. */
const received = new Map<string, any[]>();
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.hostname !== "hook.test") return realFetch(input as RequestInfo, init);
    const body = JSON.parse(await req.text());
    received.set(u.pathname.slice(1), [...(received.get(u.pathname.slice(1)) ?? []), ...(Array.isArray(body) ? body : [body])]);
    return new Response("ok");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const DEFAULT_VALUE = "sk-ant-oat01-operator-default";

/** A client granted only `claude_oauth_token:<x>`, with a template naming it and a webhook; a brain host. */
async function world() {
  await adminJson(`/v1/admin/secrets/${DEFAULT_CREDENTIAL}`, { method: "PUT", body: { value: DEFAULT_VALUE } });
  const cell = uniqueCell();
  const name = `cr-${rand()}`;
  const cred = `claude_oauth_token:t-${rand()}`;
  const grant = { cells: [cell], credentials: [cred], max_agents: 10, max_sandboxes: 10 };
  const c = await adminJson("/v1/admin/clients", { body: { name, grant } }, 201);
  await asJson(c.token, `/v1/catalog/templates/${name}/t`, { method: "PUT", body: { capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: cred } });
  const hook = rand();
  await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: `https://hook.test/${hook}` } });
  const brain = await connectHost(cell, "brain");
  return { cell, cred, grant, id: c.client as string, token: c.token as string, tpl: `${name}/t`, brain, events: () => received.get(hook) ?? [] };
}

describe("a client's agent and the operator's default token", () => {
  it("never starts on the default: a missing or expired named token refuses the start, on the record and as agent.error", async () => {
    const w = await world();
    // Never stored: the create answers the refusal; the agent exists, errored, saying why; no start went out.
    const res = await as(w.token, "/v1/agents", { body: { template: w.tpl, cell: w.cell } });
    const body = await res.json() as any;
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error.message).toContain(w.cred);
    const [a] = (await asJson(w.token, "/v1/agents")).agents;
    const rec = await asJson(w.token, `/v1/agents/${a.agent}`);
    expect(rec).toMatchObject({ lifecycle: "errored", start_error: { code: "forbidden", message: expect.stringContaining("no fallback") } });
    expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some((x) => x.type === "agent_start"))).toBe(true);
    const e = await eventually("agent.error", () => w.events().find((x) => x.type === "agent.error" && x.agent === a.agent));
    expect(e).toMatchObject({ code: "start_refused", message: expect.stringContaining(w.cred) });

    // Stored but expired: the same.
    await adminJson(`/v1/admin/secrets/${w.cred}`, { method: "PUT", body: { value: "sk-ant-oat01-tenant", expires_ms: Date.now() - 1 } });
    expect((await as(w.token, `/v1/agents/${a.agent}/start`, { method: "POST" })).status).toBe(409);
    expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some((x) => x.type === "agent_start"))).toBe(true);

    // Stored and live: the brain gets exactly the tenant's value, and the refusal is cleared.
    await adminJson(`/v1/admin/secrets/${w.cred}`, { method: "PUT", body: { value: "sk-ant-oat01-tenant" } });
    await asJson(w.token, `/v1/agents/${a.agent}/start`, { method: "POST" });
    const [start] = await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent);
    expect(start.oauth_token).toBe("sk-ant-oat01-tenant");
    expect((await asJson(w.token, `/v1/agents/${a.agent}`)).start_error).toBeUndefined();
  });

  it("a grant narrowed after the spawn refuses the next start, even with the token stored", async () => {
    const w = await world();
    await adminJson(`/v1/admin/secrets/${w.cred}`, { method: "PUT", body: { value: "sk-ant-oat01-tenant" } });
    const a = await asJson(w.token, "/v1/agents", { body: { template: w.tpl, cell: w.cell, start: false } }, 201);
    // The operator takes the credential out of the grant (the default stays named, and stays unused).
    await adminJson(`/v1/admin/clients/${w.id}`, { method: "PATCH", body: { grant: { ...w.grant, credentials: [DEFAULT_CREDENTIAL] } } });
    const r = await as(w.token, `/v1/agents/${a.agent}/start`, { method: "POST" });
    expect(r.status).toBe(409);
    expect((await r.json() as any).error.message).toContain("doesn't name");
    expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some((x) => x.type === "agent_start"))).toBe(true);
  });

  it("a BrokerDO of the previous release (no principal, falls back) can't put a client's agent on the default", async () => {
    const w = await world();
    const proto = BrokerDO.prototype as unknown as { credentialRef: (c: string) => Promise<string> };
    const real = proto.credentialRef;
    proto.credentialRef = async () => secretRef(DEFAULT_CREDENTIAL);
    try {
      const res = await as(w.token, "/v1/agents", { body: { template: w.tpl, cell: w.cell } });
      expect(res.status).toBe(409);
      expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some((x) => x.type === "agent_start"))).toBe(true);
    } finally {
      proto.credentialRef = real;
    }
  });

  it("an older refusal's reason never labels a later error: entered another way, it says errored and the reason goes", async () => {
    const w = await world();
    await adminJson(`/v1/admin/secrets/${w.cred}`, { method: "PUT", body: { value: "sk-ant-oat01-tenant" } });
    const a = await asJson(w.token, "/v1/agents", { body: { template: w.tpl, cell: w.cell } }, 201);
    await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent);
    // A refusal's reason left on the record (as a refusal with a live brain once left it), then the start
    // deadline passes with no hello: errored, by another route.
    const stub = env.AGENT.get(env.AGENT.idFromName(a.agent));
    await runInDurableObject(stub, (_i: unknown, st: DurableObjectState) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.start_error = { code: "forbidden", message: "an old refusal", ms: 1 };
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'starting'");
    });
    await runDue(stub);
    const rec = await asJson(w.token, `/v1/agents/${a.agent}`);
    expect(rec.lifecycle).toBe("errored");
    expect(rec.start_error).toBeUndefined();
    const e = await eventually("agent.error", () => w.events().find((x) => x.type === "agent.error" && x.agent === a.agent));
    expect(e).toMatchObject({ code: "errored" });
    expect(e.message).not.toContain("an old refusal");
  });

  it("a start refused for good while a brain still runs records no reason and sends no event: the agent isn't errored", async () => {
    const w = await world();
    await adminJson(`/v1/admin/secrets/${w.cred}`, { method: "PUT", body: { value: "sk-ant-oat01-tenant" } });
    const a = await asJson(w.token, "/v1/agents", { body: { template: w.tpl, cell: w.cell } }, 201);
    await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent);
    const stub = env.AGENT.get(env.AGENT.idFromName(a.agent));
    // A restart is wanted while its brain runs, and that start's run is refused for good (its grant narrowed, say).
    const outcome = await runInDurableObject(stub, async (inst: any, st: DurableObjectState) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.intent = { reason: "restart" };
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
      const events = () => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM client_events").one().n;
      const before = events();
      await inst.intentFailed(info.intent, new NestError(ErrorCodes.FORBIDDEN, `client's grant doesn't name the credential ${w.cred}`, 409));
      const after = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      return { start_error: after.start_error, lifecycle: after.lifecycle, brain: !!after.brain, intent: after.intent, events: events() - before };
    });
    expect(outcome.brain).toBe(true);
    expect(outcome.lifecycle).not.toBe("errored");
    expect(outcome.start_error).toBeUndefined();
    expect(outcome.intent).toBeNull();
    expect(outcome.events).toBe(0);
    expect(w.events().filter((x) => x.type === "agent.error" && x.agent === a.agent)).toEqual([]);
  });

  it("the operator's own agents keep falling back to the default", async () => {
    const w = await world();
    const named = `claude_oauth_token:op-${rand()}`;
    const a = await adminJson("/v1/agents", { body: { template: "captain", cell: w.cell, overrides: { credential: named } } }, 201);
    const [start] = await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent);
    expect(start.oauth_token).toBe(DEFAULT_VALUE);
  });
});

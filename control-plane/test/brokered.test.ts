// Brokered actions and egress widening (docs/agents/tools/#taint-and-sinks): the pipeline end to end
// inside the pool. A runner session calls `github_*`, `http_request`, `brokered` or `egress_policy`; a
// fake GitHub (a fetch handler for https://api.github.com, installed over the global fetch BrokerDO and
// AgentDO call) checks the App's JWT against the App's public key, scopes every installation token to
// what it was minted for, and records every request. Each guarantee has a test that fails without it.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { secretNeedles } from "../src/do/broker";
import { authorize, grantOfEntry, keyDigest, pathCovered, safePath, secretKinds, stringsOf } from "../src/lib/brokered";
import { appJwt, GitHubApi, importAppKey, pkcs1ToPkcs8 } from "../src/lib/github";
import { CallLedger } from "../src/lib/calls";
import { b64url, b64urlToBytes, bytesToB64 } from "../src/lib/util";
import { adminJson, connectHost, nextCommands, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const APP_ID = "424242";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

// --- The App's key -------------------------------------------------------------------------------------

/** The inner `RSAPrivateKey` of a PKCS#8 RSA key: what GitHub hands out (`BEGIN RSA PRIVATE KEY`). */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING { RSAPrivateKey } }
  const len = (o: number): [number, number] => {
    const b = pkcs8[o]!;
    if (b < 0x80) return [b, o + 1];
    const n = b & 0x7f;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + pkcs8[o + 1 + i]!;
    return [v, o + 1 + n];
  };
  let [, o] = len(1); // outer SEQUENCE
  o += 3; // INTEGER 0
  const [algLen, algBody] = len(o + 1);
  o = algBody + algLen;
  const [keyLen, keyBody] = len(o + 1); // OCTET STRING
  return pkcs8.slice(keyBody, keyBody + keyLen);
}
const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${bytesToB64(der).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

let appKeys: CryptoKeyPair;
let appPkcs1Pem: string;

async function verifyJwt(jwt: string): Promise<{ iat: number; exp: number; iss: string } | null> {
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", appKeys.publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok || JSON.parse(new TextDecoder().decode(b64urlToBytes(h))).alg !== "RS256") return null;
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
}

// --- The fake GitHub -------------------------------------------------------------------------------------

interface Item { id: number; number?: number; body: string; html_url: string; head?: string; base?: string; state?: string }
type Behaviour = { status?: number; applyThenFail?: boolean };

class FakeGitHub {
  /** repo (lowercase) → installation id. */
  readonly installs = new Map<string, number>();
  readonly mints: { installation: number; repositories: string[]; permissions: Record<string, string> }[] = [];
  readonly tokens = new Map<string, { repo: string; permissions: Record<string, string> }>();
  /** Every write (non-GET) request: method and path. */
  readonly writes: { method: string; path: string; body: any }[] = [];
  readonly comments = new Map<string, Item[]>();
  readonly issues = new Map<string, Item[]>();
  readonly pulls = new Map<string, Item[]>();
  readonly reviews = new Map<string, Item[]>();
  /** The next write requests' behaviour, in order. */
  readonly next: Behaviour[] = [];
  /** The next pull request listings show nothing (one made meanwhile, not yet listed). */
  hidePulls = 0;
  private n = 0;

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (req.headers.get("accept") !== "application/vnd.github+json" || !req.headers.get("user-agent")) return json(400, { message: "headers" });
    const auth = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const body = req.method === "GET" ? null : await req.json() as any;
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/)) && req.method === "GET") {
      const c = await verifyJwt(auth);
      if (!c || c.iss !== APP_ID || c.exp - c.iat > 660) return json(401, { message: "A JSON web token could not be decoded" });
      const id = this.installs.get(m[1]!.toLowerCase());
      return id ? json(200, { id }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      const c = await verifyJwt(auth);
      if (!c || c.iss !== APP_ID) return json(401, { message: "bad JWT" });
      this.mints.push({ installation: Number(m[1]), repositories: body.repositories, permissions: body.permissions });
      const repo = [...this.installs].find(([r, i]) => i === Number(m![1]) && r.endsWith(`/${body.repositories[0]}`))?.[0];
      if (!repo) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const token = `ghs_fake${String(++this.n).padStart(32, "0")}`;
      this.tokens.set(token, { repo, permissions: body.permissions });
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: body.permissions });
    }
    // Everything else needs an installation token for exactly this repo.
    const r = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)$/);
    const t = this.tokens.get(auth);
    if (!r || !t || t.repo !== r[1]!.toLowerCase()) return json(403, { message: "Resource not accessible by integration" });
    const repo = r[1]!.toLowerCase();
    const rest = r[2]!;
    if (req.method !== "GET") this.writes.push({ method: req.method, path: u.pathname, body });
    const b = req.method !== "GET" ? this.next.shift() ?? {} : {};
    if (b.status && !b.applyThenFail) return json(b.status, { message: "scripted" });
    const done = (status: number, item: Item) => (b.applyThenFail ? json(b.status ?? 502, { message: "scripted after applying" }) : json(status, item));
    const list = (map: Map<string, Item[]>, k: string) => map.get(k) ?? (map.set(k, []), map.get(k)!);
    if ((m = rest.match(/^\/issues\/(\d+)\/comments$/))) {
      const items = list(this.comments, `${repo}#${m[1]}`);
      if (req.method === "GET") return json(200, items);
      if (!t.permissions.issues && !t.permissions.pull_requests) return json(403, { message: "permissions" });
      const it = { id: ++this.n, body: body.body, html_url: `https://github.com/${repo}/issues/${m[1]}#issuecomment-${this.n}` };
      items.push(it);
      return done(201, it);
    }
    if (rest === "/issues") {
      const items = list(this.issues, repo);
      if (req.method === "GET") return json(200, [...items].reverse());
      const it = { id: ++this.n, number: this.n, body: body.body, html_url: `https://github.com/${repo}/issues/${this.n}` };
      items.push(it);
      return done(201, it);
    }
    if (rest === "/pulls") {
      const items = list(this.pulls, repo);
      if (req.method === "GET" && this.hidePulls > 0) {
        this.hidePulls--;
        return json(200, []);
      }
      if (req.method === "GET") {
        const head = u.searchParams.get("head");
        const base = u.searchParams.get("base");
        return json(200, items.filter((p) => p.state === "open" && (!head || `${repo.split("/")[0]}:${p.head}` === head.toLowerCase() || p.head === head) && (!base || p.base === base)));
      }
      if (t.permissions.pull_requests !== "write") return json(403, { message: "permissions" });
      if (items.some((p) => p.state === "open" && p.head === body.head && p.base === body.base)) {
        return json(422, { message: "Validation Failed", errors: [{ message: `A pull request already exists for ${body.head}.` }] });
      }
      const it = { id: ++this.n, number: this.n, body: body.body ?? "", head: body.head, base: body.base, state: "open", html_url: `https://github.com/${repo}/pull/${this.n}` };
      items.push(it);
      return done(201, it);
    }
    if ((m = rest.match(/^\/pulls\/(\d+)\/comments$/))) {
      const items = list(this.reviews, `${repo}#${m[1]}`);
      if (req.method === "GET") return json(200, [...items].reverse());
      const it = { id: ++this.n, body: body.body, html_url: `https://github.com/${repo}/pull/${m[1]}#discussion_r${this.n}` };
      items.push(it);
      return done(201, it);
    }
    return json(404, { message: "Not Found" });
  }
}

// --- An http profile's server ----------------------------------------------------------------------------

class HttpStub {
  readonly requests: { method: string; path: string; search: string; headers: Record<string, string>; body: string }[] = [];
  readonly next: { delay?: number; status?: number; location?: string }[] = [];
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const headers = Object.fromEntries(req.headers);
    this.requests.push({ method: req.method, path: u.pathname, search: u.search, headers, body: req.method === "GET" ? "" : await req.text() });
    const b = this.next.shift() ?? {};
    if (b.delay) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, b.delay);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (b.location) return new Response(null, { status: b.status ?? 302, headers: { location: b.location } });
    // Echoes what it got, the credential included: the proxy must mask it.
    return new Response(JSON.stringify({ path: u.pathname, auth: headers.authorization ?? null, n: this.requests.length }), {
      status: b.status ?? 200, headers: { "content-type": "application/json" },
    });
  }
}

const gh = new FakeGitHub();
const stubs = new Map<string, HttpStub>();
const realFetch = globalThis.fetch;
beforeAll(async () => {
  appKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true,
    ["sign", "verify"]) as CryptoKeyPair;
  appPkcs1Pem = pem("RSA PRIVATE KEY", pkcs1Of(new Uint8Array(await crypto.subtle.exportKey("pkcs8", appKeys.privateKey) as ArrayBuffer)));
  await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ app_id: APP_ID, private_key: appPkcs1Pem }) } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.hostname === "api.github.com") return gh.handle(req);
    if (u.hostname === "http.test") return stubs.get(u.pathname.split("/")[1]!)?.handle(req) ?? new Response("no stub", { status: 503 });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// --- Setup -------------------------------------------------------------------------------------------------

/** An agent whose one capability grants `brokered` (and the platform `tools`), with a runner session. */
async function setup(brokered: unknown[], opts: { tools?: string[]; hands?: boolean } = {}) {
  const id = rand();
  const cap = `b${id}`;
  await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: { tools: opts.tools ?? [], brokered } });
  const tpl = `t-${id}`;
  await adminJson(`/v1/admin/templates/${tpl}`, {
    method: "PUT",
    body: {
      capabilities: ["nest", cap], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } },
      hands: opts.hands ? "required" : "forbidden", credential: "claude_oauth_token", escalate_to: "user",
    },
  });
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "brokered" } }, 201);
  let sandbox: string | undefined;
  let sbxHost: Awaited<ReturnType<typeof connectHost>> | undefined;
  if (opts.hands) {
    sbxHost = await connectHost(cell);
    sandbox = (await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201)).sandbox;
    await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  }
  const host = await connectHost(cell, "brain");
  const ag = await adminJson("/v1/agents", { body: { template: tpl, workstream, cell, ...(sandbox ? { sandbox } : {}) } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === ag.agent);
  const ws = await Ws.connect(`/v1/agents/${ag.agent}/session`, host.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: ag.agent, host: host.host, instance_id: "rin_one", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  return { id, agent: ag.agent as string, workstream: workstream as string, ws, sandbox, sbxHost };
}

/** A fresh repo the App is installed on (each test its own: tokens are cached per repo). */
function repo(): string {
  const r = `o${rand()}/r${rand()}`;
  gh.installs.set(r, 1000 + gh.installs.size);
  return r;
}

const seqs = new WeakMap<Ws, number>();
function call(ws: Ws, callId: string, name: string, args: unknown) {
  const seq = (seqs.get(ws) ?? 0) + 1;
  seqs.set(ws, seq);
  ws.send({ type: "tool_call", seq, call: callId, turn: "trn_x", name, arguments: args });
}
const result = async (ws: Ws, callId: string, timeoutMs = 6000) => (await ws.next("tool_result", (m) => m.call === callId, timeoutMs)).outcome;
const run = async (ws: Ws, name: string, args: unknown) => {
  const id = `cal_${rand()}`;
  call(ws, id, name, args);
  return result(ws, id);
};
const taint = (agent: string) => runInDurableObject(agentStub(agent), (inst: AgentDO) => (inst as any).kvPut("read_tainted", true));
const tainted = (agent: string) => runInDurableObject(agentStub(agent), (_: AgentDO, st) =>
  JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'read_tainted'").toArray()[0]?.value ?? "false") as boolean);
const answer = (agent: string, ask: string, text: string) => adminJson(`/v1/agents/${agent}/asks/${ask}/answer`, { body: { answer: text } });
const lastTurn = async (agent: string) => (await agentStub(agent).turns()).at(-1)!.input as { kind: string; text: string };
const journal = (agent: string) => adminJson(`/v1/agents/${agent}/brokered`);

// --- Pure parts --------------------------------------------------------------------------------------------

describe("the GitHub App's JWT and client", () => {
  it("a PKCS#1 key (what GitHub hands out) and its PKCS#8 form both sign a JWT that verifies with the App's public key, within GitHub's limits", async () => {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", appKeys.privateKey) as ArrayBuffer);
    // The wrapper is exactly the PKCS#8 WebCrypto exports (an independent encoder of the same key).
    expect(b64url(pkcs1ToPkcs8(pkcs1Of(pkcs8)))).toBe(b64url(pkcs8));
    const now = Date.UTC(2026, 9, 31, 12);
    for (const p of [appPkcs1Pem, pem("PRIVATE KEY", pkcs8)]) {
      const c = await verifyJwt(await appJwt(APP_ID, await importAppKey(p), now));
      expect(c).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: APP_ID });
      // GitHub: exp at most 10 minutes ahead.
      expect(c!.exp - now / 1000).toBeLessThanOrEqual(600);
    }
  });

  it("mints a token narrowed to one repo and the action's permissions, with GitHub's headers; a repo without the App is null", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/installation")) return new Response(url.includes("/nope/") ? "{}" : JSON.stringify({ id: 7 }), { status: url.includes("/nope/") ? 404 : 200 });
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-10-31T13:00:00Z" }), { status: 201 });
    }) as unknown as typeof fetch;
    const api = new GitHubApi(fake, "https://gh.example");
    expect(await api.installation("jwt", "me/app")).toBe(7);
    expect(await api.installation("jwt", "nope/x")).toBeNull();
    expect(await api.mint("jwt", 7, "app", { issues: "write" })).toEqual({ token: "ghs_x", expires_ms: Date.UTC(2026, 9, 31, 13) });
    const mint = seen.at(-1)!;
    expect(mint.url).toBe("https://gh.example/app/installations/7/access_tokens");
    expect(JSON.parse(String(mint.init.body))).toEqual({ repositories: ["app"], permissions: { issues: "write" } });
    expect(mint.init.headers).toMatchObject({ authorization: "Bearer jwt", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
    // A redirect is a refusal, never followed with the token.
    expect(mint.init.redirect).toBe("manual");
  });

  it("the default fetch works under workerd (no incorrect `this`: Illegal invocation)", async () => {
    // Every other client test injects a fake fetch, which binds nothing (review lesson 8). Nothing
    // listens at the discard port, so a correctly invoked fetch fails on the connection instead.
    const r = await new GitHubApi(undefined, "http://127.0.0.1:9").request("t", "GET", "/x");
    expect(r.kind).toBe("lost");
    expect((r as { why: string }).why).not.toMatch(/Illegal invocation/);
    expect((r as { why: string }).why).toMatch(/^network: /);
  });
});

describe("authority and the scan (pure)", () => {
  const g = (e: unknown) => grantOfEntry("c", e as any)!;
  it("a GitHub grant covers its repos (any case) or, unscoped, any repo; the balanced defaults: scoped allow, unscoped approve; http profiles by method and path", () => {
    const scoped = g({ action: "github.comment", repos: ["Me/App"] });
    const unscoped = g({ action: "github.comment" });
    expect(scoped).toMatchObject({ repos: ["me/app"], when_tainted: "allow", per_hour: 30 });
    expect(unscoped).toMatchObject({ repos: null, when_tainted: "approve" });
    const args = (repo: string) => ({ repo, issue_number: 1, body: "x" });
    expect(authorize([scoped], "github.comment", args("me/APP"))).toMatchObject({ ok: true, value: { target: "me/app", sink: true, when_tainted: "allow" } });
    expect(authorize([scoped], "github.comment", args("me/other")).ok).toBe(false);
    expect(authorize([scoped], "github.create_issue", { repo: "me/app", title: "t" }).ok).toBe(false);
    // Two covering grants: any that allows, the higher cap.
    const strict = g({ action: "github.comment", repos: ["me/app"], when_tainted: "approve", per_hour: 90 });
    expect(authorize([strict, unscoped], "github.comment", args("me/app"))).toMatchObject({ value: { when_tainted: "approve", per_hour: 90 } });
    expect(authorize([strict, scoped], "github.comment", args("me/app"))).toMatchObject({ value: { when_tainted: "allow" } });

    const rw = g({ action: "http.request", profile: "p", base_url: "https://api.example.com/", methods: ["GET", "POST"], paths: ["/v1/items"] });
    const ro = g({ action: "http.request", profile: "q", base_url: "https://api.example.com", methods: ["GET", "HEAD"] });
    const req = (profile: string, method: string, path: string) => authorize([rw, ro], "http.request", { profile, method, path });
    expect(req("p", "POST", "/v1/items/3")).toMatchObject({ ok: true, value: { sink: true, when_tainted: "approve" } });
    expect(req("q", "GET", "/anything")).toMatchObject({ ok: true, value: { sink: false } });
    for (const [profile, method, path] of [["p", "DELETE", "/v1/items"], ["p", "GET", "/v1/itemsx"], ["p", "GET", "/v1/items/../x"], ["p", "GET", "/v1/items/%2e%2e"],
      ["p", "GET", "/v1/items//x"], ["q", "GET", "x"], ["r", "GET", "/"]] as const) {
      expect(req(profile, method, path).ok, `${profile} ${method} ${path}`).toBe(false);
    }
    expect(pathCovered("/v1/", "/v1/x")).toBe(true);
    expect(safePath("/a/./b")).toBe(false);
  });

  it("the scan finds credential shapes in any string (keys too), and a stored value raw, base64'd, inside JSON, or as a PEM's body", () => {
    const token = `ghp_${"a1".repeat(18)}`;
    expect(secretKinds(stringsOf({ body: `here: ${token}` }))).toEqual(["a GitHub token"]);
    expect(secretKinds(stringsOf({ [`AKIA${"A".repeat(16)}`]: 1 }))).toEqual(["an AWS access key id"]);
    expect(secretKinds(stringsOf({ x: ["-----BEGIN RSA PRIVATE KEY-----"] }))).toEqual(["a private key"]);
    expect(secretKinds(stringsOf({ body: "ghp_short, sk-ant-, an ordinary comment" }))).toEqual([]);
    const n = secretNeedles(JSON.stringify({ client_id: "short", client_secret: "0123456789abcdef-secret" }));
    expect(n).toContain("0123456789abcdef-secret");
    expect(n).not.toContain("short");
    expect(secretNeedles("tiny")).toEqual([]);
    expect(secretNeedles("a-long-enough-value")).toContain(btoa("a-long-enough-value"));
    expect(secretNeedles(appPkcs1Pem).some((x) => /^[A-Za-z0-9+/=]{64}$/.test(x))).toBe(true);
  });
});

// --- GitHub actions through the pipeline -------------------------------------------------------------------

describe("github actions", () => {
  it("a comment goes out once through the App, with a token minted for that repo and those permissions only, audited without its value, cached, and journaled", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r] }]);
    const tools = (s.ws.send({ type: "tools_list_request", request: `req_${rand()}` }), (await s.ws.next("tools_list")).tools as any[]);
    const def = tools.find((t) => t.name === "github_comment");
    expect(def.input_schema.properties.repo.enum).toEqual([r]);
    expect(tools.some((t) => t.name === "github_create_pr")).toBe(false);

    const before = gh.mints.length;
    const o = await run(s.ws, "github_comment", { repo: r, issue_number: 7, body: "LGTM" });
    expect(o).toMatchObject({ status: "ok" });
    expect(o.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`https://github.com/${r}/issues/7#issuecomment-`) });
    const posted = gh.comments.get(`${r}#7`)!;
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(/^LGTM\n\n<!-- nest:[0-9a-f]{24} -->$/);
    expect(gh.mints.slice(before)).toEqual([{ installation: gh.installs.get(r), repositories: [r.split("/")[1]], permissions: { issues: "write", pull_requests: "write" } }]);
    // A second call reuses the token: no second mint.
    await run(s.ws, "github_comment", { repo: r, issue_number: 7, body: "again" });
    expect(gh.mints.length).toBe(before + 1);
    expect(gh.comments.get(`${r}#7`)).toHaveLength(2);

    // The mint is audited: repo, permissions, the caller's call key; never the token.
    const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
    const records = await Promise.all(listed.objects.map(async (o) => (await env.BUCKET.get(o.key))!.text()));
    const mine = records.filter((t) => t.includes(`"${r}"`));
    expect(mine).toHaveLength(1);
    const rec = JSON.parse(mine[0]!);
    expect(rec).toMatchObject({ event: "github_installation_token", repos: [r], permissions: { issues: "write", pull_requests: "write" }, installation: gh.installs.get(r) });
    expect(rec.caller.call).toMatch(new RegExp(`^${s.agent}/1/cal_`));
    expect(mine[0]).not.toContain("ghs_");

    const j = await journal(s.agent);
    expect(j).toHaveLength(2);
    expect(j[1]).toMatchObject({ action: "github.comment", target: r, status: "done", attempts: 1, tainted: false });
    expect(j[1].idem).toMatch(new RegExp(`^comment:${r}#7:[0-9a-f]{24}$`));
  });

  it("refuses a repo the grant doesn't cover, an action it doesn't grant, a repo without the App (audited), and email.send; the catalog refuses email.send and a clashing mcp name", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r] }, { action: "github.create_issue" }], { tools: ["brokered"] });
    expect(await run(s.ws, "github_comment", { repo: `${r}x`, issue_number: 1, body: "x" })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await run(s.ws, "github_create_pr", { repo: r, title: "t", head: "h", base: "main" })).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    expect(await run(s.ws, "brokered", { action: "github.create_pr", args: { repo: r, title: "t", head: "h", base: "main" } }))
      .toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await run(s.ws, "brokered", { action: "email.send", args: {} })).toMatchObject({ status: "error", error: { code: "not_implemented" } });
    const missing = `o${rand()}/none`;
    expect(await run(s.ws, "github_create_issue", { repo: missing, title: "t" })).toMatchObject({ status: "error", error: { code: "forbidden", message: expect.stringContaining("isn't installed") } });
    const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
    const texts = await Promise.all(listed.objects.map(async (o) => (await env.BUCKET.get(o.key))!.text()));
    expect(texts.some((t) => t.includes(missing) && t.includes("refused"))).toBe(true);
    expect(gh.writes.some((w) => w.path.includes(r))).toBe(false);

    const put = (name: string, body: unknown, status: number) => adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body }, status);
    expect((await put(`e${rand()}`, { brokered: [{ action: "email.send" }] }, 400)).error.message).toContain("email.send isn't implemented");
    expect((await put("github", { mcp: { url: "https://mcp.example.com/mcp", auth: "cap:x" } }, 400)).error.message).toContain("github_comment");
  });

  it("a pull request already open from that head to that base is returned, not made twice; a 422 for one made meanwhile finds it", async () => {
    const r = repo();
    const s = await setup([{ action: "github.create_pr", repos: [r] }]);
    const args = { repo: r, title: "Fix", head: "fix-1", base: "main", body: "why" };
    const first = await run(s.ws, "github_create_pr", args);
    expect(first.content[1].value).toMatchObject({ number: expect.any(Number), url: expect.stringContaining(`/${r}/pull/`) });
    const second = await run(s.ws, "github_create_pr", { ...args, title: "Fix (retry)" });
    expect(second.content[1].value).toEqual({ ...first.content[1].value, existing: true });
    expect(gh.writes.filter((w) => w.path === `/repos/${r}/pulls`)).toHaveLength(1);
    // Not listed yet when read, refused with 422 when made: read again, it's that one.
    gh.hidePulls = 1;
    const third = await run(s.ws, "github_create_pr", args);
    expect(third.content[1].value).toEqual({ ...first.content[1].value, existing: true });
    expect(gh.writes.filter((w) => w.path === `/repos/${r}/pulls`)).toHaveLength(2);
    expect(gh.pulls.get(r)).toHaveLength(1);
  });

  it("an answer lost after GitHub made it is found by its marker (one comment); lost before, the outcome is unknown; a redelivered call reads GitHub before sending", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r] }, { action: "github.create_issue", repos: [r] }]);
    gh.next.push({ applyThenFail: true, status: 502 });
    expect(await run(s.ws, "github_comment", { repo: r, issue_number: 3, body: "made" })).toMatchObject({ status: "ok" });
    expect(gh.comments.get(`${r}#3`)).toHaveLength(1);
    gh.next.push({ status: 502 });
    expect(await run(s.ws, "github_comment", { repo: r, issue_number: 3, body: "lost" })).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect(gh.comments.get(`${r}#3`)).toHaveLength(1);

    // A call an earlier incarnation sent and never settled (its tool_calls row still dispatching): redelivered,
    // it finds its own marker and sends nothing; one whose marker isn't there is sent.
    const plant = async (callId: string, issue: number, withMarker: boolean) => {
      const key = `${s.agent}/1/${callId}`;
      if (withMarker) gh.issues.set(r, [...(gh.issues.get(r) ?? []), { id: 1, number: issue, body: `x\n\n<!-- nest:${await keyDigest(key)} -->`, html_url: `https://github.com/${r}/issues/${issue}` }]);
      await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
        (inst as any).calls.begin(1, callId, "github_create_issue");
        (inst as any).journal.sending({ key, action: "github.create_issue", target: r, idem: "i", digest: "d", args: "{}", tainted: false });
      });
    };
    await plant("cal_redo1", 901, true);
    call(s.ws, "cal_redo1", "github_create_issue", { repo: r, title: "t" });
    expect((await result(s.ws, "cal_redo1")).content[1].value).toEqual({ number: 901, id: 1, url: `https://github.com/${r}/issues/901` });
    expect(gh.writes.filter((w) => w.path === `/repos/${r}/issues`)).toHaveLength(0);
    await plant("cal_redo2", 0, false);
    call(s.ws, "cal_redo2", "github_create_issue", { repo: r, title: "t2" });
    expect((await result(s.ws, "cal_redo2")).status).toBe("ok");
    expect(gh.writes.filter((w) => w.path === `/repos/${r}/issues`)).toHaveLength(1);
    expect((await journal(s.agent)).find((e: any) => e.key.endsWith("/cal_redo2"))).toMatchObject({ status: "done", attempts: 2 });
  });

  it("a call whose brain stopped being current before it left never reaches GitHub", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r] }]);
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        (inst as any).update((i: any) => {
          i.agent_epoch += 1;
          i.brain.epoch = i.agent_epoch;
        });
      };
    });
    call(s.ws, "cal_f1", "github_comment", { repo: r, issue_number: 1, body: "x" });
    await s.ws.next("ack", (m) => m.up_to >= 1);
    const outcome = await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).calls.call("cal_f1")?.outcome);
    expect(outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    expect(gh.comments.get(`${r}#1`) ?? []).toEqual([]);
  });

  it("an action is capped per hour; refused calls don't count", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r], per_hour: 2 }]);
    await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: `ghp_${"x".repeat(36)}` }); // refused by the scan
    expect((await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: "1" })).status).toBe("ok");
    expect((await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: "2" })).status).toBe("ok");
    expect(await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: "3" })).toMatchObject({ status: "error", error: { code: "rate_limited", retryable: true } });
    expect(gh.comments.get(`${r}#1`)).toHaveLength(2);
  });
});

// --- The secret scan -------------------------------------------------------------------------------------

describe("the secret scan", () => {
  it("arguments holding a credential shape or any stored secret's value are refused before anything is asked or sent, without the value in the error; the journal names what matched", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment" }]); // unscoped: a tainted call would be asked
    await taint(s.agent);
    const stored = `s3cr3t-${rand()}-value`;
    await adminJson(`/v1/admin/secrets/http:leak${s.id}`, { method: "PUT", body: { value: stored } });
    const pat = `ghp_${"Ab1".repeat(12)}`;
    for (const body of [`token ${pat}`, `look: ${stored}`, `b64 ${btoa(stored)}`]) {
      const o = await run(s.ws, "github_comment", { repo: r, issue_number: 2, body });
      expect(o).toMatchObject({ status: "error", error: { code: "forbidden", message: expect.stringContaining("Not sent: the arguments contain") } });
      expect(JSON.stringify(o)).not.toContain(stored);
      expect(JSON.stringify(o)).not.toContain(pat);
    }
    const notes = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).userNotifications();
    expect(notes).toEqual([]); // the operator was never asked to approve a leak
    expect(gh.writes.some((w) => w.path.includes(r))).toBe(false);
    const j = await journal(s.agent);
    expect(j.map((e: any) => e.status)).toEqual(["refused", "refused", "refused"]);
    expect(j.map((e: any) => e.detail)).toEqual([`the value of http:leak${s.id}`, `the value of http:leak${s.id}`, "a GitHub token"]);
    expect(JSON.stringify(j)).not.toContain(stored);
  });
});

// --- The sink gate ---------------------------------------------------------------------------------------

describe("the sink gate for brokered actions", () => {
  it("tainted: a scoped write goes (allow), an unscoped one waits for the operator once per exact call; an approval lets that one call through once, by either tool; a denial never", async () => {
    const scoped = repo();
    const other = repo();
    const s = await setup([{ action: "github.comment", repos: [scoped] }, { action: "github.create_issue" }], { tools: ["brokered"] });
    await taint(s.agent);
    expect((await run(s.ws, "github_comment", { repo: scoped, issue_number: 1, body: "ok" })).status).toBe("ok");
    const args = { repo: other, title: "Bug", body: "details" };
    const p1 = await run(s.ws, "github_create_issue", args);
    expect(p1).toMatchObject({ status: "pending", ask: expect.stringMatching(/^ask_/), message: expect.stringContaining("mcp__nest__github_create_issue") });
    // Asked again before a decision (keys in another order, through `brokered`): the same ask.
    expect((await run(s.ws, "brokered", { action: "github.create_issue", args: { body: "details", title: "Bug", repo: other } })).ask).toBe(p1.ask);
    const notes = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).userNotifications();
    expect(notes.filter((n) => n.text.includes(p1.ask))).toHaveLength(1);
    expect(notes.at(-1)!.text).toContain(`github.create_issue on ${other}`);
    expect(gh.issues.get(other) ?? []).toEqual([]);

    await answer(s.agent, p1.ask, "approve");
    expect(await lastTurn(s.agent)).toMatchObject({ kind: "ask_answer", text: expect.stringContaining("call mcp__nest__github_create_issue again") });
    expect((await run(s.ws, "github_create_issue", { ...args, title: "Other" })).status).toBe("pending");
    expect((await run(s.ws, "brokered", { action: "github.create_issue", args })).status).toBe("ok");
    expect(gh.issues.get(other)).toHaveLength(1);
    const p2 = await run(s.ws, "github_create_issue", args);
    expect(p2.status).toBe("pending");
    await answer(s.agent, p2.ask, "no");
    expect((await run(s.ws, "github_create_issue", args)).status).toBe("pending");
    expect(gh.issues.get(other)).toHaveLength(1);
  });

  it("an untainted session isn't gated; a scoped grant set to approve is", async () => {
    const r = repo();
    const s = await setup([{ action: "github.comment", repos: [r], when_tainted: "approve" }]);
    expect((await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: "a" })).status).toBe("ok");
    await taint(s.agent);
    expect((await run(s.ws, "github_comment", { repo: r, issue_number: 1, body: "b" })).status).toBe("pending");
  });
});

// --- http.request -----------------------------------------------------------------------------------------

describe("http.request profiles", () => {
  async function profileSetup(extra: Record<string, unknown> = {}, more: unknown[] = []) {
    const id = rand();
    const stub = new HttpStub();
    stubs.set(id, stub);
    const secret = `prof-${rand()}-credential`;
    await adminJson(`/v1/admin/secrets/http:p${id}`, { method: "PUT", body: { value: secret } });
    const s = await setup([{ action: "http.request", profile: "p", base_url: `https://http.test/${id}`, methods: ["GET", "POST"], paths: ["/v1/items"],
      // Its answers taint the session; the gate on its calls is tested on its own below.
      auth: { secret: `http:p${id}` }, when_tainted: "allow", ...extra }, ...more]);
    return { ...s, stub, secret, sid: id };
  }

  it("attaches the profile's credential, masks it if reflected, follows no redirect, keeps to its methods and paths, and its answer taints", async () => {
    const p = await profileSetup();
    const o = await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items/3", query: { x: 1, y: "a b" } });
    expect(p.stub.requests[0]).toMatchObject({ method: "GET", path: `/${p.sid}/v1/items/3`, search: "?x=1&y=a+b", headers: { authorization: `Bearer ${p.secret}` } });
    expect(o.content[0].text).not.toContain(p.secret);
    expect(JSON.parse(o.content[0].text).auth).toBe(`Bearer ${"*".repeat(p.secret.length)}`);
    expect(o.content[1].value).toMatchObject({ status: 200, content_type: "application/json" });
    expect(await tainted(p.agent)).toBe(true);

    p.stub.next.push({ status: 302, location: "https://elsewhere.example/steal" });
    const red = await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items" });
    expect(red, JSON.stringify(red)).toMatchObject({ status: "ok" });
    expect(red.content[1].value).toMatchObject({ status: 302, location: "https://elsewhere.example/steal" });
    expect(p.stub.requests).toHaveLength(2);
    for (const [method, path] of [["DELETE", "/v1/items"], ["GET", "/v2"], ["GET", "/v1/items/../../admin"]]) {
      expect(await run(p.ws, "http_request", { profile: "p", method, path }), `${method} ${path}`).toMatchObject({ status: "error", error: { code: expect.stringMatching(/forbidden|invalid_message/) } });
    }
    expect(p.stub.requests).toHaveLength(2);
  });

  it("a tainted session's rw profile call waits for approval; a read-only profile isn't a sink; a trusted profile's answer doesn't taint", async () => {
    const id = rand();
    const stub = new HttpStub();
    stubs.set(id, stub);
    const s = await setup([
      { action: "http.request", profile: "rw", base_url: `https://http.test/${id}`, methods: ["GET", "POST"] },
      { action: "http.request", profile: "ro", base_url: `https://http.test/${id}`, methods: ["GET"], trusted: true },
    ]);
    expect((await run(s.ws, "http_request", { profile: "ro", method: "GET", path: "/a" })).status).toBe("ok");
    expect(await tainted(s.agent)).toBe(false);
    await taint(s.agent);
    expect((await run(s.ws, "http_request", { profile: "ro", method: "GET", path: "/b" })).status).toBe("ok");
    expect((await run(s.ws, "http_request", { profile: "rw", method: "GET", path: "/c" })).status).toBe("pending");
    expect(stub.requests.map((r) => r.path)).toEqual([`/${id}/a`, `/${id}/b`]);
  });

  it("a lost answer is retried once for an idempotent method, never for POST", async () => {
    // vitest.config.ts: BROKERED_TIMEOUT_MS = 1500.
    const p = await profileSetup();
    p.stub.next.push({ delay: 2500 });
    expect((await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items" })).status).toBe("ok");
    expect(p.stub.requests).toHaveLength(2);
    p.stub.next.push({ delay: 2500 });
    expect(await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" })).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect(p.stub.requests).toHaveLength(3);
  }, 15_000);
});

// --- Egress widening ---------------------------------------------------------------------------------------

describe("egress_policy", () => {
  it("widening its own sandbox's egress from a tainted session waits for approval, then adds expiring grants; narrowing is never gated", async () => {
    const s = await setup([], { tools: ["egress_policy"], hands: true });
    const req = { allow: [{ host: "API.Example.com" }, { host: "*.cdn.example.net", ports: [443] }], ttl_s: 600 };
    const p1 = await run(s.ws, "egress_policy", req);
    expect(p1).toMatchObject({ status: "pending", message: expect.stringContaining("mcp__nest__egress_policy") });
    const policy = () => env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox!)).policy();
    expect((await policy()).allow.some((r) => r.host === "api.example.com")).toBe(false);
    await answer(s.agent, p1.ask, "yes");
    const before = Date.now();
    const o = await run(s.ws, "egress_policy", req);
    expect(o.status).toBe("ok");
    const allow = (await policy()).allow.filter((r) => r.layer === "sandbox");
    expect(allow.map((r) => [r.host, r.ports])).toEqual([["api.example.com", [80, 443]], ["*.cdn.example.net", [443]]]);
    expect(allow[0]!.expires_ms).toBeGreaterThanOrEqual(before + 600_000);
    const [update] = await nextCommands(s.sbxHost!.ws, (c) => c.type === "policy_update" && c.policy.allow.some((r: any) => r.host === "api.example.com"));
    expect(update.sandbox).toBe(s.sandbox);
    // Spent: the same widening again needs a new approval.
    expect((await run(s.ws, "egress_policy", req)).status).toBe("pending");
    // Narrowing: not gated.
    expect((await run(s.ws, "egress_policy", { revoke: ["api.example.com"] })).status).toBe("ok");
    expect((await policy()).allow.map((r) => r.host)).not.toContain("api.example.com");
    expect(await run(s.ws, "egress_policy", { allow: [{ host: "10.0.0.1" }] })).toMatchObject({ status: "error", error: { code: "invalid_message" } });
  });

  it("an agent without a sandbox has no egress to widen", async () => {
    const s = await setup([], { tools: ["egress_policy"] });
    expect(await run(s.ws, "egress_policy", { allow: [{ host: "example.com" }] })).toMatchObject({ status: "error", error: { code: "not_bound" } });
  });
});

// --- Rollback: approvals rows of the previous release -----------------------------------------------------------

describe("approvals of the previous release", () => {
  it("a row written without `tool` (a remote MCP tool's) is still decided, and the turn names mcp__nest__<name>", async () => {
    const s = await setup([]);
    await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => {
      const sql = st.storage.sql;
      sql.exec("DROP TABLE approvals");
      sql.exec(`CREATE TABLE approvals (ask TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL, expires_ms INTEGER, used_by TEXT, created_ms INTEGER NOT NULL)`);
      sql.exec("INSERT INTO approvals (ask, name, digest, status, created_ms) VALUES ('ask_old', 'notes_put', 'd', 'pending', ?)", Date.now());
      sql.exec("INSERT INTO asks (ask, call, epoch, question, status, deadline, created_ms) VALUES ('ask_old', 'cal_old', 1, 'q', 'async', 0, 0)");
      new CallLedger(sql); // this release's constructor on the old shape
    });
    await answer(s.agent, "ask_old", "approve");
    expect(await lastTurn(s.agent)).toMatchObject({ text: expect.stringContaining("call mcp__nest__notes_put again") });
  });
});

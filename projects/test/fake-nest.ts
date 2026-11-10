// A fake of nest's client interface and of the GitHub API the app calls with the tokens nest mints it: as docs/control-plane/api/clients/ and docs/interfaces/remote-mcp/
// describe it: the routes the app calls (answering as nest does: a create's cell in its body, refused
// outside the grant's; a create's Idempotency-Key replayed, conflicting or in progress), the JWKS behind Nest-Identity, and helpers that sign identity tokens, Access tokens and
// webhooks the way nest and Cloudflare do. It replaces the global fetch, which the Worker and its Durable
// Objects share with the tests in the pool, and records every call.

import { env, SELF } from "cloudflare:test";
import { GITHUB_API, signGithub } from "../src/github";
import { sign as signWebhook } from "../src/webhook";

export const NEST = "https://nest.test";
export const APP = "https://projects.test";
export const CLIENT = "cli_app";
export const CELL = "use1";
export const TEAM = "https://team.cloudflareaccess.com";
export const AUD = "aud-of-the-projects-application";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

export interface FakeAgent {
  agent: string;
  owner: string;
  client: string | null;
  labels: Record<string, string>;
  template: string;
  sandbox: string | null;
  overrides: unknown;
  ended: boolean;
  /** nest's `state` to report (idle by default), and its start's capacity waits. */
  state?: string;
  capacityWaits?: number;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth: string | null;
  idempotencyKey: string | null;
}

/** JSON with sorted keys: a request's identity for its idempotency key, as nest binds one. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);

let seq = 0;
const id = (prefix: string) => `${prefix}${(++seq).toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;

export class FakeNest {
  readonly github = new FakeGitHub();
  /** The App nest's token answers name; null: nest can't tell, and the answers leave it out. */
  githubApp: { app_id: number; app_slug: string } | null = { app_id: GH_APP_ID, app_slug: "nest-test" };
  readonly calls: Call[] = [];
  readonly agents = new Map<string, FakeAgent>();
  readonly sandboxes = new Map<string, { sandbox: string; owner: string; labels: Record<string, string>; ended: boolean; github_push?: { workflows: boolean } | null; layer: { egress: { allow: unknown[] }; inject: unknown[]; env: Record<string, string> } }>();
  /** The grant's `egress_hosts` (docs/control-plane/api/clients/#egress), as `GET /v1/clients/self` answers it. */
  egressHosts: string[] = ["registry.npmjs.org", "nodejs.org", "*.pythonhosted.org", "pypi.org"];
  /** nest's defaults, as each sandbox's effective policy shows them (layer `base`). */
  baseRules: { host: string; ports: number[] }[] = [{ host: "github.com", ports: [443] }];
  /** The operator's own layer, which the effective policy labels `workstream`, as it does the client's own rules. */
  operatorRules: { host: string; ports?: number[] }[] = [{ host: "mirror.internal.example", ports: [8443] }];
  /** The rules nest builds from the repo allowlists (source `repos`, layer `workstream`). */
  reposRules: { host: string; ports?: number[] }[] = [{ host: "api.github.com", ports: [443] }];
  /** Answer the policy as a control plane before nest's `source` did: `layer` only. */
  legacyPolicy = false;
  /** Temporary grants (layer `sandbox`), in every sandbox's effective policy. */
  grantRules: { host: string; ports: number[]; expires_ms: number }[] = [{ host: "approved.example.com", ports: [443], expires_ms: Date.now() + 3_600_000 }];
  /** The client's grant, in the parts the app reads (`GET /v1/clients/self`). */
  grant: { inject_hosts: string[]; secrets: { max_count: number; max_bytes: number }; github_push?: { workflows: boolean } } = {
    inject_hosts: ["api.cloudflare.com", "registry.npmjs.org", "*.example.com"], secrets: { max_count: 50, max_bytes: 4096 }, github_push: { workflows: true },
  };
  /** The client's secrets, values and all: nest's, the only place a value may be. */
  readonly secrets = new Map<string, { value: string; description: string | null; created_ms: number; updated_ms: number; last_injected_ms: number | null }>();
  readonly inbox: { agent: string; text: string; from?: string; request_id?: string }[] = [];
  readonly catalog = new Map<string, unknown>();
  readonly answers: { agent: string; ask: string; answer: string }[] = [];
  readonly interrupts: string[] = [];
  jwks: { keys: unknown[] } = { keys: [] };
  jwksFetches = 0;
  /** Failures to answer, in order, for calls whose `METHOD path` matches. */
  failures: { match: RegExp; status: number; retryable?: boolean; times: number; page?: boolean }[] = [];
  /** Play a control plane from before the push opt-in was in the client layer (nest #157). */
  layerWithoutPush = false;
  /** The repos the client's grant names, lowercased (`github.repos`); null: any (the grant isn't what a test is about). */
  grantRepos: string[] | null = null;
  /** The grant's `repos` (push) when a test needs it to differ from `github.repos`; null: the same as `grantRepos`. */
  pushRepos: string[] | null = null;
  /**
   * nest's answer for the grant's repos (`GET`/`POST /v1/clients/self/grant/repos`), as nest decides it
   * (owner-wide entries included). Null: the grant isn't what a test is about, so it covers `grantRepos`
   * (every repo while that's null too). `"missing"`: a nest from before those routes (404).
   */
  grantListing: { repos: { repo: string; push: boolean; read: boolean; github: boolean }[]; unlisted: string[]; complete: boolean } | null | "missing" = null;
  /** The installation nest's token answer names (`installation_id`); null: none, as a nest from before #219. */
  tokenInstallation: number | null = GH_INSTALLATION_ID;
  /** Calls held until released (a slow answer), each once: `reached` once one is waiting. */
  holds: { match: RegExp; release: Promise<void>; reached: boolean }[] = [];
  /** Creates that are made but whose answer is lost (a 500 instead), as after a timeout. */
  lost: { match: RegExp; times: number }[] = [];
  /** Inbox posts that land but whose answer is lost (a 500), per agent. */
  lostInbox: { agent: string; times: number }[] = [];
  /** Creates answered "still being handled" (409, retryable) before they run. */
  inProgress: { match: RegExp; times: number }[] = [];
  /** Idempotency keys: the request each binds, and its first answer once made. */
  readonly keys = new Map<string, { digest: string; status: number; body: string }>();
  /** Each agent's trace events, as nest's ring holds them (docs/control-plane/api/, "Live trace"). */
  readonly traces = new Map<string, Record<string, unknown>[]>();
  /** Each agent's trace history pages, by the `before` that asks for them ("" for none). */
  readonly histories = new Map<string, Map<string, { events: unknown[]; next_before: string | null }>>();
  /** What a trace upgrade answers instead of a socket, once each (a deploy's 503, say). */
  traceRefusals: { status: number; code: string; retryable: boolean }[] = [];

  /** Record a trace event for `agent` (its next seq), as nest's ring does. */
  pushTrace(agent: string, ev: Record<string, unknown>): Record<string, unknown> {
    const ring = this.traces.get(agent) ?? [];
    const full = { seq: ring.length + 1, ts_ms: Date.now(), ...ev };
    ring.push(full);
    this.traces.set(agent, ring);
    return full;
  }

  /** Answer calls matching `METHOD path` with an error: nest's JSON one, or (`page`) a page that isn't nest's (an edge's, Access's). */
  fail(match: RegExp, status: number, o: { retryable?: boolean; times?: number; page?: boolean } = {}): void {
    this.failures.push({ match, status, retryable: o.retryable, times: o.times ?? 1, page: o.page });
  }

  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const nestErr = (status: number, code: string, message: string, retryable = false) => json(status, { error: { code, message, retryable } });
    if (u.pathname === "/.well-known/jwks.json") {
      this.jwksFetches++;
      return json(200, this.jwks);
    }
    const text = await req.text();
    const call: Call = {
      method: req.method, path: u.pathname, query: u.searchParams, body: text ? JSON.parse(text) : undefined,
      auth: req.headers.get("authorization"), idempotencyKey: req.headers.get("idempotency-key"),
    };
    this.calls.push(call);
    if (call.auth !== `Bearer ${env.NEST_CLIENT_TOKEN}`) return nestErr(401, "unauthorized", "admin or client token required");
    const route = `${req.method} ${u.pathname}`;
    const hold = this.holds.find((x) => !x.reached && x.match.test(route));
    if (hold) {
      hold.reached = true;
      await hold.release;
    }
    const f = this.failures.find((x) => x.times > 0 && x.match.test(route));
    if (f) {
      f.times--;
      if (f.page) return new Response("<html><body>Forbidden</body></html>", { status: f.status, headers: { "content-type": "text/html" } });
      return nestErr(f.status, f.status === 503 ? "internal" : "refused", "injected", f.retryable ?? false);
    }
    if (route !== "POST /v1/sandboxes" && route !== "POST /v1/agents") return this.route(req, u, call);
    // A create: its cell in the body (nest's default, `local`, is outside the grant), and its key.
    if (call.body?.cell !== CELL) return nestErr(403, "forbidden", `cell ${call.body?.cell ?? "local"} is outside the grant`);
    const key = call.idempotencyKey;
    if (key === null) return this.route(req, u, call);
    const digest = `${route} ${canonical(call.body)}`;
    const had = this.keys.get(key);
    if (had && had.digest !== digest) return nestErr(409, "conflict", "this Idempotency-Key was used for a different request", false);
    const busy = this.inProgress.find((x) => x.times > 0 && x.match.test(key));
    if (busy) {
      busy.times--;
      return nestErr(409, "conflict", "a request with this Idempotency-Key is still being handled", true);
    }
    if (had) {
      return new Response(had.body, { status: had.status, headers: { "content-type": "application/json", "idempotent-replayed": "true" } });
    }
    const res = await this.route(req, u, call);
    if (res.ok) this.keys.set(key, { digest, status: res.status, body: await res.clone().text() });
    const lose = this.lost.find((x) => x.times > 0 && x.match.test(route));
    if (lose) {
      lose.times--;
      return nestErr(500, "internal", "the answer was lost", true);
    }
    return res;
  }

  private async route(req: Request, u: URL, call: Call): Promise<Response> {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const nestErr = (status: number, code: string, message: string, retryable = false) => json(status, { error: { code, message, retryable } });
    const labelsMatch = (have: Record<string, string>) => u.searchParams.getAll("label").every((l) => {
      const i = l.indexOf("=");
      return have[l.slice(0, i)] === l.slice(i + 1);
    });
    let m: RegExpMatchArray | null;
    const r = `${req.method} ${u.pathname}`;
    // nest's env rules (docs/control-plane/api/clients/#environment): names, and a placeholder value only
    // as exactly the placeholder of a binding declared beside it.
    const envProblem = (vars: Record<string, string> | undefined, inject: { name: string }[]) => {
      const entries = Object.entries(vars ?? {});
      if (entries.length > 64) return "at most 64 variables";
      for (const [k, v] of entries) {
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k) || ["PATH", "HOME", "GITHUB_TOKEN"].includes(k) || k.startsWith("NEST_")) return `env: ${k} isn't allowed`;
        if (v.includes("nest-ph.") && !inject.some((b) => v === `nest-ph.${CLIENT}.${b.name}.`)) return `env: ${k} holds a placeholder of no binding beside it`;
      }
      return null;
    };
    if (r === "POST /v1/sandboxes") {
      // A client's own bindings and workflows, within its grant (docs/control-plane/api/clients/#injection).
      const inject = (call.body.inject ?? []) as { name: string; secret: string; hosts: string[] }[];
      for (const b of inject) {
        const outside = b.hosts.filter((h) => !this.grant.inject_hosts.includes(h) && !this.grant.inject_hosts.some((a) => a.startsWith("*.") && h.endsWith(a.slice(1))));
        if (outside.length) return nestErr(403, "forbidden", `inject hosts ${outside.join(", ")} are outside the grant`);
      }
      if (inject.length > 16) return nestErr(400, "invalid", "at most 16 bindings");
      const bad = envProblem(call.body.env, inject);
      if (bad) return nestErr(400, "invalid_message", bad);
      if (call.body.github_push?.workflows && !this.grant.github_push?.workflows) return nestErr(403, "forbidden", "github_push.workflows is outside the grant");
      // Its client layer starts as its create's egress, bindings and env (docs/control-plane/api/clients/#the-client-layer).
      const s = {
        sandbox: id("sbx_"), owner: CLIENT, labels: call.body.labels ?? {}, ended: false, github_push: call.body.github_push ?? null,
        layer: { egress: { allow: call.body.egress?.allow ?? [] }, inject, env: call.body.env ?? {} },
      };
      this.sandboxes.set(s.sandbox, s);
      return json(202, { sandbox: s.sandbox, cell: call.body.cell, labels: s.labels, host: null });
    }
    if ((m = u.pathname.match(/^\/v1\/sandboxes\/(sbx_[A-Za-z0-9]+)\/(client-policy|policy)$/))) {
      const sb = this.sandboxes.get(m[1]!);
      if (!sb || sb.owner !== CLIENT) return nestErr(404, "unknown_sandbox", "unknown sandbox");
      if (sb.ended) return nestErr(409, "forbidden", "sandbox is destroyed");
      if (m[2] === "policy" && req.method === "GET") {
        // As nest's policy view (docs/sandbox/networking/egress/policy/#sources): each rule's `source`, and
        // its `layer` (`base`; `workstream` for the operator's, the repo allowlists' and the client's own,
        // no ports being 80 and 443; `sandbox` for grants). An older control plane answers `layer` only.
        const rule = (r: { host: string; ports?: number[]; expires_ms?: number }, layer: string, source: string) =>
          ({ ...r, host: r.host, ports: r.ports ?? [80, 443], layer, ...(this.legacyPolicy ? {} : { source }) });
        return json(200, {
          version: 1,
          allow: [
            ...this.baseRules.map((b) => rule(b, "base", "base")),
            ...this.operatorRules.map((b) => rule(b, "workstream", "operator")),
            ...this.reposRules.map((b) => rule(b, "workstream", "repos")),
            ...(sb.layer.egress.allow as { host: string; ports?: number[] }[]).map((x) => rule(x, "workstream", "client")),
            ...this.grantRules.map((g) => rule(g, "sandbox", "grant")),
          ],
          passthrough: [],
        });
      }
      // nest answers its bindings as held: whose they are and the placeholder it assigned (`HeldInjection`).
      if (req.method === "GET") {
        return json(200, {
          ...sb.layer, inject: (sb.layer.inject as { name: string }[]).map((b) => ({ ...b, client: CLIENT, placeholder: `nest-ph.${CLIENT}.${b.name}.` })),
          // The push opt-in (nest #157), unless this fake plays a control plane from before it.
          ...(this.layerWithoutPush ? {} : { github_push: { workflows: !!sb.github_push?.workflows } }),
        });
      }
      if (req.method === "PUT") {
        // nest's checks: the whole layer replaced, each binding a strict `ClientInjection`, its egress within
        // the grant's egress_hosts.
        const BINDING_KEYS = ["name", "secret", "hosts", "locations", "wildcard"];
        const extra = ((call.body?.inject ?? []) as Record<string, unknown>[]).flatMap((b) => Object.keys(b).filter((k) => !BINDING_KEYS.includes(k)));
        if (extra.length) return nestErr(400, "invalid_message", `inject: unrecognized key "${extra[0]}"`);
        const allow = (call.body?.egress?.allow ?? []) as { host: string }[];
        const outside = allow.filter((x) => !this.egressHosts.some((h) => h === x.host || (h.startsWith("*.") && x.host.endsWith(h.slice(1)))));
        if (outside.length) return nestErr(403, "forbidden", `egress host ${outside[0]!.host} is outside the grant`);
        const inject = (call.body?.inject ?? []) as { name: string; hosts: string[] }[];
        const injectOutside = inject.flatMap((b) => b.hosts).filter((h) => !this.grant.inject_hosts.includes(h) && !this.grant.inject_hosts.some((a) => a.startsWith("*.") && h.endsWith(a.slice(1))));
        if (injectOutside.length) return nestErr(403, "forbidden", `inject host ${injectOutside[0]} is outside the grant`);
        const bad = envProblem(call.body?.env, inject);
        if (bad) return nestErr(400, "invalid_message", bad);
        if (call.body?.github_push !== undefined && this.layerWithoutPush) return nestErr(400, "invalid_message", 'unrecognized key "github_push"');
        if (call.body?.github_push?.workflows && !this.grant.github_push?.workflows) return nestErr(403, "forbidden", "github_push.workflows is outside the grant");
        sb.layer = { egress: { allow }, inject: call.body?.inject ?? [], env: call.body?.env ?? {} };
        // Replaced whole: left out, it's off (an older control plane: as it was).
        if (!this.layerWithoutPush) sb.github_push = call.body?.github_push?.workflows ? { workflows: true } : null;
        return json(200, { version: 2 });
      }
    }
    if (req.method === "DELETE" && (m = u.pathname.match(/^\/v1\/sandboxes\/(sbx_[A-Za-z0-9]+)$/))) {
      // Destroy a sandbox (owner auth): ended. Its attached agents are left as they are, as nest's
      // SandboxDO.destroy leaves them (an agent is ended only by its own stop).
      const sb = this.sandboxes.get(m[1]!);
      if (!sb || sb.owner !== CLIENT) return nestErr(404, "unknown_sandbox", "unknown sandbox");
      sb.ended = true;
      return json(200, { sandbox: sb.sandbox, state: "destroyed" });
    }
    if (r === "GET /v1/sandboxes") {
      const rows = [...this.sandboxes.values()].filter((s) => !s.ended && labelsMatch(s.labels));
      return json(200, { sandboxes: rows.map((s) => ({ sandbox: s.sandbox, cell: CELL, client: CLIENT, owner: s.owner, labels: s.labels, created_ms: 1, ended_ms: null })), next_cursor: null });
    }
    if (r === "POST /v1/agents") {
      const a: FakeAgent = {
        agent: id("agt_"), owner: CLIENT, client: CLIENT, labels: call.body.labels ?? {}, template: call.body.template,
        sandbox: call.body.sandbox ?? null, overrides: call.body.overrides, ended: false,
      };
      this.agents.set(a.agent, a);
      return json(201, { ...this.view(a), started: null });
    }
    if (r === "GET /v1/agents") {
      const rows = [...this.agents.values()].filter((a) => !a.ended && labelsMatch(a.labels));
      return json(200, { agents: rows.map((a) => ({ agent: a.agent, cell: CELL, client: a.client, owner: a.owner, labels: a.labels, created_ms: 1, ended_ms: null })), next_cursor: null });
    }
    if ((m = u.pathname.match(/^\/v1\/agents\/(agt_[A-Za-z0-9]+)(\/.*)?$/))) {
      const a = this.agents.get(m[1]!);
      if (!a || a.client !== CLIENT) return nestErr(404, "unknown_agent", "unknown agent");
      const sub = m[2] ?? "";
      if (req.method === "GET" && sub === "") return json(200, this.view(a));
      if (req.method === "GET" && sub === "/trace/history") {
        const page = this.histories.get(a.agent)?.get(u.searchParams.get("before") ?? "");
        return page ? json(200, page) : nestErr(400, "invalid_message", "before is not a cursor the trace gave");
      }
      if (req.method === "GET" && sub === "/trace") {
        if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return nestErr(426, "invalid_message", "expected a WebSocket upgrade");
        const refusal = this.traceRefusals.shift();
        if (refusal) return nestErr(refusal.status, refusal.code, "refused", refusal.retryable);
        // As nest answers it: the backlog after `after`, `live`, then what `pushTrace` sends.
        const after = Number(u.searchParams.get("after") ?? 0);
        const pair = new WebSocketPair();
        const server = pair[1];
        server.accept();
        for (const ev of (this.traces.get(a.agent) ?? []).filter((e) => (e.seq as number) > after)) server.send(JSON.stringify(ev));
        server.send(JSON.stringify({ type: "live" }));
        // A socket can only be used from the request that made it (workerd's rule), so a test drives this one
        // through itself: `{fake: "push", event}` records an event and sends it here; `{fake: "drop"}` closes it.
        server.addEventListener("message", (e) => {
          const m = JSON.parse(e.data as string) as { fake?: string; event?: Record<string, unknown> };
          if (m.fake === "push") server.send(JSON.stringify(this.pushTrace(a.agent, m.event ?? {})));
          if (m.fake === "drop") server.close(1011, "dropped");
        });
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (req.method === "POST" && sub === "/inbox") {
        const dup = call.body.request_id && this.inbox.some((x) => x.agent === a.agent && x.request_id === call.body.request_id);
        if (!dup) this.inbox.push({ agent: a.agent, text: call.body.text, from: call.body.from, request_id: call.body.request_id });
        // Posted, but the answer lost (as after a timeout): a retry with the same request id lands once.
        const lose = this.lostInbox.find((x) => x.times > 0 && x.agent === a.agent);
        if (lose) {
          lose.times--;
          return nestErr(500, "internal", "the answer was lost", true);
        }
        return json(201, { message: { seq: this.inbox.length } });
      }
      if (req.method === "POST" && sub === "/interrupt") {
        this.interrupts.push(a.agent);
        return json(200, { interrupted: a.ended ? "none" : "turn" });
      }
      if (req.method === "POST" && sub === "/stop") {
        // As nest: a stop of an agent that ended already destroys no sandbox.
        const was = a.ended;
        a.ended = !!call.body?.end || was;
        if (!was && a.ended && call.body?.destroy_sandbox && a.sandbox) this.sandboxes.get(a.sandbox)!.ended = true;
        return json(200, { status: "stopped" });
      }
      if (req.method === "POST" && (m = sub.match(/^\/asks\/(ask_[A-Za-z0-9]+)\/answer$/))) {
        this.answers.push({ agent: a.agent, ask: m[1]!, answer: call.body.answer });
        return json(200, { delivered: true });
      }
    }
    if (req.method === "DELETE" && (m = u.pathname.match(/^\/v1\/catalog\/(templates|capabilities)\/([a-z][a-z0-9-]+)\/([a-z][a-z0-9-]*)$/))) {
      if (m[2] !== "projects") return nestErr(403, "forbidden", `${m[2]} is not your namespace (projects)`);
      this.catalog.delete(`${m[1]}/${m[2]}/${m[3]}`);
      return json(200, { ok: true });
    }
    if (req.method === "PUT" && (m = u.pathname.match(/^\/v1\/catalog\/(templates|capabilities)\/([a-z][a-z0-9-]+)\/([a-z][a-z0-9-]*)$/))) {
      if (m[2] !== "projects") return nestErr(403, "forbidden", `${m[2]} is not your namespace (projects)`);
      this.catalog.set(`${m[1]}/${m[2]}/${m[3]}`, call.body);
      return json(200, { ok: true });
    }
    if ((r === "GET /v1/clients/self/grant/repos" || r === "POST /v1/clients/self/grant/repos") && this.grantListing === "missing") return nestErr(404, "not_found", "no route");
    const all = (repo: string) => ({ repo, push: true, read: true, github: true });
    const listing = this.grantListing === "missing" ? null : this.grantListing ?? { repos: (this.grantRepos ?? []).map(all), unlisted: [], complete: true };
    if (r === "GET /v1/clients/self/grant/repos") return json(200, listing);
    if (r === "POST /v1/clients/self/grant/repos") {
      const covered = (x: string) => listing!.repos.find((l) => l.repo === x) ?? (this.grantListing === null && this.grantRepos === null ? all(x) : { repo: x, push: false, read: false, github: false });
      return json(200, { repos: (call.body as { repos: string[] }).repos.map((x) => covered(x.toLowerCase())) });
    }
    if (r === "GET /v1/clients/self") return json(200, { client: CLIENT, name: "projects", grant: { ...this.grant, egress_hosts: this.egressHosts, repos: this.pushRepos ?? this.grantRepos ?? [], github: { repos: this.grantRepos ?? [], permissions: { ...GRANT_PERMISSIONS } } }, created_ms: 1 });
    if (r === "GET /v1/clients/self/secrets") {
      return json(200, { secrets: [...this.secrets].sort(([a], [b]) => a.localeCompare(b)).map(([name, x]) => ({ name, description: x.description, size: new TextEncoder().encode(x.value).length, created_ms: x.created_ms, updated_ms: x.updated_ms, last_injected_ms: x.last_injected_ms })) });
    }
    if ((m = u.pathname.match(/^\/v1\/clients\/self\/secrets\/([^/]+)$/))) {
      const name = decodeURIComponent(m[1]!);
      if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name)) return nestErr(400, "invalid", "a secret's name is [a-z][a-z0-9_-]{0,62}");
      if (req.method === "DELETE") return this.secrets.delete(name) ? json(200, { ok: true }) : nestErr(404, "not_found", "no such secret");
      if (req.method === "PUT") {
        const { value, description } = call.body as { value: string; description?: string };
        const size = new TextEncoder().encode(value).length;
        if (size > this.grant.secrets.max_bytes) return nestErr(403, "forbidden", "larger than the grant's secrets.max_bytes");
        const had = this.secrets.get(name);
        if (!had && this.secrets.size >= this.grant.secrets.max_count) return nestErr(403, "forbidden", "the grant's secrets.max_count is reached");
        const now = Date.now();
        this.secrets.set(name, { value, description: description ?? null, created_ms: had?.created_ms ?? now, updated_ms: now, last_injected_ms: had?.last_injected_ms ?? null });
        return json(200, { name, description: description ?? null, size, created_ms: had?.created_ms ?? now, updated_ms: now, last_injected_ms: had?.last_injected_ms ?? null });
      }
    }
    if (r === "POST /v1/clients/self/github-token") {
      // Within the grant (README.md#how-it-uses-nest), as nest checks it: the repo and each permission.
      const { repo, permissions } = call.body as { repo: string; permissions: Record<string, string> };
      if (!Object.keys(permissions ?? {}).length) return nestErr(400, "invalid", "name at least one permission");
      for (const [k, v] of Object.entries(permissions)) {
        if (!levelWithin(v, GRANT_PERMISSIONS[k])) return nestErr(403, "forbidden", `${k}: ${v} is outside the grant`);
      }
      if (this.grantRepos && !this.grantRepos.includes(repo.toLowerCase())) return nestErr(403, "forbidden", `${repo} is outside the grant`);
      const token = this.github.mint(repo, permissions);
      // The App it's from (docs/control-plane/api/clients/#github-tokens), unless nest can't tell.
      const app = this.githubApp ? { app_id: this.githubApp.app_id, app_slug: this.githubApp.app_slug } : {};
      // And the installation it was minted from (one installation in this fake).
      // The installation it's minted from, unless the test plays a nest from before it was named.
      const installation = this.tokenInstallation === null ? {} : { installation_id: this.tokenInstallation };
      return json(200, { token, expires_at: new Date(Date.now() + 3600_000).toISOString(), repo: repo.toLowerCase(), permissions, ...installation, ...app });
    }
    return nestErr(404, "not_found", `no route for ${r}`);
  }

  view(a: FakeAgent) {
    // As nest's `info()` answers: `ended` once it ended; the brain's host while it has one.
    const state = a.state ?? "idle";
    return {
      agent: a.agent, owner: a.owner, client: a.client, labels: a.labels, state: a.ended ? "ended" : state, template: a.template,
      host: a.ended || state === "starting" ? null : "bh_1", capacity_waits: a.capacityWaits ?? 0,
      hands: a.sandbox ? { sandbox: a.sandbox } : null,
      ...(a.ended ? { ended: { ms: 1, by: "client", reason: "stopped" } } : {}),
    };
  }

  /** An agent nest has but the app didn't record (another client's, or one an agent spawned). */
  plant(a: Partial<FakeAgent> & { labels: Record<string, string> }): FakeAgent {
    const full: FakeAgent = { agent: id("agt_"), owner: CLIENT, client: CLIENT, template: "x", sandbox: null, overrides: undefined, ended: false, ...a };
    this.agents.set(full.agent, full);
    return full;
  }
}

/** Install `fake` as nest (and Cloudflare Access's certs, when given) for the Worker and its objects. */
export function installFetch(fake: FakeNest, access?: () => unknown): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.origin === NEST) return fake.handle(req);
    if (u.origin === GITHUB_API) return fake.github.handle(req);
    if (access && req.url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(access());
    throw new Error(`unexpected fetch ${req.url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

// --- Nest-Identity ---------------------------------------------------------------------------------

export class Signer {
  constructor(readonly key: CryptoKeyPair, readonly kid: string) {}

  static async create(kid = "k1"): Promise<Signer> {
    return new Signer((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair, kid);
  }

  async jwk(): Promise<unknown> {
    const j = (await crypto.subtle.exportKey("jwk", this.key.publicKey)) as JsonWebKey;
    return { kty: "OKP", crv: "Ed25519", x: j.x, kid: this.kid, alg: "EdDSA", use: "sig" };
  }

  async sign(claims: Record<string, unknown>, o: { kid?: string; alg?: string } = {}): Promise<string> {
    const h = b64urlJson({ alg: o.alg ?? "EdDSA", typ: "JWT", kid: o.kid ?? this.kid });
    const p = b64urlJson(claims);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, this.key.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }
}

const nowS = () => Math.floor(Date.now() / 1000);

/** The claims nest puts on an agent's session token for one of the app's servers. */
export function agentClaims(server: "board" | "task" | "review" | "routine", agent: string, labels: Record<string, string>, over: Record<string, unknown> = {}) {
  return {
    iss: NEST, aud: `${APP}/mcp/${server}`, sub: agent, owner: CLIENT, client: CLIENT, labels, epoch: 1, tainted: false,
    iat: nowS(), exp: nowS() + 300, ...over,
  };
}

export const connectorClaims = (server: "board" | "task" | "review" | "routine") => ({ iss: NEST, aud: `${APP}/mcp/${server}`, sub: "nest:connector", iat: nowS(), exp: nowS() + 300 });

let rpcId = 0;
/** One JSON-RPC message to an MCP server, as nest sends it. */
export function mcp(server: string, token: string | null, method: string, params?: unknown): Promise<Response> {
  const isNotification = method.startsWith("notifications/");
  return SELF.fetch(`${APP}/mcp/${server}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { "nest-identity": token } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(isNotification ? {} : { id: ++rpcId }), method, ...(params === undefined ? {} : { params }) }),
  });
}

/** `tools/call` and its parsed answer. */
export async function callTool(server: string, token: string, name: string, args: unknown = {}, meta?: Record<string, unknown>): Promise<{ status: number; result?: any; error?: any }> {
  const res = await mcp(server, token, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as any;
  return { status: 200, result: body.result, error: body.error };
}

// --- Cloudflare Access -----------------------------------------------------------------------------

export class AccessTeam {
  constructor(readonly key: CryptoKeyPair) {}

  static async create(): Promise<AccessTeam> {
    return new AccessTeam((await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
    )) as CryptoKeyPair);
  }

  async certs(): Promise<unknown> {
    return { keys: [{ ...((await crypto.subtle.exportKey("jwk", this.key.publicKey)) as JsonWebKey), kid: "ak1", alg: "RS256", use: "sig" }] };
  }

  async token(over: Record<string, unknown> = {}): Promise<string> {
    const h = b64urlJson({ alg: "RS256", kid: "ak1", typ: "JWT" });
    const p = b64urlJson({ iss: TEAM, aud: [AUD], exp: nowS() + 600, iat: nowS() - 5, email: "owner@example.com", ...over });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.key.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }
}

/** A call to the app's JSON API with an Access token. */
export async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`${APP}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// --- nest's webhook --------------------------------------------------------------------------------

/** POST one event to /hooks/nest, signed as nest signs it (or with what `o` changes). */
export async function deliver(event: Record<string, unknown>, o: { secret?: string; t?: number; header?: string } = {}): Promise<Response> {
  const body = JSON.stringify(event);
  const t = o.t ?? Date.now();
  const header = o.header ?? `t=${t},v1=${await signWebhook(o.secret ?? env.NEST_WEBHOOK_SECRET!, t, body)}`;
  return SELF.fetch(`${APP}/hooks/nest`, { method: "POST", headers: { "content-type": "application/json", "nest-signature": header }, body });
}

/** Poll until `f` answers truthy (the alarm's work), for up to 5 s. */
export async function eventually<T>(f: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  const until = Date.now() + 5_000;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// --- GitHub --------------------------------------------------------------------------------------------

/** The GitHub App's id, as GitHub answers it in a check run's `app.id`. */
export const GH_APP_ID = 4242;
/** The installation the fake's App tokens are minted from. */
export const GH_INSTALLATION_ID = 777001;

/** The app's grant's `github.permissions` (README.md#how-it-uses-nest). */
export const GRANT_PERMISSIONS: Record<string, string> = { checks: "write", administration: "write", metadata: "read", pull_requests: "write", contents: "write", issues: "write" };
const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
const levelWithin = (want: string, have: string | undefined) => !!have && !!RANK[want] && RANK[want]! <= RANK[have]!;

export interface FakePull {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  ref: string;
  /** The head's repo; null: a fork GitHub no longer names. */
  headRepo: string | null;
  /** GitHub's `updated_at` for it, when the test gives one. */
  updated_at?: string;
}

export interface FakeCheckRun {
  id: number;
  repo: string;
  name: string;
  head_sha: string;
  external_id: string | null;
  details_url: string | null;
  status: string;
  conclusion: string | null;
  output: { title?: string; summary?: string; text?: string } | null;
  app: { id: number };
  updates: any[];
}

/**
 * GitHub's REST API as https://docs.github.com/en/rest/checks/runs and
 * https://docs.github.com/en/rest/branches/branch-protection describe it, for the routes the app calls:
 * each token is a repo's, with its permissions (403 outside them, as GitHub answers an installation
 * token); branch protection is kept in GET's shape and written by PUT and PATCH.
 */
/** A GitHub account's id in the fake: fixed for its login. */
export const ownerIdOf = (login: string) => 10_000 + [...login].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1_000_000, 7);
/** A repo's GitHub id, as the fake gives it (from its first name: a rename keeps it). */
export const repoIdOf = (name: string) => 500_000_000 + [...name.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100_000_000, 11);

export class FakeGitHub {
  /** Accounts that are organizations (a repo's owner is a user otherwise). */
  readonly orgs = new Set<string>();
  readonly calls: { method: string; path: string; body: any; token: string | null }[] = [];
  readonly tokens = new Map<string, { repo: string; permissions: Record<string, string> }>();
  readonly repos = new Map<string, { id: number; default_branch: string; protection: Record<string, any> | null; allow_auto_merge: boolean; owner_id?: number }>();
  /** Renamed or transferred repos, old name to new: the old name answers with the repo, as GitHub's redirect does, until it's taken. */
  readonly renamed = new Map<string, string>();
  /** Each PR's auto-merge, by node id, as GraphQL's mutations leave it. */
  readonly autoMerge = new Map<string, { method: string } | null>();
  /** Each repo's issues (PRs among them, as GitHub lists them), by number, with the comments posted on them. */
  /** Each repo's issues, by number: opened by `user_id` (the repo owner's unless given). */
  readonly issues = new Map<string, Map<number, { title: string; body: string; state: "open" | "closed"; login: string; user_id?: number; pr?: boolean; comments: string[]; state_reason?: string }>>();
  /** Each repo's PRs, by number. */
  readonly pulls = new Map<string, Map<number, FakePull>>();
  /** GraphQL errors to answer (a 200 with `errors`), for mutations whose name matches. */
  gqlErrors: { match: RegExp; message: string; times: number }[] = [];
  readonly checkRuns = new Map<number, FakeCheckRun>();
  failures: { match: RegExp; status: number; times: number; message?: string }[] = [];
  /** Check-run creates and issue comments that are made but whose answer is lost (a 502), as after a timeout. */
  lost: { match: RegExp; times: number }[] = [];
  private nextId = 1000;

  mint(repo: string, permissions: Record<string, string>): string {
    // Low in entropy and made at run time (dev/review-lessons.md 9).
    const token = `ghs_fake${(++this.nextId).toString().padStart(8, "0")}`;
    this.tokens.set(token, { repo: repo.toLowerCase(), permissions });
    return token;
  }

  /** A PR on `repo` (open, from the repo itself, unless `o` says otherwise). */
  pull(repo: string, number: number, o: Partial<Omit<FakePull, "number">> = {}): FakePull {
    const k = repo.toLowerCase();
    if (!this.pulls.has(k)) this.pulls.set(k, new Map());
    const p: FakePull = { number, title: `PR ${number}`, state: "open", merged: false, ref: `feature-${number}`, headRepo: k, ...o };
    this.pulls.get(k)!.set(number, p);
    return p;
  }

  fail(match: RegExp, status: number, o: { times?: number; message?: string } = {}): void {
    this.failures.push({ match, status, times: o.times ?? 1, message: o.message });
  }

  repo(name: string) {
    const k = name.toLowerCase();
    if (!this.repos.has(k)) this.repos.set(k, { id: repoIdOf(k), default_branch: "main", protection: null, allow_auto_merge: false });
    return this.repos.get(k)!;
  }

  /** Rename (or transfer) a repo: its id stays; the old name answers with it until `take` makes it another repo's. */
  rename(from: string, to: string): void {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    this.repos.set(t, this.repo(f));
    this.repos.delete(f);
    // The new name is this repo's now, whatever redirected from it before.
    this.renamed.delete(t);
    this.renamed.set(f, t);
  }

  /** Someone registers a repo under a name a renamed repo had: the old name is that repo's from now on. */
  take(name: string, ownerId?: number): number {
    const k = name.toLowerCase();
    this.renamed.delete(k);
    this.repos.set(k, { id: repoIdOf(k) + 1, default_branch: "main", protection: null, allow_auto_merge: false, ...(ownerId === undefined ? {} : { owner_id: ownerId }) });
    return this.repos.get(k)!.id;
  }

  runsOf(repo: string, sha?: string): FakeCheckRun[] {
    return [...this.checkRuns.values()].filter((c) => c.repo === repo.toLowerCase() && (sha === undefined || c.head_sha === sha));
  }

  callsTo(method: string, path: RegExp) {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const text = await req.text();
    const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
    const call = { method: req.method, path: u.pathname, body: text ? JSON.parse(text) : undefined, token };
    this.calls.push(call);
    const route = `${req.method} ${u.pathname}`;
    if (route === "POST /graphql") {
      const f = this.failures.find((x) => x.times > 0 && x.match.test(route));
      if (f) {
        f.times--;
        return json(f.status, { message: f.message ?? "injected" });
      }
      return this.graphql(call.body, token, json);
    }
    // A public account by login: anyone's token reads it ("ghost-" logins don't exist).
    const um = u.pathname.match(/^\/users\/([^/]+)$/);
    if (um && req.method === "GET") {
      if (!token || !this.tokens.has(token)) return json(401, { message: "Bad credentials" });
      const login = decodeURIComponent(um[1]!);
      if (login.startsWith("ghost-")) return json(404, { message: "Not Found" });
      return json(200, { login, id: ownerIdOf(login.toLowerCase()), type: login.endsWith("[bot]") ? "Bot" : this.orgs.has(login.toLowerCase()) ? "Organization" : "User" });
    }
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (!m) return json(404, { message: "Not Found" });
    // A renamed repo's old name is the repo (GitHub redirects it), as is a token minted for the old name.
    const asked = m[1]!.toLowerCase();
    const repoName = this.renamed.get(asked) ?? asked;
    const sub = m[2] ?? "";
    const t = token ? this.tokens.get(token) : undefined;
    if (!t) return json(401, { message: "Bad credentials" });
    if ((this.renamed.get(t.repo) ?? t.repo) !== repoName) return json(404, { message: "Not Found" });
    const need = (perm: string, level: string) => levelWithin(level, t.permissions[perm]);
    const denied = () => json(403, { message: "Resource not accessible by integration" });
    const f = this.failures.find((x) => x.times > 0 && x.match.test(route));
    if (f) {
      f.times--;
      return json(f.status, { message: f.message ?? "injected" });
    }
    const repo = this.repo(repoName);
    let s: RegExpMatchArray | null;

    // Merge settings are shown only to contents: read and write
    // (https://docs.github.com/en/rest/repos/repos#get-a-repository).
    // Its owner: the account in its name, a user unless the test made it an org.
    const owner = repoName.split("/")[0]!;
    const repoView = () => ({
      id: repo.id, full_name: repoName, default_branch: repo.default_branch, owner: { login: owner, id: repo.owner_id ?? ownerIdOf(owner), type: this.orgs.has(owner) ? "Organization" : "User" },
      ...(need("contents", "write") ? { allow_auto_merge: repo.allow_auto_merge } : {}),
    });
    if (req.method === "GET" && sub === "") {
      // Metadata, which GitHub grants every installation token; the fake asks for it named.
      if (!need("metadata", "read")) return denied();
      return json(200, repoView());
    }
    if (req.method === "PATCH" && sub === "") {
      // Administration: write (https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
      if (!need("administration", "write")) return denied();
      if (typeof call.body?.allow_auto_merge === "boolean") repo.allow_auto_merge = call.body.allow_auto_merge;
      return json(200, repoView());
    }
    if ((s = sub.match(/^\/branches\/([^/]+)\/protection(\/required_status_checks)?$/))) {
      if (decodeURIComponent(s[1]!) !== repo.default_branch) return json(404, { message: "Branch not found" });
      if (!need("administration", req.method === "GET" ? "read" : "write")) return denied();
      const p = repo.protection;
      if (!s[2]) {
        if (req.method === "GET") return p ? json(200, p) : json(404, { message: "Branch not protected" });
        if (req.method === "PUT") {
          for (const k of ["required_status_checks", "enforce_admins", "required_pull_request_reviews", "restrictions"]) {
            if (!(k in call.body)) return json(422, { message: `${k} is required` });
          }
          repo.protection = protectionFromPut(call.body, p, this.appOf(repoName));
          return json(200, repo.protection);
        }
      } else {
        const rsc = p?.required_status_checks;
        if (!rsc) return json(404, { message: "Required status checks not enabled" });
        if (req.method === "GET") return json(200, rsc);
        if (req.method === "PATCH") {
          p.required_status_checks = statusChecksFrom({ ...call.body, strict: call.body.strict ?? rsc.strict }, this.appOf(repoName), rsc);
          return json(200, p.required_status_checks);
        }
      }
    }
    // Issues (https://docs.github.com/en/rest/issues): Issues: read to list, write to comment and close.
    if (req.method === "GET" && sub === "/issues") {
      if (!need("issues", "read")) return denied();
      const page = Number(u.searchParams.get("page") ?? "1");
      const per = Number(u.searchParams.get("per_page") ?? "30");
      const open = [...(this.issues.get(repoName) ?? new Map()).entries()].filter(([, i]) => i.state === "open").sort(([a], [b]) => a - b);
      return json(200, open.slice((page - 1) * per, page * per).map(([n, i]) => ({
        number: n, title: i.title, body: i.body, state: i.state, user: { login: i.login, id: i.user_id ?? ownerIdOf(repoName.split("/")[0]!) }, html_url: `https://github.com/${repoName}/issues/${n}`,
        ...(i.pr ? { pull_request: { url: `https://api.github.com/repos/${repoName}/pulls/${n}` } } : {}),
      })));
    }
    if (req.method === "GET" && (s = sub.match(/^\/issues\/(\d+)\/comments$/))) {
      // Every comment: the fake keeps no times, so `since` (a filter) is answered as if all were newer.
      if (!need("issues", "read")) return denied();
      const i = this.issues.get(repoName)?.get(Number(s[1]));
      if (!i) return json(404, { message: "Not Found" });
      return json(200, i.comments.slice(0, Number(u.searchParams.get("per_page") ?? "30")).map((body, k) => ({ id: k + 1, body })));
    }
    if ((s = sub.match(/^\/issues\/(\d+)(\/comments)?$/)) && (req.method === "POST" || req.method === "PATCH")) {
      if (!need("issues", "write")) return denied();
      const i = this.issues.get(repoName)?.get(Number(s[1]));
      if (!i) return json(404, { message: "Not Found" });
      if (s[2] && req.method === "POST") {
        i.comments.push(call.body.body);
        const lose = this.lost.find((x) => x.times > 0 && x.match.test(route));
        if (lose) {
          lose.times--;
          return json(502, { message: "Server Error" });
        }
        return json(201, { id: ++this.nextId });
      }
      if (!s[2] && req.method === "PATCH") {
        if (call.body.state) i.state = call.body.state;
        if (call.body.state_reason) i.state_reason = call.body.state_reason;
        return json(200, { number: Number(s[1]), state: i.state });
      }
    }
    // PRs (https://docs.github.com/en/rest/pulls/pulls): Pull requests: read.
    if (req.method === "GET" && (sub === "/pulls" || (s = sub.match(/^\/pulls\/(\d+)$/)))) {
      if (!need("pull_requests", "read")) return denied();
      const view = (p: FakePull) => ({
        number: p.number, title: p.title, state: p.state, merged: p.merged, merged_at: p.merged ? "2026-11-02T00:00:00Z" : null, node_id: prNode(repoName, p.number),
        head: { ref: p.ref, repo: p.headRepo === null ? null : { full_name: p.headRepo } }, html_url: `https://github.com/${repoName}/pull/${p.number}`,
        ...(p.updated_at ? { updated_at: p.updated_at } : {}),
      });
      const mine = [...(this.pulls.get(repoName)?.values() ?? [])];
      if (sub === "/pulls") return json(200, mine.filter((p) => p.state === "open").map(view));
      const p = this.pulls.get(repoName)?.get(Number(s![1]));
      return p ? json(200, view(p)) : json(404, { message: "Not Found" });
    }
    if (sub === "/check-runs" && req.method === "POST") {
      if (!need("checks", "write")) return denied();
      const b = call.body;
      if (typeof b.name !== "string" || !/^[0-9a-f]{40}$/.test(b.head_sha ?? "")) return json(422, { message: "Invalid request" });
      const run: FakeCheckRun = {
        id: ++this.nextId, repo: repoName, name: b.name, head_sha: b.head_sha, external_id: b.external_id ?? null, details_url: b.details_url ?? null,
        status: b.status ?? "queued", conclusion: b.conclusion ?? null, output: b.output ?? null, app: { id: GH_APP_ID }, updates: [],
      };
      this.checkRuns.set(run.id, run);
      const lose = this.lost.find((x) => x.times > 0 && x.match.test(route));
      if (lose) {
        lose.times--;
        return json(502, { message: "Server Error" });
      }
      return json(201, run);
    }
    if ((s = sub.match(/^\/check-runs\/(\d+)$/)) && req.method === "PATCH") {
      if (!need("checks", "write")) return denied();
      const run = this.checkRuns.get(Number(s[1]));
      if (!run || run.repo !== repoName) return json(404, { message: "Not Found" });
      const b = call.body;
      if (b.status === "completed" && !b.conclusion) return json(422, { message: "conclusion is required when status is completed" });
      run.updates.push(b);
      if (b.conclusion) {
        run.status = "completed";
        run.conclusion = b.conclusion;
      } else if (b.status) run.status = b.status;
      if (b.output) run.output = b.output;
      return json(200, run);
    }
    if ((s = sub.match(/^\/commits\/([0-9a-f]{40})\/check-runs$/)) && req.method === "GET") {
      if (!need("checks", "read")) return denied();
      const name = u.searchParams.get("check_name");
      const runs = this.runsOf(repoName, s[1]).filter((r) => !name || r.name === name);
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    return json(404, { message: `no route for ${route}` });
  }

  /** GraphQL's auto-merge mutations, on a PR named by its node id (`prNode`), for a token of its repo. */
  private graphql(body: any, token: string | null, json: (status: number, body: unknown) => Response): Response {
    const t = token ? this.tokens.get(token) : undefined;
    if (!t) return json(401, { message: "Bad credentials" });
    const query = String(body?.query ?? "");
    const name = /enablePullRequestAutoMerge|disablePullRequestAutoMerge/.exec(query)?.[0];
    const id = String(body?.variables?.id ?? "");
    const target = nodeTarget(id);
    if (!name || !target) return json(200, { errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${id}'` }] });
    if (target.repo !== t.repo) return json(200, { errors: [{ type: "NOT_FOUND", message: `Could not resolve to a node with the global id of '${id}'` }] });
    if (!levelWithin("write", t.permissions.pull_requests) || !levelWithin("write", t.permissions.contents)) {
      return json(200, { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] });
    }
    const injected = this.gqlErrors.find((e) => e.times > 0 && e.match.test(name));
    if (injected) {
      injected.times--;
      return json(200, { errors: [{ message: injected.message }] });
    }
    if (name === "enablePullRequestAutoMerge") {
      if (!this.repo(target.repo).allow_auto_merge) return json(200, { errors: [{ type: "UNPROCESSABLE", message: "Pull request Auto merge is not allowed for this repository" }] });
      const method = body.variables.method;
      if (!["SQUASH", "MERGE", "REBASE"].includes(method)) return json(200, { errors: [{ message: `Variable $method of type PullRequestMergeMethod! was provided invalid value` }] });
      this.autoMerge.set(id, { method });
    } else {
      this.autoMerge.set(id, null);
    }
    return json(200, { data: { [name]: { pullRequest: { id } } } });
  }

  /** The app that "recently provided" each check on the repo, as GitHub picks one for an omitted app_id. */
  private appOf(repo: string): (context: string) => number | null {
    return (context) => (this.runsOf(repo).some((r) => r.name === context) ? GH_APP_ID : null);
  }
}

/** `required_status_checks` in GET's shape from a PUT's or PATCH's (`app_id` -1: any; omitted: GitHub's pick). */
function statusChecksFrom(b: any, appOf: (c: string) => number | null, before?: any): any {
  let checks: { context: string; app_id: number | null }[];
  if (Array.isArray(b.checks)) checks = b.checks.map((c: any) => ({ context: c.context, app_id: c.app_id === undefined ? appOf(c.context) : c.app_id === -1 ? null : c.app_id }));
  else if (Array.isArray(b.contexts)) checks = b.contexts.map((context: string) => ({ context, app_id: null }));
  else checks = before?.checks ?? [];
  return { url: "u", strict: !!b.strict, contexts: checks.map((c) => c.context), checks, contexts_url: "u" };
}

/** A protection in GET's shape from a PUT body, keeping what PUT doesn't name (required signatures). */
function protectionFromPut(b: any, before: Record<string, any> | null, appOf: (c: string) => number | null): Record<string, any> {
  const flag = (v: unknown) => ({ enabled: v === true });
  const people = (o: any) => ({ users: (o?.users ?? []).map((login: string) => ({ login })), teams: (o?.teams ?? []).map((slug: string) => ({ slug })), apps: (o?.apps ?? []).map((slug: string) => ({ slug })) });
  const r = b.required_pull_request_reviews;
  return {
    url: "u",
    required_status_checks: b.required_status_checks ? statusChecksFrom(b.required_status_checks, appOf) : undefined,
    enforce_admins: { url: "u", enabled: b.enforce_admins === true },
    ...(r ? {
      required_pull_request_reviews: {
        url: "u", dismiss_stale_reviews: !!r.dismiss_stale_reviews, require_code_owner_reviews: !!r.require_code_owner_reviews,
        required_approving_review_count: r.required_approving_review_count ?? 0, require_last_push_approval: !!r.require_last_push_approval,
        ...(r.dismissal_restrictions ? { dismissal_restrictions: people(r.dismissal_restrictions) } : {}),
        ...(r.bypass_pull_request_allowances ? { bypass_pull_request_allowances: people(r.bypass_pull_request_allowances) } : {}),
      },
    } : {}),
    ...(b.restrictions ? { restrictions: people(b.restrictions) } : {}),
    required_linear_history: flag(b.required_linear_history), allow_force_pushes: flag(b.allow_force_pushes), allow_deletions: flag(b.allow_deletions),
    block_creations: flag(b.block_creations), required_conversation_resolution: flag(b.required_conversation_resolution),
    lock_branch: flag(b.lock_branch), allow_fork_syncing: flag(b.allow_fork_syncing),
    required_signatures: before?.required_signatures ?? { url: "u", enabled: false },
  };
}

/** POST one event to /hooks/github, signed as GitHub signs it (or with what `o` changes). */
export async function deliverGithub(event: string, payload: unknown, o: { secret?: string; signature?: string | null; delivery?: string | null; raw?: string } = {}): Promise<Response> {
  // GitHub names the repo's id in every event: the fake's, unless the test gives one (or `id: undefined`, none).
  const repo = (payload as { repository?: Record<string, unknown> } | null)?.repository;
  if (repo && typeof repo === "object" && !("id" in repo) && typeof repo.full_name === "string") repo.id = repoIdOf(repo.full_name);
  // An issue's author by id: the repo owner's (whose issues come into triage by default), unless the test gives one.
  const issue = (payload as { issue?: Record<string, unknown> } | null)?.issue;
  const user = issue && typeof issue.user === "object" && issue.user !== null ? (issue.user as Record<string, unknown>) : null;
  if (user && !("id" in user) && repo && typeof repo.full_name === "string") user.id = ownerIdOf(repo.full_name.split("/")[0]!.toLowerCase());
  // And the App installation it came from: the fake's, unless the test gives one (or `installation: undefined`, none).
  if (payload && typeof payload === "object" && !("installation" in payload)) (payload as Record<string, unknown>).installation = { id: GH_INSTALLATION_ID };
  const body = o.raw ?? JSON.stringify(payload);
  const signature = o.signature === undefined ? await signGithub(o.secret ?? env.GITHUB_WEBHOOK_SECRET!, new TextEncoder().encode(body)) : o.signature;
  const delivery = o.delivery === undefined ? crypto.randomUUID() : o.delivery;
  return SELF.fetch(`${APP}/hooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-github-event": event,
      ...(signature === null ? {} : { "x-hub-signature-256": signature }), ...(delivery === null ? {} : { "x-github-delivery": delivery }),
    },
    body,
  });
}

/** A `pull_request` event's payload, in the fields GitHub sends that the app reads. */
export function prEvent(o: {
  repo: string; number: number; sha: string; action: string; ref?: string; base?: string; title?: string; merged?: boolean; updated_at?: string; headRepo?: string;
  /** The PR's author: the repo's owner (a user) unless given; null for an event naming none. */
  user?: { id: number; login: string; type: string } | null;
}) {
  const owner = o.repo.split("/")[0]!.toLowerCase();
  const user = o.user === undefined ? { id: ownerIdOf(owner), login: owner, type: "User" } : o.user;
  return {
    action: o.action, number: o.number,
    pull_request: {
      number: o.number, node_id: prNode(o.repo, o.number), title: o.title ?? `PR ${o.number}`, state: o.action === "closed" ? "closed" : "open", merged: o.merged ?? false,
      updated_at: o.updated_at ?? new Date().toISOString(),
      ...(user ? { user } : {}),
      head: { sha: o.sha, ref: o.ref ?? `feature-${o.number}`, repo: { full_name: o.headRepo ?? o.repo } },
      base: { ref: o.base ?? "main", repo: { full_name: o.repo } },
    },
    repository: { full_name: o.repo },
    installation: { id: GH_INSTALLATION_ID },
  };
}

/** A 40-hex commit id. */
export const shaOf = (seed: string) => [...seed].map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(40, "0").slice(0, 40);

/** A PR's GraphQL node id in the fake: its repo and number, readable back by the fake. */
export const prNode = (repo: string, number: number) => `PR_${btoa(`${repo.toLowerCase()}#${number}`).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;

function nodeTarget(id: string): { repo: string; number: number } | null {
  const m = /^PR_([A-Za-z0-9_-]+)$/.exec(id);
  if (!m) return null;
  try {
    const raw = atob(m[1]!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (m[1]!.length % 4)) % 4));
    const [repo, n] = raw.split("#");
    return repo && n ? { repo, number: Number(n) } : null;
  } catch {
    return null;
  }
}

// A thin typed client of nest's public client interface (docs/control-plane/api/clients/): the routes
// this app uses, and nothing of nest's code. Every call carries the client's token; the cell goes only
// where nest takes one (a create's body, a listing's optional filter). Creates carry an `Idempotency-Key`,
// so a create whose answer was lost is sent again without making a second agent or sandbox.
// A 503 or 409 nest marks `retryable` (a Durable Object still on the previous release after a deploy, a
// create with the same key still running) is retried
// a few times; anything else is the caller's to handle. The token is never logged or put in an error.

/** nest's error body: `{error: {code, message, retryable}}`. */
export class NestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`nest ${status} ${code}: ${message}`);
  }
  /** A refusal that will repeat: retrying the same call can't succeed. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && !this.retryable && this.status !== 408 && this.status !== 429 && !this.hostsNotReady;
  }
  /**
   * nest refused request guards (409) because a sandbox host of the cell doesn't apply them yet
   * (docs/control-plane/api/clients/#request-guards: `guard_bounds`; `guard_injected_any` and
   * `guard_basic_user` for `*` and `at`): it goes through once the host is replaced, so the start waits and
   * tries again, never dropping the guards. nest's own code, `hosts_not_ready` (nest #274); a nest from
   * before it said `conflict`, told apart by its words ("needs every sandbox host of cell …"): that fallback
   * goes a release after #274.
   */
  get hostsNotReady(): boolean {
    return this.status === 409 && (this.code === "hosts_not_ready" || (this.code === "conflict" && HOSTS_WORDS.test(this.message)));
  }
}

/** nest's words for that refusal before its code (`SandboxDO.requireGuardBounds`, `injectedAnyConflict`). */
export const HOSTS_WORDS = /\bneeds? every sandbox host of cell\b/;

/** A start waiting on nest's hosts (`hostsNotReady`), as its error says it. */
export const HOSTS_WAIT = "waiting for every sandbox host of nest's cell to apply request guards (retried until they do)";

export interface NestConfig {
  base: string;
  token: string;
  cell: string;
  /** How long one request may take before it's abandoned (an error, as nest not answering); default CALL_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** One request to nest is abandoned after this (each attempt of a retried one): nothing the app asks of nest takes longer. */
export const CALL_TIMEOUT_MS = 15_000;

export type Labels = Record<string, string>;

/** What the app reads of an agent (`GET /v1/agents/:agent`); nest sends more. */
export interface AgentView {
  agent: string;
  state?: string;
  owner?: string | null;
  client?: string | null;
  labels?: Labels;
  [k: string]: unknown;
}

/** A row of `GET /v1/agents` or `GET /v1/sandboxes`. */
export interface Listed {
  agent?: string;
  sandbox?: string;
  cell: string;
  client: string | null;
  owner?: string | null;
  labels: Labels;
  created_ms: number;
  ended_ms: number | null;
}

export interface Ask {
  ask: string;
  question?: string;
  [k: string]: unknown;
}

/** An open ask as `GET /v1/asks` lists it: with its agent, the agent's owner and labels (docs/control-plane/api/#open-asks-across-agents). */
export interface OpenAsk {
  agent: string;
  owner?: string | null;
  labels: Labels;
  ask: string;
  question: string;
  created_ms: number;
  approval?: { name: string; tool: string | null };
}

/** Pages of `GET /v1/asks` (100 agents each) read at most for one listing; past it the listing fails rather than leave asks out. */
const ASK_PAGES = 10;

/**
 * What a client may add to its own sandbox's spec: its egress rules (docs/control-plane/api/clients/#egress),
 * its secrets' bindings and the environment that names their placeholders (#injection, #environment),
 * and `workflows: write` on the push token (#workflow-files), each within its grant.
 */
export interface SandboxExtras {
  egress?: { allow: { host: string; ports?: number[] }[] };
  inject?: { name: string; secret: string; hosts: string[]; locations: ({ type: "authorization_bearer" } | { type: "authorization_basic_password"; username?: string } | { type: "header"; name: string })[]; wildcard?: boolean }[];
  env?: Record<string, string>;
  github_push?: { workflows: boolean };
  /** Request guards of the sandbox's own (docs/control-plane/api/clients/#request-guards): they hold for as long as it lives. */
  guards?: Guard[];
}

/** A sandbox's client layer (docs/control-plane/api/clients/#the-client-layer), as `GET …/client-policy` answers it. */
import type { Guard } from "./github-access";
import type { ClientLayer as ClientPolicy, HeldClientLayer, PolicyAllow } from "./network";
export type { ClientPolicy, HeldClientLayer };

/** The overrides a client may give a spawn (nest only narrows, and adds guards: `SpawnerOverrides`). */
export interface SpawnOverrides {
  tools?: string[];
  /** nest's own repos (its kernel token): only narrowed to none, by a start frozen by the release before (README.md#converging-onto-the-apps-own-access). */
  repos?: string[];
  read_repos?: string[];

  ephemeral?: true;
  sandbox_idle_ttl_ms?: number;
}

/** Fields an agent's spawn carries beyond its template and overrides (none yet: README.md#routines, the transcript grant). */
export type AgentExtras = Record<string, unknown>;

const TOKEN = /^nest_cli_([A-Za-z0-9]+)_[0-9a-f]{64}$/;

/** The client id a token belongs to (`nest_cli_<id>_<secret>` → `cli_<id>`), or null if it isn't a client token. */
export function clientIdOf(token: string | undefined): string | null {
  const m = token ? TOKEN.exec(token) : null;
  return m ? `cli_${m[1]}` : null;
}

/** How many times a retryable 503 or 409 is tried, and the first wait (doubling). */
const ATTEMPTS = 3;
const FIRST_WAIT_MS = 200;

export class Nest {
  constructor(private readonly config: NestConfig) {}

  /**
   * One call. A JSON answer is returned; an error status throws NestError (a retryable 503 or 409 is
   * retried first, with the same idempotency key).
   */
  async call<T>(method: string, path: string, body?: unknown, o: { query?: Record<string, string | string[]>; idempotencyKey?: string } = {}): Promise<T> {
    const url = new URL(path, this.config.base);
    for (const [k, v] of Object.entries(o.query ?? {})) for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, one);
    for (let attempt = 1; ; attempt++) {
      // The global fetch, looked up per call (dev/review-lessons.md 8).
      const res = await fetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          accept: "application/json",
          "user-agent": "nest-projects/1",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(o.idempotencyKey ? { "idempotency-key": o.idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? CALL_TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      const err = parseError(res.status, text);
      if ((err.status === 503 || err.status === 409) && err.retryable && attempt < ATTEMPTS) {
        await new Promise((r) => setTimeout(r, FIRST_WAIT_MS * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }

  /** Create a sandbox in the app's cell. The same `idempotencyKey` with the same request answers the same sandbox, as it is now (a replay: `state` `destroyed` once it's gone). */
  createSandbox(r: { labels: Labels; idle_ttl_ms?: number } & SandboxExtras, idempotencyKey: string): Promise<{ sandbox: string; state?: string }> {
    return this.call("POST", "/v1/sandboxes", { ...r, cell: this.config.cell }, { idempotencyKey });
  }

  /** Create an agent in the app's cell. The same `idempotencyKey` with the same request answers the same agent. */
  createAgent(r: { template: string; sandbox?: string; labels: Labels; overrides?: SpawnOverrides; start?: boolean } & AgentExtras, idempotencyKey: string): Promise<AgentView> {
    return this.call("POST", "/v1/agents", { ...r, cell: this.config.cell }, { idempotencyKey });
  }

  /**
   * A new agent with a sandbox of its own, both labelled, with `overrides` (as its start froze them).
   * `key` names this start attempt: a retry after a lost answer sends the same Idempotency-Keys
   * (`<key>/sandbox`, `<key>/agent`) and gets the same sandbox and agent back. An agent create refused for
   * good destroys the sandbox made for it (not on a 409: the key's create may have landed). `agent` adds fields to the
   * agent's spawn (README.md#routines: a routine's grants).
   */
  async startAgent(template: string, labels: Labels, overrides: SpawnOverrides, key: string, extras: SandboxExtras = {}, agent: AgentExtras = {}, o: { newAttemptOnCapacity?: boolean } = {}): Promise<string> {
    const sandbox = (await this.createSandbox({ labels, ...extras }, `${key}/sandbox`)).sandbox;
    try {
      return (await this.createAgent({ ...agent, template, sandbox, labels, overrides, start: true }, `${key}/agent`)).agent;
    } catch (e) {
      // Refused for good (a quota, the template): no agent will ever use this attempt's sandbox, so it goes
      // now, or it would be left until its idle TTL (and every retry of the work is a new attempt, with a
      // sandbox of its own). Best effort: a destroy that fails leaves it to that TTL. The refusal is thrown.
      // Not a 409: a key bound to another request means an earlier attempt's create landed, so an agent
      // may be using the sandbox.
      // At capacity (nest#248's 429 `at_capacity` is retryable, no permanent refusal): only for a caller whose
      // next try is a new attempt (`newAttemptOnCapacity`: a review's), so this one's sandbox is spent. A
      // caller that retries the same attempt (a worker's start) gets this sandbox back by its key, and keeps it.
      if (e instanceof NestError && (e.permanent || (o.newAttemptOnCapacity === true && atCapacity(e))) && e.status !== 409) {
        try {
          await this.destroySandbox(sandbox);
        } catch {
          // Left to its idle TTL.
        }
      }
      throw e;
    }
  }

  /** Destroy one of the app's sandboxes (`DELETE /v1/sandboxes/<id>`, owner auth). */
  async destroySandbox(sandbox: string): Promise<void> {
    await this.call("DELETE", `/v1/sandboxes/${encodeURIComponent(sandbox)}`);
  }

  /**
   * Restart an agent's brain on a new launch, resuming its session (`POST /v1/agents/<id>/start {restart,
   * launch}`, owner auth): nest stores the launch's model and effort and restarts on them in one step, and
   * answers the launch as stored. A release before that route ignores `launch`: its answer has none.
   * It kills a live brain at once, so a turn in progress is cut: call it only between turns.
   */
  async restartAgent(agent: string, launch: { model?: string; effort?: string }, when?: "idle"): Promise<{ launch?: { model?: string; effort?: string } }> {
    // `when: "idle"`: only between turns; nest answers 409 `busy` while one runs (a release before it: 400).
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/start`, { restart: true, launch, ...(when ? { when } : {}) });
  }

  getAgent(agent: string): Promise<AgentView> {
    return this.call("GET", `/v1/agents/${encodeURIComponent(agent)}`);
  }

  /** The first page of the app's agents carrying every label in `labels` (`state`: live by default), in the app's cell. */
  listAgents(labels: Labels, state: "live" | "ended" | "all" = "live"): Promise<{ agents: Listed[]; next_cursor: string | null }> {
    return this.call("GET", "/v1/agents", undefined, { query: { label: labelFilters(labels), state, cell: this.config.cell } });
  }

  listSandboxes(labels: Labels, state: "live" | "ended" | "all" = "live"): Promise<{ sandboxes: Listed[]; next_cursor: string | null }> {
    return this.call("GET", "/v1/sandboxes", undefined, { query: { label: labelFilters(labels), state, cell: this.config.cell } });
  }

  /**
   * Post to an agent's inbox. `requestId` makes a retry land once. `from` other than the client itself
   * marks the text as relayed, which taints the agent's session (nest's rule).
   */
  postInbox(agent: string, text: string, o: { requestId?: string; from?: string; interrupt?: boolean } = {}): Promise<{ message: unknown }> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/inbox`, {
      text, ...(o.from ? { from: o.from } : {}), ...(o.interrupt ? { interrupt: true } : {}), ...(o.requestId ? { request_id: o.requestId } : {}),
    });
  }

  /** Stop an agent; with `end`, for good (its sandbox destroyed with `destroySandbox`). */
  /** Interrupt the agent's current turn (`POST /v1/agents/:agent/interrupt`, the owner's). */
  interrupt(agent: string): Promise<unknown> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/interrupt`);
  }

  stopAgent(agent: string, o: { end?: boolean; destroySandbox?: boolean; reason?: string } = {}): Promise<unknown> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/stop`, {
      ...(o.end ? { end: true } : {}), ...(o.destroySandbox ? { destroy_sandbox: true } : {}), ...(o.reason ? { reason: o.reason } : {}),
    });
  }

  /** The trace's older events (nest's trace history), before `before` (its seam when absent), newest page first. */
  traceHistory(agent: string, q: { before?: string; limit?: string } = {}): Promise<{ events: unknown[]; next_before: string | null; reset?: true }> {
    return this.call("GET", `/v1/agents/${encodeURIComponent(agent)}/trace/history`, undefined, { query: q });
  }

  /** A sandbox's client layer: its own egress rules, bindings and env. */
  getClientPolicy(sandbox: string): Promise<HeldClientLayer> {
    return this.call("GET", `/v1/sandboxes/${encodeURIComponent(sandbox)}/client-policy`);
  }

  /** Replace a sandbox's client layer whole (an absent part is emptied: send every part). */
  async putClientPolicy(sandbox: string, layer: ClientPolicy): Promise<void> {
    await this.call("PUT", `/v1/sandboxes/${encodeURIComponent(sandbox)}/client-policy`, layer);
  }

  /** A sandbox's effective egress policy (the operator's layers and its own), as nest compiles it. */
  sandboxPolicy(sandbox: string): Promise<{ allow?: PolicyAllow[]; passthrough?: string[] }> {
    return this.call("GET", `/v1/sandboxes/${encodeURIComponent(sandbox)}/policy`);
  }

  listAsks(agent: string): Promise<unknown> {
    return this.call("GET", `/v1/agents/${encodeURIComponent(agent)}/asks`);
  }

  /**
   * Every open ask of the app's live agents carrying every label in `labels` (none: all of them), in the
   * app's cell, oldest first, read from nest when asked: `GET /v1/asks`, all its pages, and the whole list
   * of each agent a page names in `more` (it shows 20 an agent). A control plane from before that route (one
   * release back) answers a client's unknown route 401: then each agent's own (`GET /v1/agents/<id>/asks`).
   */
  async openAsks(labels: Labels): Promise<OpenAsk[]> {
    const out: OpenAsk[] = [];
    const more = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      if (page === ASK_PAGES) throw new Error(`more than ${ASK_PAGES * 100} agents to list asks of`);
      let r: { asks: OpenAsk[]; more?: string[]; next_cursor: string | null };
      try {
        r = await this.call("GET", "/v1/asks", undefined, { query: { label: labelFilters(labels), cell: this.config.cell, limit: "100", ...(cursor ? { cursor } : {}) } });
      } catch (e) {
        if (page === 0 && e instanceof NestError && (e.status === 401 || e.status === 404)) return this.openAsksPerAgent(labels);
        throw e;
      }
      out.push(...r.asks);
      for (const a of r.more ?? []) more.add(a);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    // An agent with more than a page shows: its whole list, in place of its rows.
    const whole = await Promise.all([...more].map(async (agent) => {
      const row = out.find((x) => x.agent === agent);
      const asks = (await this.listAsks(agent)) as Omit<OpenAsk, "agent" | "owner" | "labels">[];
      return row ? asks.map((x) => ({ ...x, agent, owner: row.owner, labels: row.labels })) : [];
    }));
    return [...out.filter((x) => !more.has(x.agent)), ...whole.flat()].sort((a, b) => a.created_ms - b.created_ms);
  }

  /** `openAsks` on a control plane without `GET /v1/asks`: the agents by their labels, then each one's asks. */
  private async openAsksPerAgent(labels: Labels): Promise<OpenAsk[]> {
    const agents: Listed[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < ASK_PAGES; page++) {
      const r: { agents: Listed[]; next_cursor: string | null } = await this.call("GET", "/v1/agents", undefined, {
        query: { label: labelFilters(labels), state: "live", cell: this.config.cell, limit: "100", ...(cursor ? { cursor } : {}) },
      });
      agents.push(...r.agents);
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    if (cursor) throw new Error(`more than ${ASK_PAGES * 100} agents to list asks of`);
    const per = await Promise.all(agents.filter((a) => a.agent).map(async (a) => {
      const asks = (await this.listAsks(a.agent!)) as Omit<OpenAsk, "agent" | "owner" | "labels">[];
      return asks.map((x) => ({ ...x, agent: a.agent!, owner: a.owner ?? null, labels: a.labels }));
    }));
    return per.flat().sort((a, b) => a.created_ms - b.created_ms);
  }

  answerAsk(agent: string, ask: string, answer: string): Promise<{ delivered: unknown }> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/asks/${encodeURIComponent(ask)}/answer`, { answer });
  }

  /** Write a catalog entry in the client's namespace (`<client-name>/<entry>`). */
  putCatalog(kind: "templates" | "capabilities", name: string, body: unknown): Promise<unknown> {
    const [ns, entry] = name.split("/");
    return this.call("PUT", `/v1/catalog/${kind}/${encodeURIComponent(ns!)}/${encodeURIComponent(entry!)}`, body);
  }

  /** Delete a catalog entry of the client's own (`DELETE /v1/catalog/<kind>/<client-name>/<entry>`); gone already is fine. */
  async deleteCatalog(kind: "templates" | "capabilities", name: string): Promise<void> {
    const [ns, entry] = name.split("/");
    try {
      await this.call("DELETE", `/v1/catalog/${kind}/${encodeURIComponent(ns!)}/${encodeURIComponent(entry!)}`);
    } catch (e) {
      if (!(e instanceof NestError && e.status === 404)) throw e;
    }
  }

  /** The client's own record (`GET /v1/clients/self`): its grant, among the rest. */
  self(): Promise<{
    client?: string;
    grant?: {
      egress_hosts?: string[]; inject_hosts?: string[]; secrets?: { max_count?: number; max_bytes?: number }; github_push?: { workflows?: boolean };
      repos?: string[];
      github?: { repos?: string[]; permissions?: Record<string, string> };
    };
  }> {
    return this.call("GET", "/v1/clients/self");
  }

  /**
   * Store or replace a write-only secret (docs/control-plane/api/clients/#secrets); answers its metadata, never
   * the value. `expiresAt` (RFC 3339): nest stops injecting it then; without it, it never expires.
   */
  putSecret(name: string, value: string, description: string, expiresAt?: string): Promise<{ name: string; size: number; created_ms: number; updated_ms: number; last_injected_ms: number | null }> {
    return this.call("PUT", `/v1/clients/self/secrets/${encodeURIComponent(name)}`, { value, ...(description ? { description } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) });
  }

  async deleteSecret(name: string): Promise<void> {
    await this.call("DELETE", `/v1/clients/self/secrets/${encodeURIComponent(name)}`);
  }

  async listSecrets(): Promise<{ name: string; size: number; created_ms?: number; updated_ms?: number; last_injected_ms: number | null }[]> {
    return (await this.call<{ secrets?: { name: string; size: number; created_ms?: number; updated_ms?: number; last_injected_ms: number | null }[] }>("GET", "/v1/clients/self/secrets")).secrets ?? [];
  }

  /**
   * A short-lived GitHub App token for one repo of the grant, with exactly these permissions, and the
   * App it's from (`app_id`, `app_slug`: absent when nest can't tell) and the App's installation it was
   * minted from (`installation_id`: absent from a nest of the previous release). The fallback only
   * (`GITHUB_TOKEN_SOURCE=nest`, README.md#github-tokens): the app mints its own otherwise.
   */
  githubToken(repo: string, permissions: Record<string, string>): Promise<{ token: string; expires_at: string; repo: string; permissions: Record<string, string>; installation_id?: number; app_id?: number; app_slug?: string }> {
    return this.call("POST", "/v1/clients/self/github-token", { repo, permissions });
  }
}

/** Retry waits for work owed to nest or GitHub: from 5 s, doubling, to 5 min. */
export const backoff = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);

const labelFilters = (labels: Labels) => Object.entries(labels).map(([k, v]) => `${k}=${v}`);

function parseError(status: number, text: string): NestError {
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; retryable?: unknown } }).error;
    if (e && typeof e === "object") {
      return new NestError(status, typeof e.code === "string" ? e.code : "error", typeof e.message === "string" ? e.message : "", e.retryable === true);
    }
  } catch {
    // not JSON: a proxy's or Cloudflare's own page
  }
  return new NestError(status, "http", text.slice(0, 200), false);
}

/** The app's nest client from the Worker's env, or null when its token isn't set. */
/**
 * A stop's refusal that will repeat (README.md#outboxes): nest's own refusal of the request, in its JSON
 * error body (400, 409). An auth failure (401, 403) or a page that isn't nest's (a proxy's, Access's) may
 * pass, so it's retried: failing it would leave an agent running unseen.
 */
export function stopRefused(e: unknown): boolean {
  return e instanceof NestError && e.code !== "http" && !e.retryable && (e.status === 400 || e.status === 409);
}

/**
 * nest refused a create because the client is at a limit of live agents or sandboxes (its grant's
 * `max_agents` or `max_sandboxes`, or a spawner's live children) (README.md#built-the-review-pipeline): a
 * refusal that lasts only until one of them ends.
 * - **nest from nest#248 on:** its own code, `at_capacity` (429, retryable), whatever the message.
 * - **A nest from before it** (the fallback, removed a release after #248): a refusal of the grant (403
 *   `forbidden`, not retryable), told apart by the words ClientDO's `admit` writes, "<client> has <n> live
 *   sandboxes, its grant's max_sandboxes" (control-plane/src/do/client.ts). Worded otherwise, it's a refusal
 *   like any other.
 */
export function atCapacity(e: unknown): boolean {
  if (!(e instanceof NestError)) return false;
  if (e.code === "at_capacity") return true;
  return e.status === 403 && e.code === "forbidden" && /\bhas \d+ live (?:agents|sandboxes), its grant's max_(?:agents|sandboxes)\b/.test(e.message);
}

export function nestFrom(env: { NEST_CONTROL_PLANE: string; NEST_CELL: string; NEST_CLIENT_TOKEN?: string }): Nest | null {
  return env.NEST_CLIENT_TOKEN ? new Nest({ base: env.NEST_CONTROL_PLANE, token: env.NEST_CLIENT_TOKEN, cell: env.NEST_CELL }) : null;
}

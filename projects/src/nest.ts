// A thin typed client of nest's public client interface (docs/control-plane/api/clients/): the routes
// this app uses, and nothing of nest's code. Every call carries the client's token; the cell goes only
// where nest takes one (a create's body, a listing's optional filter). Creates carry an `Idempotency-Key`,
// so a create whose answer was lost is sent again without making a second agent or sandbox.
// A 503 or 409 nest marks `retryable` (a Durable Object still on the previous release after a deploy, a
// create with the same key still running) is retried
// a few times; anything else is the caller's to handle. The token is never logged or put in an error.

/** nest's error body: `{error: {code, message, retryable}}`. */
/** A repo as nest's grant answers for it: pushed to (`push`), read (`read`), and minted GitHub tokens for (`github`). */
export interface GrantRepo {
  repo: string;
  push: boolean;
  read: boolean;
  github: boolean;
}

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
    return this.status >= 400 && this.status < 500 && !this.retryable && this.status !== 408 && this.status !== 429;
  }
}

export interface NestConfig {
  base: string;
  token: string;
  cell: string;
}

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

/**
 * What a client may add to its own sandbox's spec: its egress rules (docs/control-plane/api/clients/#egress),
 * its secrets' bindings and the environment that names their placeholders (#injection, #environment),
 * and `workflows: write` on the push token (#workflow-files), each within its grant.
 */
export interface SandboxExtras {
  egress?: { allow: { host: string; ports?: number[] }[] };
  inject?: { name: string; secret: string; hosts: string[]; locations: ({ type: "authorization_bearer" } | { type: "authorization_basic_password" } | { type: "header"; name: string })[]; wildcard?: boolean }[];
  env?: Record<string, string>;
  github_push?: { workflows: boolean };
}

/** A sandbox's client layer (docs/control-plane/api/clients/#the-client-layer), as `GET …/client-policy` answers it. */
import type { ClientLayer as ClientPolicy, HeldClientLayer, PolicyAllow } from "./network";
export type { ClientPolicy, HeldClientLayer };

/** The overrides a client may give a spawn (nest only narrows: `SpawnerOverrides`). */
export interface SpawnOverrides {
  tools?: string[];
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

  /** Create a sandbox in the app's cell. The same `idempotencyKey` with the same request answers the same sandbox. */
  createSandbox(r: { labels: Labels; idle_ttl_ms?: number } & SandboxExtras, idempotencyKey: string): Promise<{ sandbox: string }> {
    return this.call("POST", "/v1/sandboxes", { ...r, cell: this.config.cell }, { idempotencyKey });
  }

  /** Create an agent in the app's cell. The same `idempotencyKey` with the same request answers the same agent. */
  createAgent(r: { template: string; sandbox?: string; labels: Labels; overrides?: SpawnOverrides; start?: boolean } & AgentExtras, idempotencyKey: string): Promise<AgentView> {
    return this.call("POST", "/v1/agents", { ...r, cell: this.config.cell }, { idempotencyKey });
  }

  /**
   * A new agent with a sandbox of its own, both labelled, its repos narrowed to `repo`: to push to
   * (`overrides.repos`), or only to read (`overrides.read_repos`), as its template has them.
   * `key` names this start attempt: a retry after a lost answer sends the same Idempotency-Keys
   * (`<key>/sandbox`, `<key>/agent`) and gets the same sandbox and agent back. An agent create refused for
   * good destroys the sandbox made for it (not on a 409: the key's create may have landed). `agent` adds fields to the
   * agent's spawn (README.md#routines: a routine's grants).
   */
  async startAgent(template: string, labels: Labels, repo: { push: string } | { read: string }, key: string, extras: SandboxExtras = {}, agent: AgentExtras = {}): Promise<string> {
    const sandbox = (await this.createSandbox({ labels, ...extras }, `${key}/sandbox`)).sandbox;
    const overrides: SpawnOverrides = "push" in repo ? { repos: [repo.push] } : { read_repos: [repo.read] };
    try {
      return (await this.createAgent({ ...agent, template, sandbox, labels, overrides, start: true }, `${key}/agent`)).agent;
    } catch (e) {
      // Refused for good (a quota, the template): no agent will ever use this attempt's sandbox, so it goes
      // now, or it would be left until its idle TTL (and every retry of the work is a new attempt, with a
      // sandbox of its own). Best effort: a destroy that fails leaves it to that TTL. The refusal is thrown.
      // Not a 409: a key bound to another request means an earlier attempt's create landed, so an agent
      // may be using the sandbox.
      if (e instanceof NestError && e.permanent && e.status !== 409) {
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
  async restartAgent(agent: string, launch: { model?: string; effort?: string }): Promise<{ launch?: { model?: string; effort?: string } }> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/start`, { restart: true, launch });
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
   * The repos nest's grant for the app covers that nest can list (`GET /v1/clients/self/grant/repos`,
   * docs/control-plane/api/clients/#owner-wide-entries): its exact entries and the repos of each
   * owner-wide entry's account the App is installed on, each with what the grant allows there. nest
   * decides membership (by the owner's GitHub id for an owner-wide entry); the app never copies the rule.
   */
  grantRepos(): Promise<{ repos: GrantRepo[]; unlisted: string[]; complete: boolean }> {
    return this.call("GET", "/v1/clients/self/grant/repos");
  }

  /** Whether the grant covers each of these repos (`POST /v1/clients/self/grant/repos`), decided by nest. */
  grantMembership(repos: string[]): Promise<{ repos: GrantRepo[] }> {
    return this.call("POST", "/v1/clients/self/grant/repos", { repos });
  }

  /** Store or replace a write-only secret (docs/control-plane/api/clients/#secrets); answers its metadata, never the value. */
  putSecret(name: string, value: string, description: string): Promise<{ name: string; size: number; created_ms: number; updated_ms: number; last_injected_ms: number | null }> {
    return this.call("PUT", `/v1/clients/self/secrets/${encodeURIComponent(name)}`, { value, ...(description ? { description } : {}) });
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
   * minted from (`installation_id`: absent from a nest of the previous release).
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

export function nestFrom(env: { NEST_CONTROL_PLANE: string; NEST_CELL: string; NEST_CLIENT_TOKEN?: string }): Nest | null {
  return env.NEST_CLIENT_TOKEN ? new Nest({ base: env.NEST_CONTROL_PLANE, token: env.NEST_CLIENT_TOKEN, cell: env.NEST_CELL }) : null;
}

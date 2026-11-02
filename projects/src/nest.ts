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

/** The overrides a client may give a spawn (nest only narrows: `SpawnerOverrides`). */
export interface SpawnOverrides {
  tools?: string[];
  repos?: string[];
  ephemeral?: true;
  sandbox_idle_ttl_ms?: number;
}

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
  createSandbox(r: { labels: Labels; idle_ttl_ms?: number }, idempotencyKey: string): Promise<{ sandbox: string }> {
    return this.call("POST", "/v1/sandboxes", { ...r, cell: this.config.cell }, { idempotencyKey });
  }

  /** Create an agent in the app's cell. The same `idempotencyKey` with the same request answers the same agent. */
  createAgent(r: { template: string; sandbox?: string; labels: Labels; overrides?: SpawnOverrides; start?: boolean }, idempotencyKey: string): Promise<AgentView> {
    return this.call("POST", "/v1/agents", { ...r, cell: this.config.cell }, { idempotencyKey });
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
  stopAgent(agent: string, o: { end?: boolean; destroySandbox?: boolean; reason?: string } = {}): Promise<unknown> {
    return this.call("POST", `/v1/agents/${encodeURIComponent(agent)}/stop`, {
      ...(o.end ? { end: true } : {}), ...(o.destroySandbox ? { destroy_sandbox: true } : {}), ...(o.reason ? { reason: o.reason } : {}),
    });
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

  /** A short-lived GitHub App token for one repo of the grant, with exactly these permissions. */
  githubToken(repo: string, permissions: Record<string, string>): Promise<{ token: string; expires_at: string; repo: string; permissions: Record<string, string> }> {
    return this.call("POST", "/v1/clients/self/github-token", { repo, permissions });
  }
}

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
export function nestFrom(env: { NEST_CONTROL_PLANE: string; NEST_CELL: string; NEST_CLIENT_TOKEN?: string }): Nest | null {
  return env.NEST_CLIENT_TOKEN ? new Nest({ base: env.NEST_CONTROL_PLANE, token: env.NEST_CLIENT_TOKEN, cell: env.NEST_CELL }) : null;
}

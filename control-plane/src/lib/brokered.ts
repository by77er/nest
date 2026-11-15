// Brokered actions (docs/agents/tools/#taint-and-sinks, docs/agents/capabilities/#built-in-capabilities):
// actions the control plane runs for an agent with credentials no agent or sandbox ever holds. This
// module is the pure half: the action registry, the catalog's `brokered` source and what a spec keeps
// of it, authority (which grant covers a call), the model-facing tool definitions, natural idempotency
// keys, the exact-value scan's input, and the journal (the one class here with storage). AgentDO runs
// the pipeline (do/agent.ts, `brokeredTool`); BrokerDO holds the profiles' credentials.
import { z } from "zod";
import type { ToolDef, ToolOutcome } from "../protocol/control";
import { storedEnum } from "./stored";
import type { WhenTainted } from "./sinks";
import { ErrorCodes } from "../protocol/model";
import { errorBody, sha256, hex } from "./util";

// --- The registry ------------------------------------------------------------------------------------

interface ActionDef {
  /** The model-facing tool (`mcp__nest__<tool>`): API tool names allow no `.`. */
  tool: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Every brokered action nest knows: generic ones only, naming no service (docs/agents/capabilities/brokered/#actions). */
export const BROKERED_ACTIONS = {
  "http.request": {
    tool: "http_request",
    description: "An HTTP request through an operator-defined profile: its base URL, methods and paths, with its credential attached by the control plane (you never see it).",
    input_schema: {
      type: "object",
      properties: {
        profile: { type: "string" }, method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
        path: { type: "string", description: "Appended to the profile's base URL; starts with /." },
        query: { type: "object", description: "Query parameters (string values)." }, body: { type: "string", maxLength: 1_048_576 },
        content_type: { type: "string" },
      },
      required: ["profile", "method", "path"], additionalProperties: false,
    },
  },
} as const satisfies Record<string, ActionDef>;

export type BrokeredAction = keyof typeof BROKERED_ACTIONS;
export const BROKERED_ACTION_NAMES = Object.keys(BROKERED_ACTIONS) as BrokeredAction[];
/** Every brokered tool's model-facing name: no mcp capability may make one (`capabilityNameClash`). */
export const BROKERED_TOOL_NAMES: readonly string[] = BROKERED_ACTION_NAMES.map((a) => BROKERED_ACTIONS[a].tool);

export const actionDef = (action: string): ActionDef | undefined =>
  Object.hasOwn(BROKERED_ACTIONS, action) ? BROKERED_ACTIONS[action as BrokeredAction] : undefined;
export const actionOfTool = (tool: string): BrokeredAction | undefined => BROKERED_ACTION_NAMES.find((a) => BROKERED_ACTIONS[a].tool === tool);

/**
 * Actions nest no longer has (docs/agents/capabilities/brokered/#actions): GitHub's, which an app runs
 * with its own credentials, and the `email.send` placeholder. A stored catalog entry or spec
 * grant naming one is dropped when read; a write naming one is refused.
 */
export const REMOVED_ACTIONS: readonly string[] = [
  "github.comment", "github.create_issue", "github.create_pr", "github.review_comment", "github.fork", "email.send",
];
/**
 * The removed actions' model-facing tools: still no mcp capability may make one while a stored grant of the
 * action may exist (a rollback routes the name to the action again, and rules written for it would match).
 */
export const REMOVED_TOOL_NAMES: readonly string[] = REMOVED_ACTIONS.map((a) => a.replace(".", "_"));
const removedEntry = (e: unknown): boolean =>
  typeof e === "object" && e !== null && REMOVED_ACTIONS.includes(String((e as { action?: unknown }).action));

// --- The catalog's `brokered` source -----------------------------------------------------------------------

const WhenTaintedField = z.enum(["approve", "allow"]);
const PerHour = z.number().int().min(1).max(1000);
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const Method = z.enum(HTTP_METHODS);
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a header name");
export const ProfileName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "profile names are lowercase letters, digits and '-'");

/** Headers a profile's credential may never go in, or a caller set: routing, framing and hop-by-hop. */
const RESERVED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive",
  "proxy-authorization", "proxy-authenticate", "proxy-connection", "cookie", "content-type", "accept"]);

const HttpEntry = z.object({
  action: z.literal("http.request"),
  profile: ProfileName,
  base_url: z.string().min(1).max(2048),
  methods: z.array(Method).min(1),
  /** Path prefixes (whole segments) below the base URL; absent: any path. */
  paths: z.array(z.string().min(1).max(2048)).max(32).optional(),
  /** The BrokerDO secret attached to each request, `http:<name>`, as `<header>: <scheme> <value>`. */
  auth: z.object({
    secret: z.string().regex(/^http:[A-Za-z0-9_.:-]{1,128}$/, "auth.secret names a BrokerDO secret, http:<name>"),
    header: HeaderName.default("authorization"),
    scheme: z.string().regex(/^[A-Za-z0-9-]{0,32}$/).default("Bearer"),
  }).optional(),
  /** Its responses don't taint the session (the operator vouches for the API). */
  trusted: z.boolean().default(false),
  when_tainted: WhenTaintedField.optional(),
  per_hour: PerHour.optional(),
  /** Sent with the call's key digest, so a retried non-idempotent request can be recognized by the API. */
  idempotency_header: HeaderName.optional(),
});

export const BrokeredEntry = HttpEntry;
export type BrokeredEntry = z.output<typeof BrokeredEntry>;
const Entries = z.array(BrokeredEntry).max(64);

/** A capability's `brokered` source as written: an entry naming a removed action is refused, by name. */
export const BrokeredSource = z.preprocess((raw, ctx) => {
  if (!Array.isArray(raw)) return raw;
  raw.forEach((e, i) => {
    if (removedEntry(e)) {
      ctx.addIssue({
        code: "custom", path: [i, "action"],
        message: `${String((e as { action: unknown }).action)} is no longer a brokered action: nest's kernel runs no service's actions (an app runs them with its own credentials, or an http.request profile or an mcp capability reaches the API)`,
      });
    }
  });
  // Refused above; left out so the union's own error doesn't repeat it.
  return raw.filter((e) => !removedEntry(e));
}, Entries);

/** A capability's `brokered` source as stored: entries naming a removed action, written before they went, are dropped. */
export const StoredBrokeredSource = z.preprocess((raw) => (Array.isArray(raw) ? raw.filter((e) => !removedEntry(e)) : raw), Entries);

/** What a spec keeps of one entry, copied at spawn: defaults resolved. */
export interface BrokeredGrant {
  capability: string; action: "http.request"; profile: string; base_url: string; methods: string[]; paths: string[] | null;
  auth: { secret: string; header: string; scheme: string } | null; trusted: boolean; when_tainted: WhenTainted; per_hour: number;
  idempotency_header: string | null;
}

/**
 * The grants of a stored spec this release runs: those of actions it knows. A spec stored before an
 * action was removed (`REMOVED_ACTIONS`) may still hold its grants; they are kept in the record (a
 * rollback runs them again) and ignored here.
 */
export const liveGrants = (grants: readonly BrokeredGrant[] | undefined): BrokeredGrant[] =>
  (grants ?? []).filter((g) => actionDef((g as { action: string }).action) !== undefined);

export const DEFAULT_PER_HOUR = 60;
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * A spec's grant from a catalog entry. Default ("balanced", docs/agents/tools/#taint-and-sinks): a
 * profile is `approve` when tainted (a read-only one isn't a sink, so it's never gated).
 */
export function grantOfEntry(capability: string, e: BrokeredEntry): BrokeredGrant {
  return {
    capability, action: e.action, profile: e.profile, base_url: e.base_url.replace(/\/+$/, ""), methods: [...new Set(e.methods)],
    paths: e.paths ? [...e.paths] : null, auth: e.auth ? { ...e.auth } : null, trusted: e.trusted ?? false,
    when_tainted: e.when_tainted ?? "approve", per_hour: e.per_hour ?? DEFAULT_PER_HOUR, idempotency_header: e.idempotency_header ?? null,
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** A base URL nest will send a credential to: `https`, no credentials, query or fragment; loopback only in local dev. */
export function checkBaseUrl(raw: string, allowLoopback: boolean): Result<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `${raw} is not a URL` };
  }
  if (u.username || u.password) return { ok: false, error: "the URL carries credentials: put them in BrokerDO and name the secret in auth" };
  if (u.hash || u.search) return { ok: false, error: "the base URL has a query or fragment" };
  const loopback = LOOPBACK.has(u.hostname);
  if (loopback && !allowLoopback) return { ok: false, error: "a loopback URL is accepted only in local development (ALLOW_LOOPBACK_BROKERED=1)" };
  if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return { ok: true, value: u };
  return { ok: false, error: "a base URL must be https" };
}

/**
 * A path a profile request may use, by the injection doc's safe-path rules (docs/sandbox/networking/egress/injection/#scope):
 * starts with `/`, at most 2,048 bytes, no `\`, `?`, `#`, `%`, NUL, `//`, `.` or `..` segments.
 */
export function safePath(p: string): boolean {
  if (!p.startsWith("/") || p.length > 2048 || /[\\?#%\0]/.test(p) || p.includes("//")) return false;
  return !p.split("/").some((s) => s === "." || s === "..");
}

/** Whole-segment prefix match: `/v1` covers `/v1` and `/v1/…`, not `/v10`; a prefix ending in `/` covers what's under it. */
export function pathCovered(prefix: string, path: string): boolean {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The catalog entries of one capability, checked: known actions (CatalogDO's caller may be a previous
 * release's Worker, whose schema still took the removed ones) and well-formed profiles, each named once.
 */
export function checkBrokered(entries: readonly BrokeredEntry[], allowLoopback: boolean): Result<true> {
  const profiles = new Set<string>();
  for (const e of entries) {
    if (actionDef((e as { action: string }).action) === undefined) return { ok: false, error: `${String((e as { action: unknown }).action)} is no longer a brokered action` };
    if (profiles.has(e.profile)) return { ok: false, error: `profile ${e.profile} defined twice` };
    profiles.add(e.profile);
    const u = checkBaseUrl(e.base_url, allowLoopback);
    if (!u.ok) return { ok: false, error: `profile ${e.profile}: ${u.error}` };
    for (const p of e.paths ?? []) if (!safePath(p)) return { ok: false, error: `profile ${e.profile}: path ${p} isn't a safe path` };
    if (e.auth && RESERVED_HEADERS.has(e.auth.header.toLowerCase())) return { ok: false, error: `profile ${e.profile}: a credential can't go in ${e.auth.header}` };
    if (e.idempotency_header && RESERVED_HEADERS.has(e.idempotency_header.toLowerCase())) return { ok: false, error: `profile ${e.profile}: idempotency_header can't be ${e.idempotency_header}` };
  }
  return { ok: true, value: true };
}

// --- Authority ---------------------------------------------------------------------------------------------

/** What covers one call: whether it's a sink, what a tainted session needs, the hourly cap, and the target. */
export interface Authorized {
  action: BrokeredAction;
  /** The profile. */
  target: string;
  sink: boolean;
  when_tainted: WhenTainted;
  per_hour: number;
  /** The profile's grant. */
  profile: BrokeredGrant;
}

/**
 * Which of the spec's grants covers this call (`args` already validated against the action's schema):
 * the profile it names, its methods and paths. A grant of an action this release doesn't know covers nothing.
 */
export function authorize(grants: readonly BrokeredGrant[], action: BrokeredAction, args: Record<string, unknown>): Result<Authorized> {
  const mine = liveGrants(grants).filter((g) => g.action === action);
  if (!mine.length) return { ok: false, error: `${action} isn't granted to this agent` };
  const g = mine.find((x) => x.profile === args.profile);
  if (!g) return { ok: false, error: `no http profile ${String(args.profile)} is granted to this agent` };
  const method = String(args.method);
  const path = String(args.path);
  if (!g.methods.includes(method)) return { ok: false, error: `profile ${g.profile} allows ${g.methods.join(", ")}, not ${method}` };
  if (!safePath(path)) return { ok: false, error: `${path} isn't a safe path (starts with /; no %, \\, ?, #, // or dot segments)` };
  if (g.paths && !g.paths.some((p) => pathCovered(p, path))) return { ok: false, error: `profile ${g.profile} doesn't cover ${path}` };
  const readOnly = g.methods.every((m) => READ_METHODS.has(m));
  return { ok: true, value: { action, target: g.profile, sink: !readOnly, when_tainted: g.when_tainted, per_hour: g.per_hour, profile: g } };
}

/**
 * The model-facing definitions of the actions a spec grants: one tool per action, its schema narrowed to
 * what the grants allow (the profiles). `brokered{action, args}` reaches the same actions.
 */
export function brokeredToolDefs(grants: readonly BrokeredGrant[]): ToolDef[] {
  const out: ToolDef[] = [];
  const live = liveGrants(grants);
  for (const action of BROKERED_ACTION_NAMES) {
    const ps = live.filter((g) => g.action === action);
    if (!ps.length) continue;
    const def = BROKERED_ACTIONS[action];
    const schema = structuredClone(def.input_schema) as { properties: Record<string, Record<string, unknown>> };
    schema.properties.profile = { type: "string", enum: ps.map((p) => p.profile) };
    const description = `${def.description} Profiles: ${ps.map((p) => `${p.profile} (${p.base_url}, ${p.methods.join("/")}${p.paths ? `, under ${p.paths.join(" ")}` : ""})`).join("; ")}.`;
    out.push({ name: def.tool, description, input_schema: schema, roles: [], requires_approval: false });
  }
  return out;
}

// --- Natural idempotency keys -------------------------------------------------------------------------------

/** A short, stable digest of a call key: what a profile's `idempotency_header` carries. */
export async function keyDigest(key: string): Promise<string> {
  return hex(await sha256(key)).slice(0, 24);
}

/** The action's natural idempotency key: what makes two calls the same external effect. A request is the call. */
export function naturalKey(action: BrokeredAction, args: Record<string, unknown>, keyDig: string): string {
  switch (action) {
    case "http.request": return `http:${String(args.profile)}:${keyDig}`;
  }
}

// --- The exact-value scan's input -----------------------------------------------------------------------------

/**
 * Every string in `v` (object keys too), for BrokerDO's `scanSecrets`, which compares them with its stored
 * secrets' exact values. No credential shapes are looked for (the owner, 2026-11-12: nest assumes no services).
 */
export function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    out.push(k);
    stringsOf(x, out);
  }
  return out;
}

// --- The journal ---------------------------------------------------------------------------------------------

/** `brokered_journal.status`: on its way out, settled (done, failed at the provider, outcome unknown), or refused before it left. */
const JournalStatus = z.enum(["sending", "done", "failed", "unknown", "refused"]);
export type JournalStatus = z.output<typeof JournalStatus>;
export const JOURNAL_STATUSES = JournalStatus.options;

/**
 * What happens to a brokered call: an attempt leaves (`send`), it settles (`done`, `fail`, `unknown`), it is
 * refused before it left (`refuse`), or it never settled and is given up on by age (`abandon`, the prune).
 */
export const JOURNAL_EVENTS = ["send", "done", "fail", "unknown", "refuse", "abandon"] as const;
export type JournalEvent = (typeof JOURNAL_EVENTS)[number];

/**
 * The journal's one step: the status after `event`, or `refuse` when it doesn't apply there (`none`: no
 * row yet). Every write to `brokered_journal.status` goes through it.
 * - Nothing settled is ever sent again.
 * - `done` and `refused` are final. `unknown` may still become `done` or `failed`, and `failed` may still
 *   become `done`: another delivery of the same call learned that it took effect (two deliveries can both
 *   reach the provider; the one it refused as a duplicate must not hide the one it accepted).
 * - A call can settle with no attempt recorded (a pull request that was already open).
 */
export function journalStep(status: JournalStatus | "none", event: JournalEvent): JournalStatus | "refuse" {
  const settled = event === "done" ? "done" : event === "fail" ? "failed" : event === "unknown" ? "unknown" : null;
  if (status === "none") return event === "send" ? "sending" : event === "refuse" ? "refused" : settled ?? "refuse";
  if (status === "sending") return event === "send" ? "sending" : event === "abandon" ? "unknown" : settled ?? "refuse";
  if (status === "unknown") return event === "done" || event === "fail" ? settled! : "refuse";
  if (status === "failed") return event === "done" ? "done" : "refuse";
  return "refuse";
}

/** One journal row as the operator reads it (`GET /v1/agents/:agent/brokered`). */
export interface JournalEntry {
  key: string;
  action: string;
  target: string;
  idem: string;
  digest: string;
  /** The arguments as sent (clipped to `JOURNAL_ARGS_BYTES`); a refused call's are withheld. */
  args: string;
  status: JournalStatus;
  attempts: number;
  /** What it came to, for the operator: the provider's ids, a status, or why it was refused. */
  detail: string | null;
  tainted: boolean;
  created_ms: number;
  settled_ms: number | null;
}

export const JOURNAL_ARGS_BYTES = 4096;

/** What identifies a call's row. */
export type JournalRow = Pick<JournalEntry, "key" | "action" | "target" | "idem" | "digest" | "args" | "tainted">;

/** The durable record of every brokered action an agent ran or was refused. The only code that touches `brokered_journal`. */
export class BrokeredJournal {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS brokered_journal (key TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL,
      idem TEXT NOT NULL, digest TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      outcome TEXT, detail TEXT, tainted INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, settled_ms INTEGER)`);
    sql.exec("CREATE INDEX IF NOT EXISTS brokered_journal_action ON brokered_journal (action, created_ms)");
  }

  get(key: string): (JournalEntry & { outcome: ToolOutcome | null }) | undefined {
    const r = this.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM brokered_journal WHERE key = ?", key).toArray()[0];
    return r ? { ...this.row(r), outcome: r.outcome ? JSON.parse(String(r.outcome)) as ToolOutcome : null } : undefined;
  }

  /** The row's status, or `none`. */
  private status(key: string): JournalStatus | "none" {
    const r = this.sql.exec<{ status: string }>("SELECT status FROM brokered_journal WHERE key = ?", key).toArray()[0];
    return r ? storedEnum(JournalStatus, r.status, "brokered_journal.status") : "none";
  }

  /**
   * Write-ahead: recorded `sending` (an attempt more) in the same synchronous step as the request leaves.
   * False when the call has settled already (another delivery of it finished meanwhile): nothing is
   * recorded and the caller sends nothing.
   */
  sending(e: JournalRow): boolean {
    const to = journalStep(this.status(e.key), "send");
    if (to === "refuse") return false;
    this.sql.exec(`INSERT INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, tainted, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, status = excluded.status`,
      e.key, e.action, e.target, e.idem, e.digest, clipArgs(e.args), to, e.tainted ? 1 : 0, Date.now());
    return true;
  }

  /**
   * What the call came to (a row for it if it never went out: a pull request that was already open).
   * False when the row keeps what it has: a settled call keeps its outcome (`journalStep`).
   */
  settle(e: JournalRow, status: "done" | "failed" | "unknown", outcome: ToolOutcome, detail: string): boolean {
    const to = journalStep(this.status(e.key), status === "done" ? "done" : status === "failed" ? "fail" : "unknown");
    if (to === "refuse") return false;
    this.sql.exec(`INSERT INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, outcome, detail, tainted, created_ms, settled_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, detail = excluded.detail, settled_ms = excluded.settled_ms`,
    e.key, e.action, e.target, e.idem, e.digest, clipArgs(e.args), to, JSON.stringify(outcome), detail.slice(0, 2000), e.tainted ? 1 : 0, Date.now(), Date.now());
    return true;
  }

  /** Refused before it left (a credential in the arguments): the arguments aren't kept. Only a call with no row yet. */
  refuse(e: Pick<JournalEntry, "key" | "action" | "target" | "idem" | "digest" | "tainted">, why: string): boolean {
    const to = journalStep(this.status(e.key), "refuse");
    if (to === "refuse") return false;
    this.sql.exec(`INSERT INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, detail, tainted, created_ms, settled_ms)
      VALUES (?, ?, ?, ?, ?, '(withheld)', ?, 0, ?, ?, ?, ?)`, e.key, e.action, e.target, e.idem, e.digest, to, why.slice(0, 2000), e.tainted ? 1 : 0,
    Date.now(), Date.now());
    return true;
  }

  /** How many of `action`'s calls went out (or are going) since `sinceMs`: what the hourly cap counts. */
  sentSince(action: string, sinceMs: number): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM brokered_journal WHERE action = ? AND created_ms > ? AND status != 'refused'`,
      action, sinceMs).toArray()[0]!.n;
  }

  /** The oldest counted call since `sinceMs` (when the cap frees a slot). */
  oldestSince(action: string, sinceMs: number): number | null {
    return this.sql.exec<{ at: number | null }>(`SELECT MIN(created_ms) AS at FROM brokered_journal WHERE action = ? AND created_ms > ? AND status != 'refused'`,
      action, sinceMs).toArray()[0]?.at ?? null;
  }

  /** Newest first, `before` an earlier page's last `created_ms`. */
  list(limit: number, before?: number): JournalEntry[] {
    return this.sql.exec<Record<string, SqlStorageValue>>(
      "SELECT * FROM brokered_journal WHERE created_ms < ? ORDER BY created_ms DESC, key DESC LIMIT ?", before ?? Number.MAX_SAFE_INTEGER,
      Math.max(1, Math.min(limit, 500))).toArray().map((r) => this.row(r));
  }

  /**
   * Settled rows go once they settled before `cutoff`. A row still `sending` that long after its first
   * attempt can't settle on its own (the delivery that would is long gone): it is given up on as
   * `unknown` (`abandon`), which the operator can then read for as long again before it goes.
   */
  prune(cutoff: number, now = Date.now()): void {
    const outcome: ToolOutcome = {
      status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, "the action never settled; it may or may not have taken effect. Check before calling again."),
    };
    for (const from of JOURNAL_STATUSES) {
      const to = journalStep(from, "abandon");
      if (to !== "refuse") {
        this.sql.exec("UPDATE brokered_journal SET status = ?, outcome = ?, detail = ?, settled_ms = ? WHERE status = ? AND created_ms < ?",
          to, JSON.stringify(outcome), "never settled: given up on by age", now, from, cutoff);
      }
    }
    const open = JOURNAL_STATUSES.filter((st) => journalStep(st, "abandon") !== "refuse");
    this.sql.exec(`DELETE FROM brokered_journal WHERE status NOT IN (${open.map((st) => `'${st}'`).join(", ")}) AND COALESCE(settled_ms, created_ms) < ?`, cutoff);
  }

  private row(r: Record<string, SqlStorageValue>): JournalEntry {
    return {
      key: String(r.key), action: String(r.action), target: String(r.target), idem: String(r.idem), digest: String(r.digest), args: String(r.args),
      status: storedEnum(JournalStatus, r.status, "brokered_journal.status"), attempts: Number(r.attempts), detail: r.detail === null ? null : String(r.detail),
      tainted: r.tainted === 1, created_ms: Number(r.created_ms), settled_ms: r.settled_ms === null ? null : Number(r.settled_ms),
    };
  }
}

const clipArgs = (s: string) => (s.length > JOURNAL_ARGS_BYTES ? `${s.slice(0, JOURNAL_ARGS_BYTES)}… (${s.length} bytes in all)` : s);

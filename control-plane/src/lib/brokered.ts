// Brokered actions (docs/agents/tools/#taint-and-sinks, docs/agents/capabilities/#built-in-capabilities):
// actions the control plane runs for an agent with credentials no agent or sandbox ever holds. This
// module is the pure half: the action registry, the catalog's `brokered` source and what a spec keeps
// of it, authority (which grant covers a call), the model-facing tool definitions, natural idempotency
// keys, the argument secret scan's patterns, and the journal (the one class here with storage).
// AgentDO runs the pipeline (do/agent.ts, `brokeredTool`); BrokerDO mints GitHub tokens (lib/github.ts).
import { z } from "zod";
import type { ToolDef, ToolOutcome } from "../protocol/control";
import { storedEnum } from "./stored";
import type { WhenTainted } from "./sinks";
import { sha256, hex } from "./util";

// --- The registry ------------------------------------------------------------------------------------

/**
 * GitHub repository permissions an installation token is narrowed to (docs.github.com, "Permissions
 * required for GitHub Apps"); the names and levels a client may ask for are `GITHUB_REPO_PERMISSIONS` (lib/github.ts).
 */
export type GithubPermissions = Readonly<Record<string, "read" | "write" | "admin">>;

const REPO = { type: "string", description: "owner/name" };
const BODY = (what: string) => ({ type: "string", description: `${what} (Markdown).`, maxLength: 65_536 });

interface ActionDef {
  /** The model-facing tool (`mcp__nest__<tool>`): API tool names allow no `.`. */
  tool: string;
  /** `github`: an App installation token; `github_user`: the owner's own token (`github_user`); `http`: a profile; `none`: no provider. */
  kind: "github" | "github_user" | "http" | "none";
  description: string;
  input_schema: Record<string, unknown>;
  /** github: what the installation token is narrowed to. */
  permissions?: GithubPermissions;
}

/**
 * Every brokered action nest knows. `email.send` has no provider yet: listed so the name is reserved,
 * refused in the catalog, and `not_implemented` when called.
 */
export const BROKERED_ACTIONS = {
  "github.comment": {
    tool: "github_comment", kind: "github",
    description: "Comment on an issue or pull request, through the GitHub App (the comment is by the App, not by you).",
    input_schema: {
      type: "object", properties: { repo: REPO, issue_number: { type: "integer", minimum: 1 }, body: BODY("The comment") },
      required: ["repo", "issue_number", "body"], additionalProperties: false,
    },
    // The issue-comment endpoints are listed under both Issues and Pull requests (write); a PR's comment needs the latter.
    permissions: { issues: "write", pull_requests: "write" },
  },
  "github.create_issue": {
    tool: "github_create_issue", kind: "github",
    description: "Open an issue, through the GitHub App.",
    input_schema: {
      type: "object",
      properties: { repo: REPO, title: { type: "string", maxLength: 256 }, body: BODY("The issue's text"), labels: { type: "array", items: { type: "string" }, maxItems: 10 } },
      required: ["repo", "title"], additionalProperties: false,
    },
    permissions: { issues: "write" },
  },
  "github.create_pr": {
    tool: "github_create_pr", kind: "github",
    description: "Open a pull request from a pushed branch, through the GitHub App. An open pull request from the same head to the same base is returned instead of a second one.",
    input_schema: {
      type: "object",
      properties: {
        repo: REPO, title: { type: "string", maxLength: 256 }, head: { type: "string", description: "The branch with the changes (owner:branch for another fork's)." },
        base: { type: "string", description: "The branch to merge into." }, body: BODY("The description"), draft: { type: "boolean" },
      },
      required: ["repo", "title", "head", "base"], additionalProperties: false,
    },
    permissions: { pull_requests: "write", contents: "read" },
  },
  "github.review_comment": {
    tool: "github_review_comment", kind: "github",
    description: "Comment on a line of a pull request's diff, through the GitHub App.",
    input_schema: {
      type: "object",
      properties: {
        repo: REPO, pull_number: { type: "integer", minimum: 1 }, commit_id: { type: "string", description: "The commit (full SHA) the line is in." },
        path: { type: "string", description: "The file, relative to the repository root." }, line: { type: "integer", minimum: 1 },
        side: { type: "string", enum: ["LEFT", "RIGHT"] }, body: BODY("The comment"),
      },
      required: ["repo", "pull_number", "commit_id", "path", "line", "body"], additionalProperties: false,
    },
    permissions: { pull_requests: "write", contents: "read" },
  },
  "github.fork": {
    tool: "github_fork", kind: "github_user",
    description: "Fork a public repository into the operator's GitHub account (default branch only). Always needs the operator's approval. "
      + "The fork joins your sandbox's push allowlist; push your branch there, then hand the operator the compare link in the result to open the upstream pull request.",
    input_schema: {
      type: "object", properties: { repo: { ...REPO, description: "The upstream repository, owner/name." } }, required: ["repo"], additionalProperties: false,
    },
  },
  "http.request": {
    tool: "http_request", kind: "http",
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
  "email.send": {
    tool: "email_send", kind: "none", description: "Not available: no email provider is configured.",
    input_schema: { type: "object", properties: {}, additionalProperties: true },
  },
} as const satisfies Record<string, ActionDef>;

export type BrokeredAction = keyof typeof BROKERED_ACTIONS;
export const BROKERED_ACTION_NAMES = Object.keys(BROKERED_ACTIONS) as BrokeredAction[];
export const GITHUB_ACTIONS = ["github.comment", "github.create_issue", "github.create_pr", "github.review_comment"] as const;
export type GithubAction = (typeof GITHUB_ACTIONS)[number];
/** Every brokered tool's model-facing name: no mcp capability may make one (`capabilityNameClash`). */
export const BROKERED_TOOL_NAMES: readonly string[] = BROKERED_ACTION_NAMES.map((a) => BROKERED_ACTIONS[a].tool);

export const actionDef = (action: string): ActionDef | undefined =>
  Object.hasOwn(BROKERED_ACTIONS, action) ? BROKERED_ACTIONS[action as BrokeredAction] : undefined;
export const actionOfTool = (tool: string): BrokeredAction | undefined => BROKERED_ACTION_NAMES.find((a) => BROKERED_ACTIONS[a].tool === tool);

// --- The catalog's `brokered` source -----------------------------------------------------------------------

/** `owner/name`, as GitHub allows them (compared without case: GitHub's names are case-insensitive). */
export const Repo = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "a repo is owner/name");
const WhenTaintedField = z.enum(["approve", "allow"]);
const PerHour = z.number().int().min(1).max(1000);
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;
const Method = z.enum(HTTP_METHODS);
const HeaderName = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "a header name");
export const ProfileName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "profile names are lowercase letters, digits and '-'");

/** Headers a profile's credential may never go in, or a caller set: routing, framing and hop-by-hop. */
const RESERVED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "te", "trailer", "upgrade", "keep-alive",
  "proxy-authorization", "proxy-authenticate", "proxy-connection", "cookie", "content-type", "accept"]);

const GithubEntry = z.object({
  action: z.enum(GITHUB_ACTIONS),
  /** The repos it may act on; absent: any repo the App is installed on (unscoped: `approve` when tainted by default). */
  repos: z.array(Repo).min(1).max(100).optional(),
  when_tainted: WhenTaintedField.optional(),
  per_hour: PerHour.optional(),
});

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

const EmailEntry = z.object({ action: z.literal("email.send") });

/** `github.fork`: the upstreams it may fork (absent: any public repo). Always `approve`, from any session: it widens the push allowlist. */
const ForkEntry = z.object({ action: z.literal("github.fork"), repos: z.array(Repo).min(1).max(100).optional(), per_hour: PerHour.optional() });

export const BrokeredEntry = z.union([GithubEntry, HttpEntry, EmailEntry, ForkEntry]);
export type BrokeredEntry = z.output<typeof BrokeredEntry>;
export const BrokeredSource = z.array(BrokeredEntry).max(64);

/** What a spec keeps of one entry, copied at spawn: defaults resolved, repos lowercased. */
export type BrokeredGrant =
  | { capability: string; action: GithubAction | "github.fork"; repos: string[] | null; when_tainted: WhenTainted; per_hour: number }
  | {
    capability: string; action: "http.request"; profile: string; base_url: string; methods: string[]; paths: string[] | null;
    auth: { secret: string; header: string; scheme: string } | null; trusted: boolean; when_tainted: WhenTainted; per_hour: number;
    idempotency_header: string | null;
  };

export const DEFAULT_PER_HOUR = { github: 30, http: 60 } as const;
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * A spec's grant from a catalog entry. Defaults ("balanced", docs/agents/tools/#taint-and-sinks): a
 * GitHub write scoped to repos is `allow` when tainted, an unscoped one `approve`; an http profile is
 * `approve` (a read-only one isn't a sink, so it's never gated).
 */
export function grantOfEntry(capability: string, e: BrokeredEntry): BrokeredGrant | null {
  if (e.action === "email.send") return null;
  if (e.action === "http.request") {
    return {
      capability, action: e.action, profile: e.profile, base_url: e.base_url.replace(/\/+$/, ""), methods: [...new Set(e.methods)],
      paths: e.paths ? [...e.paths] : null, auth: e.auth ? { ...e.auth } : null, trusted: e.trusted ?? false,
      when_tainted: e.when_tainted ?? "approve", per_hour: e.per_hour ?? DEFAULT_PER_HOUR.http, idempotency_header: e.idempotency_header ?? null,
    };
  }
  if (e.action === "github.fork") {
    return { capability, action: e.action, repos: e.repos ? [...new Set(e.repos.map((r) => r.toLowerCase()))] : null, when_tainted: "approve", per_hour: e.per_hour ?? 5 };
  }
  return {
    capability, action: e.action, repos: e.repos ? [...new Set(e.repos.map((r) => r.toLowerCase()))] : null,
    when_tainted: e.when_tainted ?? (e.repos ? "allow" : "approve"), per_hour: e.per_hour ?? DEFAULT_PER_HOUR.github,
  };
}

/**
 * A spec's grants under a push allowlist (docs/agents/capabilities/brokered/#repo-allowlists): an unscoped
 * GitHub grant ("any repo the App is installed on") reaches only the allowlist's repos; a scoped one keeps
 * the repos the catalog named. No allowlist: unchanged.
 */
export function scopeToRepos(grants: readonly BrokeredGrant[], repos: readonly string[]): BrokeredGrant[] {
  if (!repos.length) return [...grants];
  // A fork's repos are upstreams, never on a push allowlist: it keeps its own scope.
  return grants.map((g) => (g.action !== "http.request" && g.action !== "github.fork" && g.repos === null ? { ...g, repos: [...repos] } : g));
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

/** The catalog entries of one capability, checked: known, implemented actions; well-formed profiles, each named once. */
export function checkBrokered(entries: readonly BrokeredEntry[], allowLoopback: boolean): Result<true> {
  const profiles = new Set<string>();
  for (const e of entries) {
    if (e.action === "email.send") return { ok: false, error: "email.send isn't implemented: no email provider is configured" };
    if (e.action !== "http.request") continue;
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
  /** github: `owner/name` (lowercase); http: the profile. */
  target: string;
  sink: boolean;
  when_tainted: WhenTainted;
  per_hour: number;
  /** http only: the profile's grant. */
  profile?: Extract<BrokeredGrant, { action: "http.request" }>;
}

/**
 * Which of the spec's grants cover this call (`args` already validated against the action's schema).
 * Several covering grants (from several capabilities) are separate grants: the call is allowed when
 * tainted if any of them allows it, and gets the highest hourly cap.
 */
export function authorize(grants: readonly BrokeredGrant[], action: BrokeredAction, args: Record<string, unknown>): Result<Authorized> {
  const mine = grants.filter((g) => g.action === action);
  if (!mine.length) return { ok: false, error: `${action} isn't granted to this agent` };
  if (action === "http.request") {
    const g = mine.find((x) => x.action === "http.request" && x.profile === args.profile) as Extract<BrokeredGrant, { action: "http.request" }> | undefined;
    if (!g) return { ok: false, error: `no http profile ${String(args.profile)} is granted to this agent` };
    const method = String(args.method);
    const path = String(args.path);
    if (!g.methods.includes(method)) return { ok: false, error: `profile ${g.profile} allows ${g.methods.join(", ")}, not ${method}` };
    if (!safePath(path)) return { ok: false, error: `${path} isn't a safe path (starts with /; no %, \\, ?, #, // or dot segments)` };
    if (g.paths && !g.paths.some((p) => pathCovered(p, path))) return { ok: false, error: `profile ${g.profile} doesn't cover ${path}` };
    const readOnly = g.methods.every((m) => READ_METHODS.has(m));
    return { ok: true, value: { action, target: g.profile, sink: !readOnly, when_tainted: g.when_tainted, per_hour: g.per_hour, profile: g } };
  }
  const repo = String(args.repo).toLowerCase();
  const covering = mine.filter((g) => g.action !== "http.request" && (g.repos === null || g.repos.includes(repo)));
  if (!covering.length) return { ok: false, error: `${action} isn't granted for ${repo}` };
  return {
    ok: true,
    value: {
      action, target: repo, sink: true,
      when_tainted: covering.some((g) => g.when_tainted === "allow") ? "allow" : "approve",
      per_hour: Math.max(...covering.map((g) => g.per_hour)),
    },
  };
}

/**
 * The model-facing definitions of the actions a spec grants: one tool per action, its schema narrowed to
 * what the grants allow (the repos or profiles). `brokered{action, args}` reaches the same actions.
 */
export function brokeredToolDefs(grants: readonly BrokeredGrant[]): ToolDef[] {
  const out: ToolDef[] = [];
  for (const action of BROKERED_ACTION_NAMES) {
    const mine = grants.filter((g) => g.action === action);
    if (!mine.length) continue;
    const def = BROKERED_ACTIONS[action];
    const schema = structuredClone(def.input_schema) as { properties: Record<string, Record<string, unknown>> };
    let description: string = def.description;
    if (action === "http.request") {
      const ps = mine as Extract<BrokeredGrant, { action: "http.request" }>[];
      schema.properties.profile = { type: "string", enum: ps.map((p) => p.profile) };
      description += ` Profiles: ${ps.map((p) => `${p.profile} (${p.base_url}, ${p.methods.join("/")}${p.paths ? `, under ${p.paths.join(" ")}` : ""})`).join("; ")}.`;
    } else {
      const repos = (mine as { repos: string[] | null }[]).some((g) => g.repos === null) ? null : [...new Set(mine.flatMap((g) => (g as { repos: string[] }).repos))];
      if (repos) {
        schema.properties.repo = { type: "string", enum: repos };
      } else {
        description += " Any repository the App is installed on.";
      }
    }
    out.push({ name: def.tool, description, input_schema: schema, roles: [], requires_approval: false });
  }
  return out;
}

// --- Natural idempotency keys and markers ---------------------------------------------------------------------

/** A short, stable digest of a call key: what a marker carries (no agent id in a public comment). */
export async function keyDigest(key: string): Promise<string> {
  return hex(await sha256(key)).slice(0, 24);
}

/** The hidden marker appended to text an action posts, so a redelivered call can find what it posted. */
export const marker = (digest: string) => `<!-- nest:${digest} -->`;

/**
 * The action's natural idempotency key: what makes two calls the same external effect. A pull request
 * is `(repo, head, base)` (GitHub keeps one open per pair); a comment, issue or review comment is
 * the call itself (two calls are two comments), found again by its marker; a request is the call.
 */
export function naturalKey(action: BrokeredAction, args: Record<string, unknown>, keyDig: string): string {
  const repo = String(args.repo ?? "").toLowerCase();
  switch (action) {
    case "github.create_pr": return `pr:${repo}:${String(args.head)}:${String(args.base)}`;
    case "github.comment": return `comment:${repo}#${String(args.issue_number)}:${keyDig}`;
    case "github.review_comment": return `review:${repo}#${String(args.pull_number)}:${keyDig}`;
    case "github.create_issue": return `issue:${repo}:${keyDig}`;
    case "http.request": return `http:${String(args.profile)}:${keyDig}`;
    case "github.fork": return `fork:${repo}`;
    case "email.send": return `email:${keyDig}`;
  }
}

// --- The secret scan's patterns -------------------------------------------------------------------------------

/**
 * Credential shapes refused in a brokered action's arguments, whoever's they are. BrokerDO adds its own
 * stored values (`scanSecrets`). Sources: GitHub's token prefixes (github.blog, 2021-04-05, "Behind
 * GitHub's new authentication token formats"), AWS access key ids (docs.aws.amazon.com, IAM identifiers),
 * PEM private keys (RFC 7468); the others are the providers' documented prefixes (unverified here).
 */
const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ["an Anthropic key or token", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["an AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["a Stripe secret key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
];

/** Every string in `v` (object keys too), for the scan. */
export function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    out.push(k);
    stringsOf(x, out);
  }
  return out;
}

/** The kinds of credential the strings hold (empty: none recognized). */
export function secretKinds(strings: readonly string[]): string[] {
  return SECRET_PATTERNS.filter(([, re]) => strings.some((s) => re.test(s))).map(([k]) => k);
}

// --- The journal ---------------------------------------------------------------------------------------------

/** `brokered_journal.status`: on its way out, settled (done, failed at the provider, outcome unknown), or refused before it left. */
const JournalStatus = z.enum(["sending", "done", "failed", "unknown", "refused"]);
export type JournalStatus = z.output<typeof JournalStatus>;

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

  /** Write-ahead: recorded `sending` (an attempt more) in the same synchronous step as the request leaves. */
  sending(e: JournalRow): void {
    this.sql.exec(`INSERT INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, tainted, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, status = 'sending'`,
      e.key, e.action, e.target, e.idem, e.digest, clipArgs(e.args), e.tainted ? 1 : 0, Date.now());
  }

  /** What the call came to (a row for it if it never went out: a pull request that was already open). */
  settle(e: JournalRow, status: "done" | "failed" | "unknown", outcome: ToolOutcome, detail: string): void {
    this.sql.exec(`INSERT INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, outcome, detail, tainted, created_ms, settled_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET status = excluded.status, outcome = excluded.outcome, detail = excluded.detail, settled_ms = excluded.settled_ms`,
    e.key, e.action, e.target, e.idem, e.digest, clipArgs(e.args), status, JSON.stringify(outcome), detail.slice(0, 2000), e.tainted ? 1 : 0, Date.now(), Date.now());
  }

  /** Refused before it left (a credential in the arguments): the arguments aren't kept. */
  refuse(e: Pick<JournalEntry, "key" | "action" | "target" | "idem" | "digest" | "tainted">, why: string): void {
    this.sql.exec(`INSERT OR IGNORE INTO brokered_journal (key, action, target, idem, digest, args, status, attempts, detail, tainted, created_ms, settled_ms)
      VALUES (?, ?, ?, ?, ?, '(withheld)', 'refused', 0, ?, ?, ?, ?)`, e.key, e.action, e.target, e.idem, e.digest, why.slice(0, 2000), e.tainted ? 1 : 0,
    Date.now(), Date.now());
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

  prune(cutoff: number): void {
    this.sql.exec("DELETE FROM brokered_journal WHERE status != 'sending' AND created_ms < ?", cutoff);
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

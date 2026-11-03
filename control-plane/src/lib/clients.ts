// API clients (docs/control-plane/api/clients/): principals, grants, tokens and labels. Pure: no I/O
// beyond hashing, nothing awaited but WebCrypto. Nothing here knows any one client: a grant is a
// ceiling, checked the same way for every client.
import { z } from "zod";
import { GithubRepoPermissions, levelWithin } from "./github";
import { InjectHost, injectionsOutsideGrant, SECRET_MAX_BYTES_DEFAULT } from "./client-secrets";
import { canonicalRepos, Repo } from "./repos";
import type { AgentSpec, Capability } from "./spec";
import { hex, sha256 } from "./util";

/** A client's name: unique, and its catalog namespace (`<name>/<entry>`). */
export const ClientName = z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, "a client name is 2-31 lowercase letters, digits and '-', starting with a letter");
/** A client's id, as `newId("cli_")` makes it. */
export const CLIENT_ID = /^cli_[A-Za-z0-9]+$/;
export const isClientId = (s: string | null | undefined): s is string => typeof s === "string" && CLIENT_ID.test(s);
/** Whether an owner names an agent (an owner is `null`, the operator; `cli_…`, a client; or `agt_…`). */
export const isAgentId = (s: string | null | undefined): s is string => typeof s === "string" && s.startsWith("agt_");

// --- Grants ------------------------------------------------------------------------------------------

const CellName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "a cell name");
/**
 * An MCP server URL a client's capabilities may name: exact, or a prefix ending in `/`. Written in
 * canonical form (what `new URL(u).href` gives), so an exact entry can't silently become a prefix.
 */
const McpUrlEntry = z.string().min(1).max(2048).refine((u) => {
  try {
    const p = new URL(u);
    return p.href === u && (p.protocol === "https:" || p.protocol === "http:") && !p.username && !p.password && !p.search && !p.hash;
  } catch {
    return false;
  }
}, "an mcp_urls entry is an http(s) URL in canonical form (as new URL(u).href writes it), with no credentials, query or fragment");

/** What a client may do: its ceiling. Anything it doesn't name is refused. */
export const Grant = z.strictObject({
  /** Where its agents and sandboxes may run. */
  cells: z.array(CellName).max(64).default([]),
  /** The BrokerDO secrets its agents' specs may name: the model credential, and an mcp capability's `auth` (one with none needs none). Exact. */
  credentials: z.array(z.string().min(1).max(160)).max(64).default([]),
  /** The repos its agents' sandboxes may push to and its GitHub brokered actions may reach (`owner/name`, exact). */
  repos: z.array(Repo).max(256).default([]),
  /**
   * The repos its agents' sandboxes may only read (`owner/name`, exact): a spec may read any repo here or
   * in `repos`, and push only to `repos`. A grant stored before this field reads as none.
   */
  read_repos: z.array(Repo).max(256).default([]),
  /** The MCP server URLs its capabilities may name. */
  mcp_urls: z.array(McpUrlEntry).max(64).default([]),
  /**
   * The GitHub App tokens it may mint (`POST /v1/clients/self/github-token`): for these repos, with at
   * most these repository permissions. A grant stored by the release before this one may name other
   * permissions; no request can name them, so they mint nothing.
   */
  github: z.strictObject({
    repos: z.array(Repo).max(256).default([]),
    permissions: GithubRepoPermissions.default({}),
  }).optional(),
  /**
   * The secrets it may store (`PUT /v1/clients/self/secrets/<name>`, docs/control-plane/api/clients/#secrets):
   * at most `max_count` of them, each value at most `max_bytes` (UTF-8). A grant stored before this field reads as none.
   */
  secrets: z.strictObject({
    max_count: z.number().int().min(0).max(1000).default(0),
    max_bytes: z.number().int().min(1).max(65_536).default(SECRET_MAX_BYTES_DEFAULT),
  }).default({ max_count: 0, max_bytes: SECRET_MAX_BYTES_DEFAULT }),
  /**
   * The hosts its secrets may be injected into (docs/control-plane/api/clients/#injection): exact names,
   * or `*.` suffixes of two or more labels. A grant stored before this field reads as none.
   */
  inject_hosts: z.array(InjectHost).max(64).default([]),
  /**
   * What its sandboxes' GitHub push tokens may carry beyond `contents` and `pull_requests` (docs/control-plane/api/clients/#workflow-files):
   * `workflows: true` lets its specs ask for `workflows: write`. Absent (as in every grant stored before it): nothing more.
   */
  github_push: z.strictObject({ workflows: z.boolean().default(false) }).optional(),
  /** Live (not ended, not destroyed) at once, across its whole subtree. */
  max_agents: z.number().int().min(0).max(100_000).default(0),
  max_sandboxes: z.number().int().min(0).max(100_000).default(0),
});
export type Grant = z.output<typeof Grant>;

/** Whether an MCP server URL is in the grant: an exact entry, or under a prefix entry ending in `/`. */
export function mcpUrlAllowed(grant: Pick<Grant, "mcp_urls">, url: string): boolean {
  let href: string;
  try {
    href = new URL(url).href;
  } catch {
    return false;
  }
  return grant.mcp_urls.some((e) => href === e || (e.endsWith("/") && href.startsWith(e)));
}

const repoSet = (repos: readonly string[]) => new Set(canonicalRepos(repos));

/**
 * What a brokered action reaches that the grant doesn't name, if anything. Only GitHub actions scoped
 * to repos in `repos` are within a grant: an http profile names a base URL and a credential no grant
 * field covers, and a fork widens the push allowlist.
 */
function brokeredOutside(action: string, repos: readonly string[] | null, capability: string, grant: Grant): string | null {
  if (!action.startsWith("github.") || action === "github.fork") return `brokered action ${action} (${capability})`;
  if (repos === null) return `brokered action ${action} on any repo (${capability})`;
  const allowed = repoSet(grant.repos);
  const wider = canonicalRepos(repos).filter((r) => !allowed.has(r));
  return wider.length ? `brokered action ${action} on ${wider.join(", ")} (${capability})` : null;
}

/**
 * Everything an expanded spec reaches outside the grant: its credential, each mcp server and the
 * secrets it authenticates with, its push allowlist, its read-only repos and its brokered actions. Empty: within it.
 */
export function specOutsideGrant(spec: Pick<AgentSpec, "credential" | "mcp" | "brokered" | "repos" | "read_repos" | "inject" | "github_push">, grant: Grant): string[] {
  const out: string[] = [];
  const creds = new Set(grant.credentials);
  if (!creds.has(spec.credential)) out.push(`credential ${spec.credential}`);
  for (const m of spec.mcp ?? []) {
    if (!mcpUrlAllowed(grant, m.url)) out.push(`mcp url ${m.url} (${m.capability})`);
    // A server that takes no bearer (no `auth`) has no secret to cover: its caller identity is the credential.
    if (m.auth !== undefined && !creds.has(m.auth)) out.push(`credential ${m.auth} (${m.capability})`);
    if (m.oauth?.client && !creds.has(m.oauth.client)) out.push(`credential ${m.oauth.client} (${m.capability})`);
  }
  const allowed = repoSet(grant.repos);
  const wider = canonicalRepos(spec.repos ?? []).filter((r) => !allowed.has(r));
  if (wider.length) out.push(`repos ${wider.join(", ")}`);
  // Reading is within either list; a grant stored before `read_repos` has none.
  const readable = repoSet([...grant.repos, ...(grant.read_repos ?? [])]);
  const unreadable = canonicalRepos(spec.read_repos ?? []).filter((r) => !readable.has(r));
  if (unreadable.length) out.push(`read_repos ${unreadable.join(", ")}`);
  for (const b of spec.brokered ?? []) {
    const o = brokeredOutside(b.action, "repos" in b ? b.repos : null, b.capability, grant);
    if (o) out.push(o);
  }
  out.push(...injectionsOutsideGrant(spec.inject ?? [], grant.inject_hosts ?? []));
  if (spec.github_push?.workflows && !grant.github_push?.workflows) out.push("github_push.workflows");
  return out;
}

/** What a capability, on its own, reaches outside the grant (checked when a client writes it). */
export function capabilityOutsideGrant(name: string, cap: Capability, grant: Grant): string[] {
  const out: string[] = [];
  const creds = new Set(grant.credentials);
  if (cap.mcp) {
    if (!mcpUrlAllowed(grant, cap.mcp.url)) out.push(`mcp url ${cap.mcp.url}`);
    const auth = cap.mcp.auth;
    for (const s of auth === undefined ? [] : typeof auth === "string" ? [auth] : [auth.oauth, ...(auth.client ? [auth.client] : [])]) {
      if (!creds.has(s)) out.push(`credential ${s}`);
    }
  }
  for (const e of cap.brokered ?? []) {
    const o = brokeredOutside(e.action, "repos" in e ? e.repos ?? null : null, name, grant);
    if (o) out.push(o);
  }
  return out;
}

/** `POST /v1/clients/self/github-token`'s body: one repo, and at least one permission. */
export const GithubTokenRequest = z.strictObject({
  repo: Repo,
  // None named would be a token with every permission the installation has (GitHub's default).
  permissions: GithubRepoPermissions.refine((p) => Object.keys(p).length > 0, "name at least one permission"),
});
export type GithubTokenRequest = z.output<typeof GithubTokenRequest>;

/**
 * What a GitHub token request asks for that the grant's `github` doesn't name: the repo (exact, without
 * case: GitHub's names are case-insensitive), each permission, and each level above the granted one
 * (`read` < `write` < `admin`). Empty: within it.
 */
export function githubTokenOutsideGrant(req: GithubTokenRequest, grant: Pick<Grant, "github">): string[] {
  const g = grant.github;
  const out: string[] = [];
  if (!g || !repoSet(g.repos).has(req.repo.toLowerCase())) out.push(`github repo ${req.repo}`);
  for (const [name, level] of Object.entries(req.permissions)) {
    const have = g && Object.hasOwn(g.permissions, name) ? g.permissions[name] : undefined;
    if (have === undefined) out.push(`github permission ${name}`);
    else if (!levelWithin(level, have)) out.push(`github permission ${name}: ${level} (the grant has ${have})`);
  }
  return out;
}

/** The refusal for what lies outside a client's grant (403), or null. */
export function grantRefusal(client: string, outside: readonly string[]): string | null {
  return outside.length ? `outside ${client}'s grant: ${outside.join("; ")}` : null;
}

// --- Tokens -----------------------------------------------------------------------------------------

const TOKEN = /^nest_cli_([A-Za-z0-9]+)_([0-9a-f]{64})$/;

/** A new client token for `client` (`cli_<id>`): `nest_cli_<id>_<secret>`, the secret 32 random bytes in hex. */
export function newClientToken(client: string): string {
  if (!isClientId(client)) throw new Error(`${client} is not a client id`);
  return `nest_cli_${client.slice(4)}_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The client a token claims to be, and its secret; null if it isn't a client token. */
export function parseClientToken(token: string): { client: string; secret: string } | null {
  const m = TOKEN.exec(token);
  return m ? { client: `cli_${m[1]}`, secret: m[2]! } : null;
}

/** What ClientDO stores of a token: the SHA-256 of the whole token, in hex (the secret is 256 random bits). */
export async function tokenHash(token: string): Promise<string> {
  return hex(await sha256(`nest-client-token/${token}`));
}

// --- Labels -----------------------------------------------------------------------------------------

export const MAX_LABELS = 16;
export const LabelKey = z.string().regex(/^[a-z][a-z0-9_.-]{0,62}$/, "a label key is lowercase letters, digits, '_', '.' and '-', starting with a letter, at most 63");
export const LabelValue = z.string().max(256, "a label value is at most 256 characters");
/** Up to 16 `key: value` pairs, set by whoever creates the agent or sandbox and fixed after. */
export const Labels = z.record(LabelKey, LabelValue).refine((l) => Object.keys(l).length <= MAX_LABELS, `at most ${MAX_LABELS} labels`);
export type Labels = z.output<typeof Labels>;

/** A listing's `?label=k=v` filters (each must hold). Throws a message for a malformed one. */
export function parseLabelFilters(values: readonly string[]): [string, string][] {
  if (values.length > MAX_LABELS) throw new Error(`at most ${MAX_LABELS} label filters`);
  return values.map((v) => {
    const i = v.indexOf("=");
    if (i <= 0) throw new Error(`a label filter is key=value, not ${JSON.stringify(v)}`);
    const k = LabelKey.safeParse(v.slice(0, i));
    if (!k.success) throw new Error(k.error.issues[0]!.message);
    const val = LabelValue.safeParse(v.slice(i + 1));
    if (!val.success) throw new Error(val.error.issues[0]!.message);
    return [k.data, val.data];
  });
}

/** Whether `labels` has every filter's key with its value. */
export const labelsMatch = (labels: Labels | null | undefined, filters: readonly [string, string][]): boolean =>
  filters.every(([k, v]) => labels !== null && labels !== undefined && Object.hasOwn(labels, k) && labels[k] === v);

/**
 * The SQL condition (and its bindings) for label filters on a JSON `labels` column. The JSON path
 * is a bound value, never spliced in; keys are validated (`LabelKey`) before they get here.
 */
export function labelWhere(column: string, filters: readonly [string, string][]): { sql: string; args: string[] } {
  if (!filters.length) return { sql: "1", args: [] };
  return {
    sql: filters.map(() => `json_extract(${column}, ?) = ?`).join(" AND "),
    args: filters.flatMap(([k, v]) => [`$."${k}"`, v]),
  };
}

// --- Catalog namespaces ------------------------------------------------------------------------------

/** A catalog entry as a client names it: the operator's `<entry>`, or its own `<client-name>/<entry>`. */
export function namespaceOf(entry: string): string | null {
  const i = entry.indexOf("/");
  return i < 0 ? null : entry.slice(0, i);
}

/** Whether a client named `client` (null: the operator) may read and spawn from `entry`. */
export const entryVisible = (entry: string, client: string | null): boolean => {
  const ns = namespaceOf(entry);
  return client === null || ns === null || ns === client;
};

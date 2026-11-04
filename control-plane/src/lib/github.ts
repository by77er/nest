// The GitHub App (docs/control-plane/durable-objects/broker/#github-app): the App's JWT, the REST client,
// and the requests each `github.*` brokered action makes. BrokerDO mints installation tokens with it;
// AgentDO runs actions with them. Sources (all docs.github.com, read 2026-10-31):
//   JWT:          /en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   installation: /en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app
//   token:        /en/rest/apps/apps#create-an-installation-access-token-for-an-app
//   the App:      /en/rest/apps/apps#get-the-authenticated-app
//   comments:     /en/rest/issues/comments#create-an-issue-comment, #list-issue-comments
//   issues:       /en/rest/issues/issues#create-an-issue, #list-repository-issues
//   pulls:        /en/rest/pulls/pulls#create-a-pull-request, #list-pull-requests
//   review:       /en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
//   permissions:  /en/rest/authentication/permissions-required-for-github-apps
import { b64url, concatBytes, NestError, pemToDer } from "./util";
import { ErrorCodes } from "../protocol/model";
import { z } from "zod";
import { checkBaseUrl, type GithubAction, type GithubPermissions, marker } from "./brokered";

export const GITHUB_API = "https://api.github.com";
/**
 * What a sandbox's injected token may do in its allowed repos: push (`contents: write`, which includes
 * the `contents: read` pull requests need: docs/agents/capabilities/brokered/#github-permissions) and
 * open pull requests (`gh pr create`).
 */
export const SANDBOX_TOKEN_PERMISSIONS: GithubPermissions = { contents: "write", pull_requests: "write" };
/**
 * What a sandbox's read-only token may do in its read-only repos: read their code (`contents: read`:
 * clone, fetch, the contents API) and the repo itself (`metadata: read`, which every App has: named so
 * the token carries it whether or not GitHub adds it; docs.github.com/en/rest/authentication/permissions-required-for-github-apps).
 * No write of any kind, so GraphQL with it can't change anything.
 */
export const SANDBOX_READ_TOKEN_PERMISSIONS: GithubPermissions = { contents: "read", metadata: "read" };
/**
 * Every repository permission an installation token may be asked for, with the levels GitHub offers
 * for each: the `app-permissions` schema of GitHub's REST description
 * (github.com/github/rest-api-description, `descriptions/api.github.com`, read 2026-11-02), its
 * repository block. Organization and account permissions are left out on purpose: a token minted for
 * one repo would still carry them, reaching past that repo.
 */
export const GITHUB_REPO_PERMISSIONS = {
  actions: ["read", "write"],
  administration: ["read", "write"],
  artifact_metadata: ["read", "write"],
  attestations: ["read", "write"],
  checks: ["read", "write"],
  code_quality: ["read", "write"],
  codespaces: ["read", "write"],
  contents: ["read", "write"],
  dependabot_secrets: ["read", "write"],
  deployments: ["read", "write"],
  discussions: ["read", "write"],
  environments: ["read", "write"],
  issues: ["read", "write"],
  merge_queues: ["read", "write"],
  metadata: ["read", "write"],
  packages: ["read", "write"],
  pages: ["read", "write"],
  pull_requests: ["read", "write"],
  repository_custom_properties: ["read", "write"],
  repository_hooks: ["read", "write"],
  repository_projects: ["read", "write", "admin"],
  secret_scanning_alerts: ["read", "write"],
  secrets: ["read", "write"],
  security_events: ["read", "write"],
  single_file: ["read", "write"],
  statuses: ["read", "write"],
  vulnerability_alerts: ["read", "write"],
  workflows: ["write"],
} as const satisfies Record<string, readonly ["read" | "write", ...("read" | "write" | "admin")[]]>;
export type GithubPermissionLevel = "read" | "write" | "admin";

const LEVEL_RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };
/** Whether `want` is at most `have` (`read` < `write` < `admin`); a level outside the three is never within. */
export const levelWithin = (want: string, have: string): boolean =>
  Object.hasOwn(LEVEL_RANK, want) && Object.hasOwn(LEVEL_RANK, have) && LEVEL_RANK[want]! <= LEVEL_RANK[have]!;

/**
 * Repository permissions, as a grant or a token request names them: only names in
 * {@link GITHUB_REPO_PERMISSIONS}, exactly (no other case, no look-alike characters), each at a level
 * GitHub offers for it.
 */
export const GithubRepoPermissions = z.strictObject(Object.fromEntries(Object.entries(GITHUB_REPO_PERMISSIONS)
  .map(([name, levels]) => [name, z.enum(levels as unknown as [GithubPermissionLevel, ...GithubPermissionLevel[]]).optional()])))
  .transform((p) => p as Readonly<Record<string, GithubPermissionLevel>>);

/** GitHub's REST version header (docs.github.com/en/rest/about-the-rest-api/api-versions). */
const API_VERSION = "2022-11-28";
/** An answer's body is read up to this many bytes. */
const MAX_BODY = 1024 * 1024;

// --- The App's key and JWT ---------------------------------------------------------------------------

/** DER length octets. */
function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
const der = (tag: number, body: Uint8Array) => concatBytes([new Uint8Array([tag]), derLength(body.length), body]);

/** `AlgorithmIdentifier { rsaEncryption, NULL }` (RFC 8017 A.1). */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/**
 * A PKCS#1 `RSAPrivateKey` wrapped as PKCS#8 `PrivateKeyInfo` (RFC 5208: version 0, the algorithm, the
 * key as an OCTET STRING): WebCrypto imports only PKCS#8, and GitHub hands out `BEGIN RSA PRIVATE KEY`.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der(0x30, concatBytes([new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1)]));
}

/** The App's private key (PKCS#1 or PKCS#8 PEM) as an RS256 signing key. */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The App's JWT: RS256, `iat` 60 s in the past (clock drift), `exp` 9 minutes on (GitHub allows at most 10), `iss` the App's id. */
export async function appJwt(appId: string, key: CryptoKey, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

/** The stored App credentials (`github_app`: `{"app_id", "private_key"}`), or null when they aren't JSON of that shape. */
export function parseAppSecret(value: string): { app_id: string; private_key: string } | null {
  try {
    const v = JSON.parse(value) as { app_id?: unknown; private_key?: unknown };
    const id = typeof v.app_id === "number" ? String(v.app_id) : v.app_id;
    if (typeof id === "string" && id && typeof v.private_key === "string" && v.private_key.includes("PRIVATE KEY")) return { app_id: id, private_key: v.private_key };
  } catch {
    // reported by the caller
  }
  return null;
}

// --- The REST client ---------------------------------------------------------------------------------------

/** What one request came to. */
export type GhAnswer =
  /** 2xx, with its JSON (null for an empty body). */
  | { kind: "ok"; status: number; json: unknown }
  /** 3xx or 4xx: GitHub refused it (redirects aren't followed, so a token never goes elsewhere). */
  | { kind: "refused"; status: number; message: string }
  /** No usable answer (timeout, network, 5xx): it may or may not have taken effect. */
  | { kind: "lost"; why: string };

export class GitHubApi {
  constructor(private readonly fetchFn: typeof fetch = fetch, readonly base = GITHUB_API, private readonly timeoutMs = 20_000) {}

  /** One request with `auth` as the bearer (the App's JWT or an installation token). Never throws. */
  async request(auth: string, method: string, path: string, body?: unknown): Promise<GhAnswer> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      // Never `this.fetchFn(...)`: the platform's fetch called as a method of this object gets the wrong
      // `this` and workerd throws "Illegal invocation" (review lesson 8; `the default fetch works` tests it).
      const fetchFn = this.fetchFn;
      const res = await fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json", "x-github-api-version": API_VERSION, "user-agent": "nest-control-plane",
          authorization: `Bearer ${auth}`, ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        signal: ctl.signal,
      });
      const text = await readCapped(res);
      if (res.status >= 500) return { kind: "lost", why: `HTTP ${res.status}` };
      if (res.status >= 300) {
        let message = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { message?: unknown; errors?: unknown };
          if (typeof j.message === "string") message = `${j.message}${j.errors ? ` ${JSON.stringify(j.errors).slice(0, 300)}` : ""}`;
        } catch {
          // not JSON: the text as is
        }
        return { kind: "refused", status: res.status, message };
      }
      if (!text) return { kind: "ok", status: res.status, json: null };
      try {
        return { kind: "ok", status: res.status, json: JSON.parse(text) };
      } catch {
        return { kind: "lost", why: `HTTP ${res.status} with a body that isn't JSON` };
      }
    } catch (e) {
      return { kind: "lost", why: ctl.signal.aborted ? `no answer within ${this.timeoutMs} ms` : `network: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The App's installation on `owner/repo`; null when it isn't installed there (404). */
  async installation(jwt: string, repo: string): Promise<number | null> {
    const r = await this.request(jwt, "GET", `/repos/${repo}/installation`);
    if (r.kind === "refused" && r.status === 404) return null;
    const id = r.kind === "ok" ? (r.json as { id?: unknown } | null)?.id : undefined;
    if (typeof id === "number") return id;
    throw ghError(r, `looking up the App's installation on ${repo}`);
  }

  /** The App itself (`GET /app` with its JWT): its numeric id and its slug. */
  async app(jwt: string): Promise<{ id: number; slug: string }> {
    const r = await this.request(jwt, "GET", "/app");
    const j = r.kind === "ok" ? (r.json as { id?: unknown; slug?: unknown } | null) : null;
    if (j && Number.isSafeInteger(j.id) && (j.id as number) > 0 && typeof j.slug === "string" && j.slug) return { id: j.id as number, slug: j.slug };
    throw ghError(r, "reading the App (GET /app)");
  }

  /**
   * An installation token for these repos (by name, without the owner: one installation is one account)
   * with these permissions only.
   */
  async mint(jwt: string, installation: number, repoNames: string | readonly string[], permissions: GithubPermissions): Promise<{ token: string; expires_ms: number }> {
    const repositories = typeof repoNames === "string" ? [repoNames] : [...repoNames];
    const r = await this.request(jwt, "POST", `/app/installations/${installation}/access_tokens`, { repositories, permissions });
    const j = r.kind === "ok" ? (r.json as { token?: unknown; expires_at?: unknown } | null) : null;
    const expires = typeof j?.expires_at === "string" ? Date.parse(j.expires_at) : NaN;
    if (j && typeof j.token === "string" && Number.isFinite(expires)) return { token: j.token, expires_ms: expires };
    throw ghError(r, `minting an installation token for ${repositories.join(", ")}`);
  }
}

/**
 * Revoke an installation token (`DELETE /installation/token`, authorized by the token itself). A token
 * already expired or revoked answers 401: that's revoked too.
 */
export async function revokeInstallationToken(api: GitHubApi, token: string): Promise<void> {
  const r = await api.request(token, "DELETE", "/installation/token");
  if (r.kind === "ok" || (r.kind === "refused" && r.status === 401)) return;
  throw ghError(r, "revoking an installation token");
}

/** The client for this Worker: `GITHUB_API_URL` (a loopback fake only with `ALLOW_LOOPBACK_BROKERED=1`), else GitHub's. */
export function githubApiOf(env: { GITHUB_API_URL?: string; ALLOW_LOOPBACK_BROKERED?: string }, timeoutMs?: number): GitHubApi {
  const base = env.GITHUB_API_URL;
  if (!base) return new GitHubApi(undefined, GITHUB_API, timeoutMs);
  const u = checkBaseUrl(base, env.ALLOW_LOOPBACK_BROKERED === "1");
  if (!u.ok) throw new NestError(ErrorCodes.INTERNAL, `GITHUB_API_URL: ${u.error}`, 500);
  return new GitHubApi(undefined, base.replace(/\/+$/, ""), timeoutMs);
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

/** A failed App request as a NestError: GitHub's refusal, or a retryable lost answer. */
export function ghError(r: GhAnswer, what: string): NestError {
  if (r.kind === "lost") return new NestError(ErrorCodes.INTERNAL, `GitHub: ${what}: ${r.why}`, 502, true);
  if (r.kind === "refused") {
    const code = r.status === 401 ? ErrorCodes.UNAUTHORIZED : r.status === 403 || r.status === 404 ? ErrorCodes.FORBIDDEN
      : r.status === 429 ? ErrorCodes.RATE_LIMITED : ErrorCodes.INVALID_MESSAGE;
    return new NestError(code, `GitHub: ${what}: HTTP ${r.status}: ${r.message}`, r.status === 429 ? 429 : 502, r.status === 429);
  }
  return new NestError(ErrorCodes.INTERNAL, `GitHub: ${what}: an unexpected answer (HTTP ${r.status})`, 502, true);
}

// --- The actions -------------------------------------------------------------------------------------------

/** One action's request, as GitHub's REST API takes it. */
export interface GhRequest {
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

/** The request `action` makes; text it posts carries the call's marker (`markerDigest`). */
export function actionRequest(action: GithubAction, a: Record<string, unknown>, markerDigest: string): GhRequest {
  const repo = String(a.repo);
  const withMarker = (t: unknown) => `${typeof t === "string" ? t : ""}\n\n${marker(markerDigest)}`;
  switch (action) {
    case "github.comment":
      return { method: "POST", path: `/repos/${repo}/issues/${Number(a.issue_number)}/comments`, body: { body: withMarker(a.body) } };
    case "github.create_issue":
      return { method: "POST", path: `/repos/${repo}/issues`, body: { title: String(a.title), body: withMarker(a.body), ...(Array.isArray(a.labels) ? { labels: a.labels } : {}) } };
    case "github.create_pr":
      return {
        method: "POST", path: `/repos/${repo}/pulls`,
        body: { title: String(a.title), head: String(a.head), base: String(a.base), ...(typeof a.body === "string" ? { body: a.body } : {}), ...(a.draft === true ? { draft: true } : {}) },
      };
    case "github.review_comment":
      return {
        method: "POST", path: `/repos/${repo}/pulls/${Number(a.pull_number)}/comments`,
        body: { body: withMarker(a.body), commit_id: String(a.commit_id), path: String(a.path), line: Number(a.line), side: a.side === "LEFT" ? "LEFT" : "RIGHT" },
      };
  }
}

/**
 * Where to look for what an earlier attempt of this call may have made ("read current external
 * state"): an open pull request from the same head to the same base, else the call's marker among the
 * newest comments or issues. Paths for a GET with the installation token.
 */
export function stateQuery(action: GithubAction, a: Record<string, unknown>): string {
  const repo = String(a.repo);
  switch (action) {
    case "github.create_pr": {
      const head = String(a.head).includes(":") ? String(a.head) : `${repo.split("/")[0]}:${String(a.head)}`;
      return `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(String(a.base))}&per_page=1`;
    }
    case "github.comment":
      // Oldest first; a marker this call posted is within the last 100 an hour after it (one page).
      return `/repos/${repo}/issues/${Number(a.issue_number)}/comments?since=${new Date(Date.now() - 3_600_000).toISOString()}&per_page=100`;
    case "github.create_issue":
      return `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=50`;
    case "github.review_comment":
      return `/repos/${repo}/pulls/${Number(a.pull_number)}/comments?sort=created&direction=desc&per_page=100`;
  }
}

/** What an action made, as the model sees it: ids and URLs only (GitHub's text is someone's text: it would taint). */
export interface GhMade {
  number?: number;
  id?: number;
  url: string;
  /** create_pr: the open pull request was already there (this call made nothing). */
  existing?: boolean;
}

const made = (j: unknown, existing = false): GhMade | null => {
  const o = (j ?? {}) as { number?: unknown; id?: unknown; html_url?: unknown };
  if (typeof o.html_url !== "string") return null;
  return { ...(typeof o.number === "number" ? { number: o.number } : {}), ...(typeof o.id === "number" ? { id: o.id } : {}), url: o.html_url, ...(existing ? { existing: true } : {}) };
};

/** A created resource from the action's answer. */
export const createdOf = (j: unknown): GhMade | null => made(j);

/** What `stateQuery`'s answer shows this call (or, for a PR, the same head and base) already made. */
export function foundInState(action: GithubAction, json: unknown, markerDigest: string): GhMade | null {
  const items = Array.isArray(json) ? (json as { body?: unknown }[]) : [];
  if (action === "github.create_pr") return items[0] ? made(items[0], true) : null;
  const hit = items.find((x) => typeof x?.body === "string" && x.body.includes(marker(markerDigest)));
  return hit ? made(hit) : null;
}

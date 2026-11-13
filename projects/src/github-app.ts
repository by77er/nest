// The app's own GitHub App (README.md#github-tokens): the tokens every call to GitHub carries. The App's id and
// private key are the Worker's secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, a PKCS#1 PEM). Its JWT is
// signed here with WebCrypto; each token is an installation token for one repo with exactly the permissions
// its call needs. nest's `POST /v1/clients/self/github-token` is the fallback for one release
// (`GITHUB_TOKEN_SOURCE=nest`). A token, the JWT and the key are never logged or put in an error.
//
// GitHub's docs this follows:
// - the JWT: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
// - a repo's installation: https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app
// - an installation token: https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
// - the App itself: https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app

import type { Env } from "./env";
import { GitHub, GitHubError } from "./github";
import { githubCovers } from "./grant-repos";
import { type Nest, NestError } from "./nest";

/** A cached token with less than this left is minted again (as nest's own reuse). */
export const TOKEN_REUSE_MS = 10 * 60_000;
/** A repo's installation, as looked up, is used this long before it's looked up again. */
export const INSTALLATION_LOOKUP_MS = 10 * 60_000;
/** The JWT lives 9 minutes (GitHub allows at most 10) and is signed again with a minute left. */
const JWT_LIFE_S = 540;
const JWT_SLACK_S = 60;

/** One token for one call, with what it came from. */
export interface Minted {
  token: string;
  /** The App the token is from; null when the source can't tell. */
  appId: number | null;
  /** The installation it was minted from; null when the source can't tell. */
  installationId: number | null;
  /** GitHub refused the token (a 401 or 404): drop it, and the repo's installation, so the next call looks again. */
  stale: () => void;
}

/** Where the app's GitHub tokens come from: its own App, or nest's (the fallback). */
export interface TokenSource {
  readonly kind: "app" | "nest";
  /** `fresh`: look the repo's installation up now, not from the cache (a binding's read). */
  token(repo: string, permissions: Record<string, string>, o?: { fresh?: boolean }): Promise<Minted>;
  /** The App's slug (its bot is `<slug>[bot]`); null when the source can't tell. */
  appSlug(repo: string): Promise<string | null>;
}

/** The source the Worker's env picks: nest's only when `GITHUB_TOKEN_SOURCE` is `nest`, else the App's own. */
export function tokenSource(env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_TOKEN_SOURCE">, nest: Nest): TokenSource {
  return env.GITHUB_TOKEN_SOURCE?.trim().toLowerCase() === "nest" ? new NestTokens(nest) : new AppTokens(env, nest);
}

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };
/** Whether `want` is at most `have` (read < write < admin), as nest compares a token's permissions to its grant. */
const levelWithin = (want: string, have: string | undefined) => have !== undefined && RANK[want] !== undefined && RANK[have] !== undefined && RANK[want]! <= RANK[have]!;

const positiveId = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

// --- the App's key and JWT -------------------------------------------------------------------------------

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** DER length octets. */
function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
const der = (tag: number, body: Uint8Array) => concat([new Uint8Array([tag]), derLength(body.length), body]);

/** `AlgorithmIdentifier { rsaEncryption, NULL }` (RFC 8017 A.1). */
const RSA_ALGORITHM = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

/**
 * A PKCS#1 `RSAPrivateKey` wrapped as PKCS#8 `PrivateKeyInfo` (RFC 5208: version 0, the algorithm, the key as
 * an OCTET STRING): WebCrypto imports only PKCS#8, and GitHub hands out `BEGIN RSA PRIVATE KEY`. Ported from
 * nest's control-plane/src/lib/github.ts.
 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  return der(0x30, concat([new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1)]));
}

/** The App's private key (PKCS#1, or PKCS#8, PEM) as an RS256 signing key. */
export async function importAppKey(pem: string): Promise<CryptoKey> {
  const body = b64ToBytes(pem.replace(/-----(BEGIN|END) [^-]+-----/g, "").replace(/\s+/g, ""));
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(body) : body;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** The App's JWT: RS256, `iat` 60 s in the past (clock drift), `exp` 9 minutes on, `iss` the App's id. */
export async function appJwt(appId: string, key: CryptoKey, nowMs = Date.now()): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const enc = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
  const input = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + JWT_LIFE_S, iss: appId })}`;
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

// --- the cache ---------------------------------------------------------------------------------------------

/**
 * One isolate's cache, for one App (a changed id or key starts a new one):
 * - each repo's installation as last looked up, and when;
 * - tokens by installation id, then by repo and permissions, so a token never outlives its installation: a
 *   lookup that answers another installation (the App reinstalled, the repo moved) drops the old one's tokens.
 */
interface AppCache {
  appId: string;
  pem: string;
  key: Promise<CryptoKey> | null;
  jwt: { value: string; exp_s: number } | null;
  slug: string | null;
  installations: Map<string, { id: number; at_ms: number }>;
  tokens: Map<number, Map<string, { token: string; expires_ms: number }>>;
}

let cache: AppCache | null = null;

/** Forget everything cached (tests). */
export function resetAppTokens(): void {
  cache = null;
}

/** What the cache holds now, without a token's value (tests). */
export function appTokenCache(): { installations: Record<string, number>; tokens: { installation: number; key: string; expires_ms: number }[] } {
  const installations: Record<string, number> = {};
  const tokens: { installation: number; key: string; expires_ms: number }[] = [];
  for (const [repo, i] of cache?.installations ?? []) installations[repo] = i.id;
  for (const [installation, m] of cache?.tokens ?? []) for (const [key, t] of m) tokens.push({ installation, key, expires_ms: t.expires_ms });
  return { installations, tokens };
}

/** The permissions as one key: sorted, so the same set is the same key. */
const permissionsKey = (p: Record<string, string>) => Object.keys(p).sort().map((k) => `${k}:${p[k]}`).join(",");

/** The App's own tokens, from its id and key in the Worker's env. */
export class AppTokens implements TokenSource {
  readonly kind = "app";

  constructor(
    private readonly env: Pick<Env, "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY">,
    /** nest, whose grant still names the repos the app may act on (until its own installations do). */
    private readonly nest: Nest,
  ) {}

  private app(): AppCache {
    const appId = this.env.GITHUB_APP_ID?.trim() ?? "";
    const pem = this.env.GITHUB_APP_PRIVATE_KEY ?? "";
    if (!/^[1-9][0-9]{0,15}$/.test(appId) || !pem.includes("PRIVATE KEY")) {
      // Not a refusal: retried, as an outage is, while the operator sets the secrets (or GITHUB_TOKEN_SOURCE=nest).
      throw new GitHubError(503, "the App's secrets GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY aren't set", false);
    }
    if (!cache || cache.appId !== appId || cache.pem !== pem) {
      cache = { appId, pem, key: null, jwt: null, slug: null, installations: new Map(), tokens: new Map() };
    }
    return cache;
  }

  private async jwt(app: AppCache): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (app.jwt && app.jwt.exp_s - now > JWT_SLACK_S) return app.jwt.value;
    app.key ??= importAppKey(app.pem);
    let key: CryptoKey;
    try {
      key = await app.key;
    } catch {
      app.key = null;
      throw new GitHubError(503, "GITHUB_APP_PRIVATE_KEY isn't an RSA private key in PEM", false);
    }
    const value = await appJwt(app.appId, key, now * 1000);
    app.jwt = { value, exp_s: now + JWT_LIFE_S };
    return value;
  }

  /** One call with the App's JWT. GitHub refusing the JWT is the App's secrets' trouble: retried, not a refusal. */
  private async withJwt<T>(app: AppCache, method: string, path: string, body?: unknown, o: { nullOn404?: boolean } = {}): Promise<T | null> {
    try {
      return await new GitHub(await this.jwt(app)).call<T>(method, path, body, o);
    } catch (e) {
      if (e instanceof GitHubError && e.status === 401) {
        app.jwt = null;
        throw new GitHubError(503, "GitHub refused the App's JWT: check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY", false);
      }
      throw e;
    }
  }

  private dropInstallation(app: AppCache, id: number): void {
    app.tokens.delete(id);
    for (const [repo, i] of app.installations) if (i.id === id) app.installations.delete(repo);
  }

  /**
   * The App's installation on `repo` (`GET /repos/{o}/{r}/installation`), from the cache unless it's older than
   * INSTALLATION_LOOKUP_MS or `fresh`. One that changed drops every token of the one before.
   */
  async installation(repo: string, fresh = false): Promise<number> {
    const app = this.app();
    const k = repo.toLowerCase();
    const had = app.installations.get(k);
    if (had && !fresh && Date.now() - had.at_ms < INSTALLATION_LOOKUP_MS) return had.id;
    const r = await this.withJwt<{ id?: unknown }>(app, "GET", `/repos/${repo}/installation`, undefined, { nullOn404: true });
    if (r === null) {
      if (had) this.dropInstallation(app, had.id);
      app.installations.delete(k);
      throw new GitHubError(404, `the App isn't installed on ${repo}`, false);
    }
    const id = positiveId(r.id);
    if (id === null) throw new GitHubError(502, `GitHub's answer for ${repo}'s installation names none`, false);
    if (had && had.id !== id) this.dropInstallation(app, had.id);
    app.installations.set(k, { id, at_ms: Date.now() });
    return id;
  }

  async token(repo: string, permissions: Record<string, string>, o: { fresh?: boolean } = {}): Promise<Minted> {
    const app = this.app();
    const appId = Number(app.appId);
    const k = repo.toLowerCase();
    const installation = await this.installation(repo, o.fresh === true);
    const key = `${k}|${permissionsKey(permissions)}`;
    const stale = () => {
      app.tokens.get(installation)?.delete(key);
      if (app.installations.get(k)?.id === installation) app.installations.delete(k);
    };
    // nest's grant still bounds the app's GitHub calls (README.md#github-tokens): the repo, and each permission
    // within its `github.permissions`. Checked before each mint and each binding's read, and refused as nest
    // refused a token outside it.
    const covered = async () => {
      const [repoIn, self] = await Promise.all([githubCovers(this.nest, repo), this.nest.self()]);
      if (!repoIn) throw new NestError(403, "forbidden", `nest's grant for the app doesn't cover ${repo}`, false);
      const have = self.grant?.github?.permissions ?? {};
      for (const [p, level] of Object.entries(permissions)) {
        if (!levelWithin(level, have[p])) throw new NestError(403, "forbidden", `${p}: ${level} is outside nest's grant for the app`, false);
      }
    };
    if (o.fresh) await covered();
    const have = app.tokens.get(installation)?.get(key);
    if (have && have.expires_ms - Date.now() > TOKEN_REUSE_MS) return { token: have.token, appId, installationId: installation, stale };
    if (!o.fresh) await covered();
    let r: { token?: unknown; expires_at?: unknown } | null;
    try {
      // One repo (by name: an installation is one account's) and these permissions only.
      r = await this.withJwt(app, "POST", `/app/installations/${installation}/access_tokens`, { repositories: [repo.split("/")[1]], permissions });
    } catch (e) {
      // The installation is gone (uninstalled, or reinstalled under another id): looked up again next time.
      if (e instanceof GitHubError && e.status === 404) this.dropInstallation(app, installation);
      throw e;
    }
    const expires = typeof r?.expires_at === "string" ? Date.parse(r.expires_at) : NaN;
    if (typeof r?.token !== "string" || !r.token || !Number.isFinite(expires)) throw new GitHubError(502, "GitHub's answer names no installation token", false);
    // Stored only while the repo's lookup still answers this installation (another may have replaced it meanwhile).
    if (app.installations.get(k)?.id === installation) {
      if (!app.tokens.has(installation)) app.tokens.set(installation, new Map());
      app.tokens.get(installation)!.set(key, { token: r.token, expires_ms: expires });
    }
    return { token: r.token, appId, installationId: installation, stale };
  }

  async appSlug(): Promise<string | null> {
    const app = this.app();
    if (app.slug) return app.slug;
    const r = await this.withJwt<{ slug?: unknown }>(app, "GET", "/app");
    app.slug = typeof r?.slug === "string" && r.slug ? r.slug : null;
    return app.slug;
  }
}

/** nest's tokens (`POST /v1/clients/self/github-token`): the fallback for one release. nest caches them. */
export class NestTokens implements TokenSource {
  readonly kind = "nest";

  constructor(private readonly nest: Nest) {}

  async token(repo: string, permissions: Record<string, string>): Promise<Minted> {
    const t = await this.nest.githubToken(repo, permissions);
    return { token: t.token, appId: positiveId(t.app_id), installationId: positiveId(t.installation_id), stale: () => {} };
  }

  async appSlug(repo: string): Promise<string | null> {
    const t = await this.nest.githubToken(repo, { metadata: "read" });
    return typeof t.app_slug === "string" ? t.app_slug : null;
  }
}

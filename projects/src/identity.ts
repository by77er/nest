// The caller of the MCP servers (docs/interfaces/remote-mcp/#nest-identity): every request carries a
// `Nest-Identity` JWT, EdDSA (Ed25519), signed by nest with a key from `GET <iss>/.well-known/jwks.json`.
// It is the only credential the servers accept (README.md#the-mcp-server-agents-see-only-their-own-work).
// WebCrypto only: no JWT library.

import { ROLE_OF, type Role, type Server } from "./tools";

/** An agent this app created, calling a server for its role. */
export interface AgentCaller {
  kind: "agent";
  agent: string;
  role: Role;
  labels: Record<string, string>;
  tainted: boolean;
}
/** nest's connector listing the server's tools for every agent on it: it may list, never call. */
export interface ConnectorCaller {
  kind: "connector";
}
export type Caller = AgentCaller | ConnectorCaller;

export type Verdict = { ok: true; caller: Caller } | { ok: false; status: 401 | 403; reason: string };

export interface IdentityConfig {
  /** nest's base URL: the token's `iss`, and where its keys are. */
  issuer: string;
  /** The URL the token must be for (`aud`): this server's, exactly as the catalog names it. */
  audience: string;
  /** The server called, which fixes the role the caller must have. */
  server: Server;
  /** The app's own client id: the token's `client` and `owner` must both be it. */
  client: string;
}

/** How long fetched keys are used before fetching again (nest serves them with max-age=300). */
const KEYS_TTL_MS = 5 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often, so junk tokens can't drive fetches. */
export const REFETCH_MIN_MS = 2 * 60 * 1000;
/** Clock skew allowed on `iat`. */
const SKEW_S = 60;

let cache: { url: string; fetched: number; keys: Map<string, CryptoKey> } | null = null;

/** Forget the cached keys (tests). */
export function resetIdentityKeys(): void {
  cache = null;
}

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
}

async function fetchKeys(url: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`nest's keys: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") continue;
    try {
      keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: k.x }, { name: "Ed25519" }, false, ["verify"]));
    } catch {
      // a malformed key is skipped, not fatal for the others
    }
  }
  return keys;
}

async function keyFor(issuer: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  const url = `${issuer}/.well-known/jwks.json`;
  const same = cache !== null && cache.url === url;
  const fresh = same && now - cache!.fetched < KEYS_TTL_MS;
  const mayRefetch = !same || now - cache!.fetched >= REFETCH_MIN_MS;
  if (!fresh || (!cache!.keys.has(kid) && mayRefetch)) {
    cache = { url, fetched: now, keys: await fetchKeys(url) };
  }
  return cache!.keys.get(kid);
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

const refuse = (status: 401 | 403, reason: string): Verdict => ({ ok: false, status, reason });

/**
 * Who is calling, if the token proves it; otherwise 401 (no valid token: signature, `iss`, `aud`,
 * `exp`) or 403 (a valid token for a caller this server doesn't serve: another client's agent, an agent
 * an agent spawned, or another role). Throws only when nest's keys can't be fetched.
 */
export async function verifyIdentity(token: string | null, config: IdentityConfig, now = Date.now()): Promise<Verdict> {
  if (!token) return refuse(401, "no Nest-Identity");
  const parts = token.split(".");
  if (parts.length !== 3) return refuse(401, "not a JWS");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = b64urlJson(h) as typeof header;
    claims = b64urlJson(p) as Record<string, unknown>;
    signature = b64urlBytes(s);
  } catch {
    return refuse(401, "malformed");
  }
  if (typeof header !== "object" || header === null || typeof claims !== "object" || claims === null) return refuse(401, "malformed");
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") return refuse(401, "not EdDSA with a kid");
  const key = await keyFor(config.issuer, header.kid, now);
  if (!key) return refuse(401, "unknown kid");
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, signature, new TextEncoder().encode(`${h}.${p}`)))) return refuse(401, "bad signature");
  const nowS = now / 1000;
  if (claims.iss !== config.issuer) return refuse(401, "wrong iss");
  if (claims.aud !== config.audience) return refuse(401, "wrong aud");
  if (typeof claims.exp !== "number" || claims.exp <= nowS) return refuse(401, "expired");
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > nowS + SKEW_S)) return refuse(401, "issued in the future");

  if (claims.sub === "nest:connector") return { ok: true, caller: { kind: "connector" } };
  if (typeof claims.sub !== "string" || !/^agt_[A-Za-z0-9]+$/.test(claims.sub)) return refuse(403, "not an agent");
  // Only agents the app created itself: a spawned agent's labels are its spawner's choice (owner agt_…).
  if (claims.client !== config.client) return refuse(403, "another client's agent");
  if (claims.owner !== config.client) return refuse(403, "not created by this app");
  const labels = claims.labels;
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return refuse(403, "no labels");
  const l = labels as Record<string, unknown>;
  const role = ROLE_OF[config.server];
  if (l.role !== role) return refuse(403, `not a ${role}`);
  if (typeof l.project !== "string") return refuse(403, "no project");
  if (role === "worker" && typeof l.task !== "string") return refuse(403, "no task");
  if (role === "reviewer" && (typeof l.pr !== "string" || typeof l.sha !== "string")) return refuse(403, "no pr and sha");
  const strings = Object.fromEntries(Object.entries(l).filter((e): e is [string, string] => typeof e[1] === "string"));
  return { ok: true, caller: { kind: "agent", agent: claims.sub, role, labels: strings, tainted: claims.tainted === true } };
}

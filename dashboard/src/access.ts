// Verifies the token Cloudflare Access puts on every request it lets through
// (`Cf-Access-Jwt-Assertion`), so the Worker does not depend on Access being in front of every path
// to it: a request without a valid token for this application is refused. RS256 against the team's
// published keys, with WebCrypto only.
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/

export interface AccessConfig {
  /** The team's domain, e.g. `https://bitcrush.cloudflareaccess.com`: the token's `iss`, and where its keys are. */
  teamDomain: string;
  /** The application's audience tag: the token's `aud` must contain it. */
  aud: string;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

/** How long fetched keys are trusted before they are fetched again; an unknown `kid` refetches sooner. */
const KEYS_TTL_MS = 60 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often, so junk tokens cannot drive fetches. */
const REFETCH_MIN_MS = 30 * 1000;

let cache: { url: string; fetched: number; keys: Map<string, CryptoKey> } | null = null;

/** Forget the cached keys (tests). */
export function resetAccessKeys(): void {
  cache = null;
}

async function fetchKeys(url: string): Promise<Map<string, CryptoKey>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Access keys: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    const { kid, ...material } = jwk;
    keys.set(kid, await crypto.subtle.importKey("jwk", material, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  return keys;
}

async function keyFor(teamDomain: string, kid: string, now: number): Promise<CryptoKey | undefined> {
  const url = `${teamDomain}/cdn-cgi/access/certs`;
  const fresh = cache && cache.url === url && now - cache.fetched < KEYS_TTL_MS;
  const canRefetch = !cache || cache.url !== url || now - cache.fetched >= REFETCH_MIN_MS;
  if (!fresh || (!cache!.keys.has(kid) && canRefetch)) {
    cache = { url, fetched: now, keys: await fetchKeys(url) };
  }
  return cache!.keys.get(kid);
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlJson = (s: string): unknown => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/**
 * The token's claims when it is a valid Access token for this application (signed by one of the
 * team's keys with RS256, issued by the team, for `aud`, not expired, already valid); otherwise
 * `null`. Never throws on a bad token; throws only when the team's keys cannot be fetched.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig, now = Date.now()): Promise<Record<string, unknown> | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];
  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(h) as typeof header;
    claims = b64urlJson(p) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || typeof claims !== "object" || claims === null) return null;
  const key = await keyFor(config.teamDomain, header.kid, now);
  if (!key) return null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = b64urlBytes(sig);
  } catch {
    return null;
  }
  const signed = new TextEncoder().encode(`${h}.${p}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed))) return null;
  const nowS = now / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.teamDomain) return null;
  if (!aud.includes(config.aud)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= nowS) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > nowS + 60)) return null;
  return claims;
}

// A verifier of nest's caller identity (`Nest-Identity`) written as an MCP server would write one, from
// the spec (docs/control-plane/api/clients/#caller-identity-for-mcp-servers, RFC 7515, RFC 8037) and
// WebCrypto, not from src/lib/identity.ts: it is the oracle the identity tests check nest against.
import { SELF } from "cloudflare:test";
import { BASE } from "./helpers";

export interface Jwk { kty: string; crv: string; x: string; kid: string; alg?: string; use?: string }
export type Verified = { ok: true; claims: Record<string, any>; kid: string } | { ok: false; why: string };

const dec = new TextDecoder();
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** The JWKS as a verifier fetches it (unauthenticated). */
export async function fetchJwks(): Promise<{ keys: Jwk[]; cacheControl: string | null; status: number }> {
  const res = await SELF.fetch(`${BASE}/.well-known/jwks.json`);
  const body = (await res.json()) as { keys: Jwk[] };
  return { keys: body.keys, cacheControl: res.headers.get("cache-control"), status: res.status };
}

/** RFC 7638 §3.2: the thumbprint of an OKP key hashes `{"crv","kty","x"}`, members in that order, no spaces. */
export async function thumbprint(k: Jwk): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`{"crv":"${k.crv}","kty":"${k.kty}","x":"${k.x}"}`)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verify `token` for the server at `aud`: compact JWS, `alg` EdDSA, a `kid` the JWKS lists, a good
 * Ed25519 signature, `aud` this server, `iss` the expected issuer, and `iat <= now < exp`.
 */
export async function verifyIdentity(token: string | undefined, o: { aud: string; keys: Jwk[]; iss?: string; nowS?: number }): Promise<Verified> {
  if (!token) return { ok: false, why: "no token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, why: "not a compact JWS" };
  let header: { alg?: string; kid?: string };
  let claims: Record<string, any>;
  try {
    header = JSON.parse(dec.decode(unb64url(parts[0]!)));
    claims = JSON.parse(dec.decode(unb64url(parts[1]!)));
  } catch {
    return { ok: false, why: "unparseable" };
  }
  if (header.alg !== "EdDSA") return { ok: false, why: `alg ${header.alg}` };
  const jwk = o.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, why: `unknown kid ${header.kid}` };
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, { name: "Ed25519" }, false, ["verify"]);
  const good = await crypto.subtle.verify({ name: "Ed25519" }, key, unb64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!good) return { ok: false, why: "bad signature" };
  if (claims.aud !== o.aud) return { ok: false, why: `aud ${claims.aud}` };
  if (claims.iss !== (o.iss ?? "https://nest.test")) return { ok: false, why: `iss ${claims.iss}` };
  const now = o.nowS ?? Math.floor(Date.now() / 1000);
  if (!(typeof claims.exp === "number" && now < claims.exp)) return { ok: false, why: "expired" };
  if (!(typeof claims.iat === "number" && claims.iat <= now + 5)) return { ok: false, why: "issued in the future" };
  return { ok: true, claims, kid: header.kid! };
}

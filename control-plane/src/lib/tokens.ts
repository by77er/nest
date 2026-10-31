// Host bearer tokens (`nht_<payload>.<sig>`, HMAC-SHA256), signed blob URLs and share-link signatures.
import { HostRole } from "../protocol/model";
import { b64url, b64urlToBytes, NestError, timingSafeEqual } from "./util";
import { ErrorCodes } from "../protocol/model";

export interface HostClaims {
  host: string;
  cell: string;
  role: HostRole;
  /** Expiry, ms since epoch. */
  exp: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function mac(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

export async function issueHostToken(secret: string, claims: HostClaims): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return `nht_${payload}.${b64url(await mac(secret, payload))}`;
}

/**
 * Verify a host token. `graceMs` accepts a token that expired less than that long ago (only the fleet
 * channel does this, so a host that was disconnected past expiry can reconnect and get a fresh token).
 */
export async function verifyHostToken(secret: string, token: string, nowMs = Date.now(), graceMs = 0): Promise<HostClaims> {
  const unauthorized = (why: string) => new NestError(ErrorCodes.UNAUTHORIZED, why, 401);
  if (!token.startsWith("nht_")) throw unauthorized("malformed host token");
  const [payload, sig] = token.slice(4).split(".");
  if (!payload || !sig) throw unauthorized("malformed host token");
  let sigBytes: Uint8Array;
  let claims: HostClaims;
  try {
    sigBytes = b64urlToBytes(sig);
    claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as HostClaims;
  } catch {
    throw unauthorized("malformed host token");
  }
  if (!timingSafeEqual(await mac(secret, payload), sigBytes)) throw unauthorized("bad host token signature");
  if (typeof claims.exp !== "number" || claims.exp + graceMs <= nowMs) throw unauthorized("host token expired");
  return claims;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m ? m[1]!.trim() : null;
}

/** Worker-signed blob URLs (instead of R2 presigned URLs): `<base>/v1/blobs/<key>?exp=..&sig=..`, HMAC over key and expiry. */
export async function signBlobUrl(secret: string, baseUrl: string, key: string, expMs: number): Promise<string> {
  const sig = b64url(await mac(secret, `blob\n${key}\n${expMs}`));
  return `${baseUrl.replace(/\/$/, "")}/v1/blobs/${key.split("/").map(encodeURIComponent).join("/")}?exp=${expMs}&sig=${sig}`;
}

/**
 * A share link's signature: HMAC over `{sandbox, port}` and the expiry, carried as `?exp=..&sig=..`.
 * Minted only; nothing serves or verifies share links yet (docs/sandbox/networking/ingress/).
 */
export async function signShare(secret: string, sandbox: string, port: number, expMs: number): Promise<string> {
  return `exp=${expMs}&sig=${b64url(await mac(secret, `share\n${sandbox}\n${port}\n${expMs}`))}`;
}

export async function verifyBlobUrl(secret: string, key: string, exp: string | null, sig: string | null, nowMs = Date.now()) {
  const expMs = Number(exp);
  if (!sig || !Number.isFinite(expMs) || expMs <= nowMs) return false;
  try {
    return timingSafeEqual(await mac(secret, `blob\n${key}\n${expMs}`), b64urlToBytes(sig));
  } catch {
    return false;
  }
}

// Caller identity for MCP servers (docs/control-plane/api/clients/#caller-identity-for-mcp-servers):
// every request nest's MCP client sends a remote server carries `Nest-Identity: <JWT>`, an EdDSA
// (Ed25519) JWT the control plane signs, which the server verifies against `GET /.well-known/jwks.json`.
//
// - The keys and their schedule (`keyPlan`, pure) are BrokerDO's; private keys never leave it.
// - The JWT encoding (`signJwt`) and the key material (`generateIdentityKey`) are here.
// - `IdentityTokens` is the per-caller cache (AgentDO's proxy, the connector): a token is reused for
//   most of its 5-minute life, so a call costs no BrokerDO round trip.
import { z } from "zod";
import { canonicalJson } from "./sinks";
import { b64url, sha256 } from "./util";

/** The request header (HTTP headers are case-insensitive; sent lowercase). */
export const IDENTITY_HEADER = "nest-identity";
/** A token is valid this long (`exp - iat`). */
export const IDENTITY_TTL_MS = 5 * 60_000;
/** A cached token is reused while it has more than this left (so for its first 4 minutes). */
export const IDENTITY_REUSE_MARGIN_MS = 60_000;
const DAY_MS = 24 * 3_600_000;
/** A key signs this long, then the next one takes over. */
export const IDENTITY_KEY_SIGNS_MS = 30 * DAY_MS;
/** The next key is published at least this long before it signs. */
export const IDENTITY_KEY_AHEAD_MS = DAY_MS;
/** A retired key stays published this long after it stopped signing (a token lives 5 minutes). */
export const IDENTITY_KEY_RETAIN_MS = DAY_MS;
/** How long a verifier may cache the JWKS (`Cache-Control: max-age`), in seconds. */
export const JWKS_MAX_AGE_S = 300;
/** `sub` of the connector's own listing session (do/mcp-connector.ts): not an agent. */
export const CONNECTOR_SUBJECT = "nest:connector";

/** The algorithm, as WebCrypto names it and as the JWT header and JWK name it (RFC 8037). */
const ED25519 = { name: "Ed25519" } as const;
const JWT_ALG = "EdDSA";

const Labels = z.record(z.string().max(63), z.string().max(256));

/**
 * What a caller asks BrokerDO to sign: everything but `iss`, `iat` and `exp`, which BrokerDO sets (so
 * a token's issuer and lifetime are decided in one place). Strict: no other claim gets in.
 */
export const IdentitySubject = z.object({
  /** The server's URL. */
  aud: z.string().url().max(2048),
  /** The calling agent's id, or `CONNECTOR_SUBJECT`. */
  sub: z.string().min(1).max(128),
  owner: z.string().min(1).max(128).optional(),
  client: z.string().min(1).max(128).optional(),
  labels: Labels.optional(),
  epoch: z.number().int().min(0).optional(),
  tainted: z.boolean().optional(),
}).strict();
export type IdentitySubject = z.output<typeof IdentitySubject>;

/** The token's claims: the subject plus `iss` (the Worker's public base URL), `iat` and `exp` (seconds). */
export type IdentityClaims = IdentitySubject & { iss: string; iat: number; exp: number };

/** A public key as the JWKS lists it (RFC 8037 §2). */
export interface IdentityJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: typeof JWT_ALG;
  use: "sig";
}

export interface IdentityKeyPair {
  kid: string;
  public_jwk: IdentityJwk;
  private_jwk: JsonWebKey;
}

// --- Keys --------------------------------------------------------------------------------------------------

/** The RFC 7638 thumbprint of an Ed25519 public key: base64url SHA-256 of `{"crv","kty","x"}` in that order. */
export async function jwkThumbprint(x: string): Promise<string> {
  return b64url(await sha256(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })));
}

/** A new key pair; `kid` is the public key's thumbprint. */
export async function generateIdentityKey(): Promise<IdentityKeyPair> {
  const pair = (await crypto.subtle.generateKey(ED25519, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (typeof pub.x !== "string") throw new Error("Ed25519 export gave no x");
  const kid = await jwkThumbprint(pub.x);
  return { kid, public_jwk: { kty: "OKP", crv: "Ed25519", x: pub.x, kid, alg: JWT_ALG, use: "sig" }, private_jwk: priv };
}

export function importIdentitySigner(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ED25519, false, ["sign"]);
}

/** A stored key's times, as `keyPlan` reads them. */
export interface KeyTimes {
  kid: string;
  /** When it starts (or started) signing. */
  signs_from_ms: number;
}

/** What the keys should be at `now`. */
export interface KeyPlan {
  /** The key that signs now: the latest one whose `signs_from_ms` has come. Null only before the first key. */
  signer: string | null;
  /** What the JWKS lists: the signer, the next key (published before it signs), and keys retired less than `IDENTITY_KEY_RETAIN_MS` ago. */
  published: string[];
  /** Keys retired longer ago than that: deleted. */
  drop: string[];
  /**
   * A key to generate now, and when it starts signing; null when none is due. The first key signs at
   * once (nobody can hold a token yet); every later one at least `IDENTITY_KEY_AHEAD_MS` after it is
   * published, even when nothing ran in the day before the current key's period ended (it then signs on).
   */
  next_signs_from_ms: number | null;
}

/** The key schedule (pure): which key signs, which are published, which go, and whether a next key is due. */
export function keyPlan(keys: readonly KeyTimes[], now: number): KeyPlan {
  const sorted = [...keys].sort((a, b) => a.signs_from_ms - b.signs_from_ms || a.kid.localeCompare(b.kid));
  const started = sorted.filter((k) => k.signs_from_ms <= now);
  const pending = sorted.filter((k) => k.signs_from_ms > now);
  const signer = started.at(-1) ?? null;
  const published: string[] = [];
  const drop: string[] = [];
  if (signer) published.push(signer.kid);
  published.push(...pending.map((k) => k.kid));
  // A key retired when the one after it started signing.
  for (let i = started.length - 2; i >= 0; i--) {
    const retiredAt = started[i + 1]!.signs_from_ms;
    (now - retiredAt < IDENTITY_KEY_RETAIN_MS ? published : drop).push(started[i]!.kid);
  }
  let next: number | null = null;
  if (!signer && pending.length === 0) next = now;
  else if (signer && pending.length === 0 && now >= signer.signs_from_ms + IDENTITY_KEY_SIGNS_MS - IDENTITY_KEY_AHEAD_MS) {
    next = Math.max(signer.signs_from_ms + IDENTITY_KEY_SIGNS_MS, now + IDENTITY_KEY_AHEAD_MS);
  }
  return { signer: signer?.kid ?? null, published, drop, next_signs_from_ms: next };
}

// --- The JWT -------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const segment = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

/** A compact JWS (RFC 7515) of `claims`, signed with Ed25519 under `kid`. */
export async function signJwt(key: CryptoKey, kid: string, claims: IdentityClaims): Promise<string> {
  const input = `${segment({ alg: JWT_ALG, typ: "JWT", kid })}.${segment(claims)}`;
  const sig = new Uint8Array(await crypto.subtle.sign(ED25519, key, enc.encode(input)));
  return `${input}.${b64url(sig)}`;
}

// --- The caller's cache ------------------------------------------------------------------------------------------

/** A signed token and when it expires (epoch ms). */
export interface SignedIdentity {
  token: string;
  exp_ms: number;
}

/**
 * Tokens by subject, in memory (an eviction just signs again). A token is reused while it has more
 * than `IDENTITY_REUSE_MARGIN_MS` left; any change in the subject (another audience, epoch, taint,
 * labels) is another entry, so a token never outlives the state it names.
 */
export class IdentityTokens {
  private readonly tokens = new Map<string, SignedIdentity>();
  private readonly signing = new Map<string, Promise<void>>();

  constructor(private readonly sign: (s: IdentitySubject) => Promise<SignedIdentity>, private readonly now: () => number = Date.now) {}

  /** The cached token for `s` that may still be sent, or null (synchronous: read as a request leaves). */
  current(s: IdentitySubject): string | null {
    const t = this.tokens.get(canonicalJson(s));
    return t && t.exp_ms - this.now() > IDENTITY_REUSE_MARGIN_MS ? t.token : null;
  }

  /** Make sure `current(s)` has a token: signs (one request per subject at a time) when it hasn't. */
  async ensure(s: IdentitySubject): Promise<void> {
    if (this.current(s)) return;
    const key = canonicalJson(s);
    let p = this.signing.get(key);
    if (!p) {
      p = this.sign(s).then((t) => {
        this.prune();
        this.tokens.set(key, t);
      }).finally(() => this.signing.delete(key));
      this.signing.set(key, p);
    }
    await p;
  }

  /** `ensure`, then `current`: for a subject that can't change across the await (the connector's). */
  async token(s: IdentitySubject): Promise<string> {
    await this.ensure(s);
    const t = this.current(s);
    if (!t) throw new Error("a freshly signed caller identity is already expiring (clock skew?)");
    return t;
  }

  private prune(): void {
    const now = this.now();
    for (const [k, t] of this.tokens) if (t.exp_ms - now <= IDENTITY_REUSE_MARGIN_MS) this.tokens.delete(k);
  }
}

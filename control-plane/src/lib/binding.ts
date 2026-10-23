// Binding tokens (docs/interfaces/gateway/): `nbd_<base64url(claims JSON)>.<base64url(signature)>`,
// ECDSA P-256 / SHA-256 over `nest-binding-v1:` + the claims segment, fixed-size r‖s signature.
// The signer lives in BrokerDO; the gateway on each sandbox host verifies with the public key.
import { BINDING_PREFIX, BINDING_SIGN_DOMAIN, BINDING_VERSION, BindingClaims, type BindingKey } from "../protocol/gateway";
import { b64url, b64urlToBytes, hex, sha256 } from "./util";

const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
const enc = new TextEncoder();

export type BindingKeyPair = { kid: string; publicKey: Uint8Array; privateJwk: JsonWebKey };

/** The raw uncompressed SEC1 point (65 bytes) of a public key. */
export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer);
}

export async function kidOf(publicKey: Uint8Array): Promise<string> {
  return hex(await sha256(publicKey)).slice(0, 16);
}

export async function generateBindingKey(): Promise<BindingKeyPair> {
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = await exportPublicKey(pair.publicKey);
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  return { kid: await kidOf(publicKey), publicKey, privateJwk };
}

export async function importPrivateJwk(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ALG, false, ["sign"]);
}

export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, ALG, false, ["verify"]);
}

export function toBindingKey(pair: BindingKeyPair): BindingKey {
  return { kid: pair.kid, public_key: b64url(pair.publicKey) };
}

export function signingMessage(claimsB64: string): Uint8Array {
  return enc.encode(BINDING_SIGN_DOMAIN + claimsB64);
}

/** Serialize and sign claims; the claims JSON is embedded exactly as signed. */
export async function signBinding(privateKey: CryptoKey, claims: BindingClaims): Promise<string> {
  const claimsB64 = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, signingMessage(claimsB64)));
  return `${BINDING_PREFIX}${claimsB64}.${b64url(sig)}`;
}

export type ParsedBinding = { claims: BindingClaims; message: Uint8Array; signature: Uint8Array };

/** Split a token; nothing is verified here. Throws on a malformed token. */
export function parseBinding(token: string): ParsedBinding {
  if (!token.startsWith(BINDING_PREFIX)) throw new Error("binding prefix");
  const rest = token.slice(BINDING_PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0 || dot === rest.length - 1 || rest.indexOf(".", dot + 1) !== -1) throw new Error("binding shape");
  const claimsB64 = rest.slice(0, dot);
  const claims = BindingClaims.parse(JSON.parse(new TextDecoder().decode(b64urlToBytes(claimsB64))));
  if (claims.v !== BINDING_VERSION) throw new Error(`binding claims version ${claims.v}`);
  return { claims, message: signingMessage(claimsB64), signature: b64urlToBytes(rest.slice(dot + 1)) };
}

/** Verify a token against a raw public key; the claims only if the signature holds. */
export async function verifyBinding(publicKey: Uint8Array, token: string): Promise<BindingClaims | null> {
  let parsed: ParsedBinding;
  try {
    parsed = parseBinding(token);
  } catch {
    return null;
  }
  const key = await importPublicKey(publicKey);
  const ok = await crypto.subtle.verify(SIGN, key, parsed.signature, parsed.message);
  return ok ? parsed.claims : null;
}

// AWS KMS for the proxy root CA: the private key never leaves KMS. FleetDO asks KMS to sign each
// intermediate's to-be-signed bytes (docs/sandbox/networking/egress/tls/).
import { AwsApi, type AwsOptions } from "./aws";

export interface Kms {
  /** ECDSA_SHA_256 over the SHA-256 of `message`; returns the DER signature KMS produces. */
  sign(keyId: string, message: Uint8Array): Promise<Uint8Array>;
  /** The key's public key as DER SubjectPublicKeyInfo. */
  publicKey(keyId: string): Promise<Uint8Array>;
}

export class AwsKms implements Kms {
  private readonly api: AwsApi;

  constructor(accessKeyId: string, secretAccessKey: string, region: string, opts?: AwsOptions) {
    this.api = new AwsApi("kms", accessKeyId, secretAccessKey, region, opts);
  }

  private async call<T>(target: string, body: unknown): Promise<T> {
    const res = await this.api.json(`TrentService.${target}`, body);
    if (!res.ok) throw new Error(`KMS ${target} failed: ${res.status} ${res.text.slice(0, 300)}`);
    return JSON.parse(res.text) as T;
  }

  async sign(keyId: string, message: Uint8Array): Promise<Uint8Array> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
    const r = await this.call<{ Signature: string }>("Sign", {
      KeyId: keyId, Message: b64(digest), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256",
    });
    return unb64(r.Signature);
  }

  async publicKey(keyId: string): Promise<Uint8Array> {
    const r = await this.call<{ PublicKey: string; KeySpec?: string }>("GetPublicKey", { KeyId: keyId });
    if (r.KeySpec && r.KeySpec !== "ECC_NIST_P256") throw new Error(`KMS key ${keyId} is ${r.KeySpec}, not ECC_NIST_P256`);
    return unb64(r.PublicKey);
  }
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * A DER `ECDSA-Sig-Value` (SEQUENCE { r INTEGER, s INTEGER }) as WebCrypto's raw form: r and s,
 * each left-padded to 32 bytes (P-256).
 */
export function derToRawEcdsa(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const fail = () => new Error("malformed ECDSA signature");
  const len = (): number => {
    const b = der[i++]!;
    if (b < 0x80) return b;
    const n = b & 0x7f;
    if (n < 1 || n > 2) throw fail();
    let v = 0;
    for (let k = 0; k < n; k++) v = (v << 8) | der[i++]!;
    return v;
  };
  if (der[i++] !== 0x30) throw fail();
  const seqEnd = len() + i;
  if (seqEnd !== der.length) throw fail();
  const out = new Uint8Array(size * 2);
  for (const at of [0, size]) {
    if (der[i++] !== 0x02) throw fail();
    const n = len();
    let v = der.subarray(i, i + n);
    i += n;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw fail();
    out.set(v, at + size - v.length);
  }
  if (i !== der.length) throw fail();
  return out;
}

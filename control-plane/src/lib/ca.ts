// Signs nest-proxy's per-host intermediate CA from a CSR with the root CA: its key is in AWS KMS in
// production (never exported) or a PKCS#8 key for development.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { CaCertificate } from "../protocol/control";
import { ErrorCodes } from "../protocol/model";
import { derToRawEcdsa, type Kms } from "./kms";
import { NestError, pemToDer } from "./util";

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export interface RootCa {
  certPem: string;
  /** ECDSA P-256 / SHA-256 over the to-be-signed bytes, as WebCrypto's raw r‖s. */
  sign: (tbs: Uint8Array) => Promise<Uint8Array>;
}

/** A root whose key is a PKCS#8 PEM (development, and before KMS). */
export async function localRoot(certPem: string, keyPem: string): Promise<RootCa> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(keyPem), EC, false, ["sign"]);
  return { certPem, sign: async (tbs) => new Uint8Array(await crypto.subtle.sign(SIGN, key, tbs)) };
}

/** A root whose key is in KMS: only its certificate is here. */
export function kmsRoot(certPem: string, kms: Kms, keyId: string): RootCa {
  return { certPem, sign: async (tbs) => derToRawEcdsa(await kms.sign(keyId, tbs)) };
}

/**
 * @peculiar/x509 signs through WebCrypto with a CryptoKey. This gives it one whose signatures come
 * from `sign` instead: a placeholder key, recognized by identity, routed to the root's signer by a
 * `Crypto` passed to that one signing call (never set as the library's global provider, which a
 * concurrent signing would see across an await).
 */
async function signer(sign: RootCa["sign"]): Promise<{ key: CryptoKey; crypto: Crypto }> {
  const placeholder = ((await crypto.subtle.generateKey(EC, false, ["sign", "verify"])) as CryptoKeyPair).privateKey;
  const subtle = new Proxy(crypto.subtle, {
    get(target, prop) {
      if (prop === "sign") {
        return async (...[alg, key, data]: Parameters<SubtleCrypto["sign"]>) =>
          key === placeholder ? (await sign(new Uint8Array(data as ArrayBuffer))).buffer : target.sign(alg, key, data);
      }
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { key: placeholder, crypto: { subtle, getRandomValues: crypto.getRandomValues.bind(crypto), randomUUID: crypto.randomUUID.bind(crypto) } as Crypto };
}

/** A P-256 SubjectPublicKeyInfo re-encoded through WebCrypto, so two encodings of one key compare equal. */
export async function canonicalSpki(spki: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("spki", spki, EC, true, ["verify"]);
  return new Uint8Array((await crypto.subtle.exportKey("spki", key)) as ArrayBuffer);
}

/** The certificate's public key, as canonical DER SubjectPublicKeyInfo. */
export async function certificateSpki(certPem: string): Promise<Uint8Array> {
  return canonicalSpki(new Uint8Array(new x509.X509Certificate(certPem).publicKey.rawData));
}

/** A self-signed root certificate for a key held elsewhere (KMS): its public key and signer. */
export async function createRootCertificate(publicKeySpki: Uint8Array, sign: RootCa["sign"], name: string, ttlMs: number, nowMs = Date.now()): Promise<string> {
  const publicKey = await crypto.subtle.importKey("spki", publicKeySpki, EC, true, ["verify"]);
  const root = await signer(sign);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: "01",
    subject: name,
    issuer: name,
    notBefore: new Date(nowMs - 60_000),
    notAfter: new Date(nowMs + ttlMs),
    signingAlgorithm: SIGN,
    publicKey,
    signingKey: root.key,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(publicKey),
    ],
  }, root.crypto);
  if (!(await cert.verify({ publicKey }))) throw new Error("the new root's self-signature does not verify");
  return cert.toString("pem") + "\n";
}

export async function signIntermediate(root: RootCa, csrPem: string, ttlMs: number, nowMs = Date.now()): Promise<CaCertificate> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "malformed CSR");
  }
  if (!(await csr.verify())) throw new NestError(ErrorCodes.INVALID_MESSAGE, "CSR signature does not verify");

  const rootCert = new x509.X509Certificate(root.certPem);
  const notBefore = new Date(nowMs - 5 * 60_000);
  const notAfter = new Date(nowMs + ttlMs);
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = serial[0]! & 0x7f;
  const rootSigner = await signer(root.sign);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: [...serial].map((b) => b.toString(16).padStart(2, "0")).join(""),
    subject: csr.subject,
    issuer: rootCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGN,
    publicKey: csr.publicKey,
    signingKey: rootSigner.key,
    extensions: [
      // Intermediate that may only sign leaves.
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(rootCert),
    ],
  }, rootSigner.crypto);
  // A wrong key (or a KMS key that isn't the root's) must never produce a chain that looks valid.
  if (!(await cert.verify({ publicKey: rootCert.publicKey }))) throw new NestError(ErrorCodes.INTERNAL, "intermediate does not verify against the root", 500);
  const certPem = cert.toString("pem") + "\n";
  return { cert_pem: certPem, chain_pem: certPem + rootCert.toString("pem") + "\n", expires_ms: notAfter.getTime() };
}

/** Development root (only when ALLOW_DEV_CA=1 and no root is configured): certificate and PKCS#8 key. */
export async function generateDevRoot(nowMs = Date.now()): Promise<{ certPem: string; keyPem: string }> {
  const keys = (await crypto.subtle.generateKey(EC, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=nest development root CA",
    notBefore: new Date(nowMs - 60_000),
    notAfter: new Date(nowMs + 10 * 365 * 86_400_000),
    signingAlgorithm: SIGN,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
    ],
  });
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", keys.privateKey)) as ArrayBuffer);
  let b = "";
  for (const x of pkcs8) b += String.fromCharCode(x);
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${btoa(b).replace(/.{64}/g, "$&\n")}\n-----END PRIVATE KEY-----\n`;
  return { certPem: cert.toString("pem") + "\n", keyPem };
}

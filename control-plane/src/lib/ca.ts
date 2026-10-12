// Signs nest-proxy's per-host intermediate CA from a CSR, with the root CA held by the control plane.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import type { CaCertificate } from "../protocol/control";
import { ErrorCodes } from "../protocol/model";
import { NestError, pemToDer } from "./util";

const EC = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

export interface RootCa {
  certPem: string;
  /** PKCS#8 PEM, ECDSA P-256. */
  keyPem: string;
}

export async function signIntermediate(root: RootCa, csrPem: string, ttlMs: number, nowMs = Date.now()): Promise<CaCertificate> {
  x509.cryptoProvider.set(crypto);
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "malformed CSR");
  }
  if (!(await csr.verify())) throw new NestError(ErrorCodes.INVALID_MESSAGE, "CSR signature does not verify");

  const rootCert = new x509.X509Certificate(root.certPem);
  const rootKey = await crypto.subtle.importKey("pkcs8", pemToDer(root.keyPem), EC, false, ["sign"]);
  const notBefore = new Date(nowMs - 5 * 60_000);
  const notAfter = new Date(nowMs + ttlMs);
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = serial[0]! & 0x7f;
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: [...serial].map((b) => b.toString(16).padStart(2, "0")).join(""),
    subject: csr.subject,
    issuer: rootCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: SIGN,
    publicKey: csr.publicKey,
    signingKey: rootKey,
    extensions: [
      // Intermediate that may only sign leaves.
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
      await x509.AuthorityKeyIdentifierExtension.create(rootCert),
    ],
  });
  const certPem = cert.toString("pem") + "\n";
  return { cert_pem: certPem, chain_pem: certPem + rootCert.toString("pem") + "\n", expires_ms: notAfter.getTime() };
}

/** Development root (only when ALLOW_DEV_CA=1 and no root is configured). */
export async function generateDevRoot(nowMs = Date.now()): Promise<RootCa> {
  x509.cryptoProvider.set(crypto);
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

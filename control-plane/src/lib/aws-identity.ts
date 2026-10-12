// Verification of the EC2 instance identity document's RSA-2048 PKCS#7 signature
// (IMDSv2 `/latest/dynamic/instance-identity/rsa2048`), using WebCrypto only.
import "reflect-metadata";
import { ContentInfo, id_signedData, SignedData } from "@peculiar/asn1-cms";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import * as x509 from "@peculiar/x509";
import { ErrorCodes } from "../protocol/model";
import { b64ToBytes, NestError, sha256, timingSafeEqual } from "./util";

export interface InstanceIdentity {
  instanceId: string;
  accountId: string;
  region: string;
}

/** Verifies an identity document + signature. Injectable so tests and other clouds can swap it. */
export interface IdentityVerifier {
  verify(documentB64: string, pkcs7B64: string): Promise<InstanceIdentity>;
}

const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA = "1.2.840.113549.1.1.1";
const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";

const bad = (why: string) => new NestError(ErrorCodes.UNAUTHORIZED, `identity document: ${why}`, 401);

function derSet(items: Uint8Array[]): Uint8Array {
  const len = items.reduce((n, i) => n + i.length, 0);
  const lenBytes: number[] = [];
  if (len < 0x80) lenBytes.push(len);
  else {
    for (let n = len; n > 0; n >>= 8) lenBytes.unshift(n & 0xff);
    lenBytes.unshift(0x80 | lenBytes.length);
  }
  const out = new Uint8Array(1 + lenBytes.length + len);
  out[0] = 0x31;
  out.set(lenBytes, 1);
  let o = 1 + lenBytes.length;
  for (const i of items) {
    out.set(i, o);
    o += i.length;
  }
  return out;
}

/** CMS SignedData with an RSA PKCS#1 v1.5 / SHA-256 signer, checked against one configured certificate. */
export class CmsRsaIdentityVerifier implements IdentityVerifier {
  constructor(private readonly certPem: string) {}

  async verify(documentB64: string, pkcs7B64: string): Promise<InstanceIdentity> {
    const document = b64ToBytes(documentB64);
    let pkcs7 = b64ToBytes(pkcs7B64.replace(/-----(BEGIN|END) [^-]+-----/g, "").replace(/\s+/g, ""));
    let signed: SignedData;
    try {
      const ci = AsnConvert.parse(pkcs7, ContentInfo);
      if (ci.contentType !== id_signedData) throw bad("not SignedData");
      signed = AsnConvert.parse(ci.content, SignedData);
    } catch (e) {
      if (e instanceof NestError) throw e;
      throw bad("malformed PKCS#7");
    }
    const signer = signed.signerInfos[0];
    if (!signer || signed.signerInfos.length !== 1) throw bad("expected exactly one signer");
    if (signer.digestAlgorithm.algorithm !== OID_SHA256) throw bad("digest must be SHA-256");
    if (![OID_RSA, OID_SHA256_RSA].includes(signer.signatureAlgorithm.algorithm)) throw bad("signature must be RSA");

    // The signed content is either embedded (rsa2048 form) or detached (then it's the document).
    const embedded = signed.encapContentInfo.eContent?.single?.buffer ?? signed.encapContentInfo.eContent?.any;
    const content = embedded ? new Uint8Array(embedded) : document;
    if (embedded && !timingSafeEqual(content, document)) throw bad("document does not match signed content");

    let signedBytes: Uint8Array;
    if (signer.signedAttrs?.length) {
      const md = signer.signedAttrs.find((a) => a.attrType === OID_MESSAGE_DIGEST);
      if (!md?.attrValues[0]) throw bad("missing messageDigest");
      const digest = new Uint8Array(AsnConvert.parse(md.attrValues[0], OctetString).buffer);
      if (!timingSafeEqual(digest, await sha256(content))) throw bad("messageDigest mismatch");
      // The signature covers the DER `SET OF Attribute` (tag 0x31), not the [0] IMPLICIT encoding in
      // SignerInfo. Attribute values are kept as raw DER, so re-encoding in parsed order is exact.
      signedBytes = derSet(signer.signedAttrs.map((a) => new Uint8Array(AsnConvert.serialize(a))));
    } else {
      signedBytes = content;
    }

    x509.cryptoProvider.set(crypto);
    const cert = new x509.X509Certificate(this.certPem);
    const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    const key = await cert.publicKey.export(alg, ["verify"]);
    const ok = await crypto.subtle.verify(alg, key, signer.signature.buffer, signedBytes);
    if (!ok) throw bad("signature does not verify");

    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(new TextDecoder().decode(document)) as Record<string, unknown>;
    } catch {
      throw bad("document is not JSON");
    }
    const { instanceId, accountId, region } = doc;
    if (typeof instanceId !== "string" || typeof accountId !== "string" || typeof region !== "string") {
      throw bad("document missing instanceId/accountId/region");
    }
    return { instanceId, accountId, region };
  }
}

import "reflect-metadata";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  Attribute, CMSVersion, ContentInfo, DigestAlgorithmIdentifiers, EncapsulatedContent, EncapsulatedContentInfo, id_data,
  id_signedData, IssuerAndSerialNumber, SignedData, SignerIdentifier, SignerInfo, SignerInfos,
} from "@peculiar/asn1-cms";
import { AlgorithmIdentifier } from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CmsRsaIdentityVerifier, octetStringContents } from "../src/lib/aws-identity";
import { verifyHostToken } from "../src/lib/tokens";
import { bytesToB64 } from "../src/lib/util";
import { BASE, adminJson, csrPem, enrollHost, hostHello, uniqueCell, Ws } from "./helpers";

const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

async function rsaCert(cn: string) {
  x509.cryptoProvider.set(crypto);
  const keys = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "0a", name: `CN=${cn}`, notBefore: new Date(Date.now() - 1000), notAfter: new Date(Date.now() + 86400e3),
    signingAlgorithm: RSA, keys,
  });
  return { keys, cert };
}

/** Build a CMS SignedData like the IMDS `rsa2048` endpoint returns: embedded content + signed attributes. */
async function signDocument(document: Uint8Array, keys: CryptoKeyPair, cert: x509.X509Certificate): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", document));
  const contentType = new Attribute({
    attrType: "1.2.840.113549.1.9.3",
    // OBJECT IDENTIFIER id-data (1.2.840.113549.1.7.1)
    attrValues: [new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]).buffer],
  });
  const messageDigest = new Attribute({
    attrType: "1.2.840.113549.1.9.4",
    attrValues: [AsnConvert.serialize(new OctetString(digest))],
  });
  const signedAttrs = [contentType, messageDigest];
  // DER of SET OF Attribute: encode each attribute and wrap (attributes are already in DER order here).
  const encoded = signedAttrs.map((a) => new Uint8Array(AsnConvert.serialize(a)));
  const inner = new Uint8Array(encoded.reduce((n, e) => n + e.length, 0));
  let o = 0;
  for (const e of encoded) {
    inner.set(e, o);
    o += e.length;
  }
  const setDer = new Uint8Array([0x31, ...derLength(inner.length), ...inner]);
  const signature = new Uint8Array(await crypto.subtle.sign(RSA, keys.privateKey, setDer));

  const certAsn = AsnConvert.parse(cert.rawData, (await import("@peculiar/asn1-x509")).Certificate);
  const signer = new SignerInfo({
    version: CMSVersion.v1,
    sid: new SignerIdentifier({
      issuerAndSerialNumber: new IssuerAndSerialNumber({ issuer: certAsn.tbsCertificate.issuer, serialNumber: certAsn.tbsCertificate.serialNumber }),
    }),
    digestAlgorithm: new AlgorithmIdentifier({ algorithm: "2.16.840.1.101.3.4.2.1" }),
    signedAttrs,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: "1.2.840.113549.1.1.1" }),
    signature: new OctetString(signature),
  });
  const signedData = new SignedData({
    version: CMSVersion.v1,
    digestAlgorithms: new DigestAlgorithmIdentifiers([new AlgorithmIdentifier({ algorithm: "2.16.840.1.101.3.4.2.1" })]),
    encapContentInfo: new EncapsulatedContentInfo({
      eContentType: id_data,
      eContent: new EncapsulatedContent({ single: new OctetString(document) }),
    }),
    signerInfos: new SignerInfos([signer]),
  });
  const ci = new ContentInfo({ contentType: id_signedData, content: AsnConvert.serialize(signedData) });
  return bytesToB64(new Uint8Array(AsnConvert.serialize(ci)));
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

import realShapeDocument from "./fixtures/aws-identity/document.json?raw";
import realShapeRsa2048 from "./fixtures/aws-identity/rsa2048.b64?raw";
import realShapeSigner from "./fixtures/aws-identity/signer.pem?raw";

describe("AWS identity document verification", () => {
  it("joins a BER OCTET STRING's chunks: primitive, definite and indefinite constructed", () => {
    const b = (...x: number[]) => new Uint8Array(x);
    expect(octetStringContents(b(0x04, 2, 0x61, 0x62))).toEqual(b(0x61, 0x62));
    expect(octetStringContents(b(0x24, 0x80, 0x04, 1, 0x61, 0x04, 2, 0x62, 0x63, 0, 0))).toEqual(b(0x61, 0x62, 0x63));
    expect(octetStringContents(b(0x24, 7, 0x04, 1, 0x61, 0x24, 2, 0x04, 0))).toEqual(b(0x61));
    expect(() => octetStringContents(b(0x24, 0x80, 0x04, 5, 0x61))).toThrow(/truncated/);
  });

  it("accepts IMDS's rsa2048 shape: BER, indefinite lengths, the document in a constructed OCTET STRING", async () => {
    const doc = new TextEncoder().encode(realShapeDocument);
    const id = await new CmsRsaIdentityVerifier(realShapeSigner).verify(bytesToB64(doc), realShapeRsa2048.replace(/\s+/g, ""));
    expect(id).toEqual({ instanceId: "i-0123456789abcdef0", accountId: "123456789012", region: "us-east-1" });
  });

  const doc = new TextEncoder().encode(JSON.stringify({ instanceId: "i-0abc123", accountId: "123456789012", region: "us-east-1" }));

  it("accepts a valid rsa2048 PKCS#7 signature", async () => {
    const { keys, cert } = await rsaCert("aws");
    const pkcs7 = await signDocument(doc, keys, cert);
    const id = await new CmsRsaIdentityVerifier(cert.toString("pem")).verify(bytesToB64(doc), pkcs7);
    expect(id).toEqual({ instanceId: "i-0abc123", accountId: "123456789012", region: "us-east-1" });
  });

  it("rejects a tampered document and a foreign certificate", async () => {
    const { keys, cert } = await rsaCert("aws");
    const pkcs7 = await signDocument(doc, keys, cert);
    const tampered = new TextEncoder().encode(JSON.stringify({ instanceId: "i-evil", accountId: "123456789012", region: "us-east-1" }));
    await expect(new CmsRsaIdentityVerifier(cert.toString("pem")).verify(bytesToB64(tampered), pkcs7)).rejects.toThrow(/does not match/);
    const other = await rsaCert("not-aws");
    await expect(new CmsRsaIdentityVerifier(other.cert.toString("pem")).verify(bytesToB64(doc), pkcs7)).rejects.toThrow(/does not verify/);
  });
});

describe("enrollment", () => {
  it("enrolls with a one-time token and issues a host token and a proxy intermediate", async () => {
    const cell = uniqueCell();
    const r = await enrollHost(cell);
    expect(r.host).toMatch(/^hst_/);
    const claims = await verifyHostToken(env.HOST_TOKEN_SECRET, r.host_token);
    expect(claims).toMatchObject({ host: r.host, cell, role: "burst" });
    expect(r.fleet_ws_url).toMatch(/^ws.*\/v1\/fleet$/);

    // The intermediate is a CA limited to signing leaves, signed by the root baked into images.
    x509.cryptoProvider.set(crypto);
    const inter = new x509.X509Certificate(r.proxy_ca.cert_pem);
    const rootPem = await (await SELF.fetch(`${BASE}/v1/admin/root-ca?cell=${cell}`, { headers: { authorization: "Bearer test-admin-token" } })).text();
    const root = new x509.X509Certificate(rootPem);
    expect(await inter.verify({ publicKey: root, signatureOnly: true })).toBe(true);
    const bc = inter.getExtension(x509.BasicConstraintsExtension)!;
    expect(bc.ca).toBe(true);
    expect(bc.pathLength).toBe(0);
    expect(r.proxy_ca.chain_pem).toContain(root.toString("pem").trim().split("\n")[1]);
    expect(r.proxy_ca.expires_ms).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  });

  it("rejects reused, unknown and wrong-role tokens", async () => {
    const cell = uniqueCell();
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } });
    const post = async (t: string, role = "burst") =>
      SELF.fetch(`${BASE}/v1/hosts/enroll`, {
        method: "POST",
        body: JSON.stringify({ protocol_version: 1, role, cell, proof: { type: "enrollment_token", token: t }, proxy_ca_csr_pem: await csrPem() }),
      });
    expect((await post(token, "controller")).status).toBe(401);
    const first = await post(token);
    expect(first.status).toBe(200);
    // Spent once the host connects (before that, a retry of a lost answer: test/tunnel.test.ts).
    const { host, host_token } = (await first.json()) as { host: string; host_token: string };
    const ws = await Ws.connect("/v1/fleet", host_token);
    ws.send(hostHello(host, cell));
    await ws.next("hello_ack");
    expect((await post(token)).status).toBe(409);
    expect((await post("net_bogus")).status).toBe(401);
    ws.close();
  });

  it("AWS hosts must have been launched by us and enroll once", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const req = {
      protocol_version: 1, role: "burst" as const, cell,
      proof: { type: "aws_identity_document" as const, document_b64: "", pkcs7_b64: "" },
      proxy_ca_csr_pem: await csrPem(),
    };
    const identity = { instanceId: "i-0launched", accountId: "1", region: "us-east-1" };
    const enroll = () => Promise.resolve().then(() => fleet.enroll(req, cell, identity));
    await expect(enroll()).rejects.toThrow(/not launched/);
    await fleet.registerLaunched({ instance_id: "i-0launched" });
    const enrolled = await fleet.enroll(req, cell, identity);
    expect(enrolled.host).toMatch(/^hst_/);
    // Once connected; until then a retry of a lost answer enrolls again (test/tunnel.test.ts).
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell));
    await ws.next("hello_ack");
    await expect(enroll()).rejects.toThrow(/already enrolled/);
    ws.close();
  });

  it("an AWS enrollment over HTTP without a configured certificate is unauthorized", async () => {
    const res = await SELF.fetch(`${BASE}/v1/hosts/enroll`, {
      method: "POST",
      body: JSON.stringify({ protocol_version: 1, role: "burst", cell: "x", proof: { type: "aws_identity_document", document_b64: "e30=", pkcs7_b64: "AA==" }, proxy_ca_csr_pem: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("renews the proxy CA over the fleet channel and rejects bad tokens and versions", async () => {
    const cell = uniqueCell();
    const r = await enrollHost(cell);
    const unauth = await SELF.fetch(`${BASE}/v1/fleet`, { headers: { upgrade: "websocket", authorization: "Bearer nht_x.y" } });
    expect(unauth.status).toBe(401);

    const ws = await Ws.connect("/v1/fleet", r.host_token);
    ws.send(hostHello(r.host, cell));
    const ack = await ws.next("hello_ack");
    expect(ack.lease).toEqual({ heartbeat_ms: 5000, host_fence_ms: 20000, cp_expiry_ms: 30000 });
    ws.send({ type: "ca_renew", csr_pem: await csrPem() });
    const ca = await ws.next("proxy_ca");
    expect(ca.cert_pem).toContain("BEGIN CERTIFICATE");
    ws.close();

    const bad = await Ws.connect("/v1/fleet", r.host_token);
    bad.send(hostHello(r.host, cell, { protocol_version: 99 }));
    const err = await bad.next("error");
    expect(err.error.code).toBe("unsupported_protocol_version");
  });
});

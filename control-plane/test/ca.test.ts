import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { createRootCertificate, kmsRoot, signIntermediate } from "../src/lib/ca";
import { derToRawEcdsa } from "../src/lib/kms";
import { csrPem, FakeKms } from "./helpers";

describe("proxy root CA in KMS", () => {
  it("converts KMS's DER signatures to WebCrypto's raw form, padding short and trimming signed integers", () => {
    // r has its high bit set (DER adds 0x00), s is 31 bytes (DER drops its leading zero).
    const r = new Uint8Array(32).fill(0xab);
    const s = new Uint8Array(32).fill(0x11);
    s[0] = 0;
    const seq = [0x02, 33, 0, ...r, 0x02, 31, ...s.subarray(1)];
    expect(derToRawEcdsa(new Uint8Array([0x30, seq.length, ...seq]))).toEqual(new Uint8Array([...r, ...s]));
    expect(() => derToRawEcdsa(new Uint8Array([0x30, 2, 0x02, 0]))).toThrow("malformed");
    expect(() => derToRawEcdsa(new Uint8Array([0x30, seq.length + 1, ...seq, 0]))).toThrow("malformed");
  });

  it("self-signs a root and issues intermediates that chain to it, signing only through KMS", async () => {
    const kms = await FakeKms.create();
    const rootPem = await createRootCertificate(await kms.publicKey(), kmsRoot("", kms, "k").sign, "CN=test root", 86_400_000);
    const root = new x509.X509Certificate(rootPem);
    x509.cryptoProvider.set(crypto);
    expect(await root.verify({ signatureOnly: true })).toBe(true);
    expect(root.getExtension(x509.BasicConstraintsExtension)?.ca).toBe(true);

    // Many signatures: about half of r or s values need DER's sign padding, so a broken conversion fails here.
    for (let i = 0; i < 8; i++) {
      const ca = await signIntermediate(kmsRoot(rootPem, kms, "k"), await csrPem(), 3_600_000);
      const inter = new x509.X509Certificate(ca.cert_pem);
      expect(await inter.verify({ publicKey: root.publicKey, signatureOnly: true })).toBe(true);
      expect(inter.issuer).toBe(root.subject);
    }
    expect(kms.calls).toBe(9);
  });

  it("refuses to issue when the KMS key isn't the root's", async () => {
    const kms = await FakeKms.create();
    const rootPem = await createRootCertificate(await kms.publicKey(), kmsRoot("", kms, "k").sign, "CN=test root", 86_400_000);
    const other = await FakeKms.create();
    await expect(signIntermediate(kmsRoot(rootPem, other, "k"), await csrPem(), 3_600_000)).rejects.toThrow("does not verify against the root");
  });
});

// Everything AWS is per cell (src/lib/cells.ts): region, credentials, the proxy root CA key and its
// certificate, with the legacy globals as a one-release fallback that the operator view names.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { AsnConvert } from "@peculiar/asn1-schema";
import { Certificate, SubjectPublicKeyInfo } from "@peculiar/asn1-x509";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { createRootCertificate, kmsRoot } from "../src/lib/ca";
import { awsCell, cellAws, cellCredentials, parseCellCredentials, type AwsCellConfig } from "../src/lib/cells";
import { pemToDer } from "../src/lib/util";
import type { Env } from "../src/env";
import { compressedSpki, csrPem, FakeKms, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const LEGACY_SECRET = "legacy/secret/value/do-not-print";
const keyArn = (region: string) => `arn:aws:kms:${region}:589531222691:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
const KEY_ARN = keyArn("eu-west-1");
const config = (cellRegion = "eu-west-1", key: string | null = keyArn(cellRegion)): AwsCellConfig => ({
  region: cellRegion, launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"],
  spot: true, max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  ...(key ? { proxy_root_key_arn: key } : {}),
});
const legacyEnv = { AWS_ACCESS_KEY_ID: "AKIALEGACY0000000000", AWS_SECRET_ACCESS_KEY: LEGACY_SECRET, AWS_REGION: "us-east-1", ROOT_CA_KMS_KEY_ID: "alias/nest-use1-proxy-root" };
const credentials = (cell: string) => JSON.stringify({ [cell]: { access_key_id: "AKIACELL000000000000", secret_access_key: SECRET } });

/** Runs `f` in the cell's FleetDO with these env overrides (on that instance only) and test doubles. */
async function inFleet<T>(cell: string, over: Partial<Env>, setup: { config?: AwsCellConfig | null; kms?: FakeKms }, f: (inst: FleetDO) => Promise<T>): Promise<T> {
  return runInDurableObject(fleetStub(cell), async (inst: FleetDO) => {
    Object.defineProperty(inst, "env", { value: { ...env, ...over }, configurable: true });
    inst.cellConfigOverride = setup.config === undefined ? null : setup.config;
    inst.kmsOverride = setup.kms;
    (inst as unknown as { kmsRoot: unknown }).kmsRoot = null;
    return f(inst);
  });
}

const endpoint = (client: unknown) => (client as { endpoint: string }).endpoint;
const keptRoot = (cell: string) => runInDurableObject(fleetStub(cell), async (_inst, state) =>
  state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'root_ca'").toArray()[0]?.value ?? null);
/** An intermediate for a fresh CSR, signed by the cell's root. */
const signProxyCa = async (inst: FleetDO) =>
  (inst as unknown as { signProxyCa(csr: string): Promise<{ cert_pem: string }> }).signProxyCa(await csrPem());
async function chains(interPem: string, rootPem: string): Promise<boolean> {
  x509.cryptoProvider.set(crypto);
  return new x509.X509Certificate(interPem).verify({ publicKey: new x509.X509Certificate(rootPem).publicKey, signatureOnly: true });
}
/** A self-signed root for the fake KMS key, as the setup flow once made `ROOT_CA_CERT_PEM`. */
const legacyRoot = async (kms: FakeKms) => createRootCertificate(await kms.publicKey(), kmsRoot("", kms, "k").sign, "CN=nest proxy root CA", 86_400_000 * 365);

/** `pem` re-encoded with its key as a compressed point and re-signed by `kms`: the same key, other DER. */
async function withCompressedKey(pem: string, kms: FakeKms): Promise<string> {
  const cert = AsnConvert.parse(pemToDer(pem), Certificate);
  const spki = new Uint8Array(AsnConvert.serialize(cert.tbsCertificate.subjectPublicKeyInfo));
  cert.tbsCertificate.subjectPublicKeyInfo = AsnConvert.parse(compressedSpki(spki), SubjectPublicKeyInfo);
  cert.signatureValue = (await kms.sign("k", new Uint8Array(AsnConvert.serialize(cert.tbsCertificate)))).slice().buffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(AsnConvert.serialize(cert))));
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

describe("per-cell AWS settings", () => {
  it("prefers the cell's own region, credentials and KMS key, and names each source", () => {
    const a = cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("euw1") }, "euw1", config());
    expect(a.region).toEqual({ source: "cell", value: "eu-west-1" });
    expect(a.credentials).toEqual({ source: "cell", value: { access_key_id: "AKIACELL000000000000", secret_access_key: SECRET } });
    expect(a.kmsKey).toEqual({ source: "cell", value: KEY_ARN });
    expect(a.credentialsError).toBeUndefined();
  });

  it("falls back to the legacy globals per setting for a cell without its own entry", () => {
    const a = cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("other") }, "use1", config("us-east-1", null));
    expect(a.region.source).toBe("cell");
    expect(a.credentials).toEqual({ source: "legacy", value: { access_key_id: "AKIALEGACY0000000000", secret_access_key: LEGACY_SECRET } });
    expect(a.kmsKey).toEqual({ source: "legacy", value: "alias/nest-use1-proxy-root" });
    const none = cellAws({}, "use1", null);
    expect([none.region, none.credentials, none.kmsKey]).toEqual([{ source: "none" }, { source: "none" }, { source: "none" }]);
    expect(cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("use1") }, null, null).credentials.source).toBe("legacy");
  });

  it("passes over a malformed credentials entry to the legacy globals, keeping the error but no value", () => {
    const malformed = JSON.stringify({ use1: { access_key_id: SECRET } });
    const a = cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: malformed }, "use1", null);
    expect(a.credentials.source).toBe("legacy");
    expect(a.credentialsError).toMatch(/^AWS_CELL_CREDENTIALS\.use1 is malformed \(access_key_id, secret_access_key\)$/);
    const alone = cellAws({ AWS_CELL_CREDENTIALS: "not json " + SECRET }, "use1", null);
    expect(alone.credentials.source).toBe("none");
    expect(alone.credentialsError).toBe("AWS_CELL_CREDENTIALS is not valid JSON");
  });

  it("rejects malformed credentials without ever quoting a value", () => {
    const bad = [
      SECRET, // not JSON: V8's message would quote its start
      JSON.stringify([SECRET]),
      JSON.stringify({ use1: { access_key_id: "lowercase-" + SECRET, secret_access_key: SECRET } }),
      JSON.stringify({ use1: { access_key_id: "AKIACELL000000000000", secret_access_key: "", extra: SECRET } }),
    ];
    for (const json of bad) {
      for (const check of [() => cellCredentials(json, "use1"), () => parseCellCredentials(json)]) {
        let message = "";
        try {
          check();
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(/^AWS_CELL_CREDENTIALS/);
        expect(message).not.toContain("wJalr");
      }
    }
    expect(cellCredentials(credentials("use1"), "euw1")).toBeNull();
  });

  it("checks every entry and cell name of the whole secret (the dev/ helper's check)", () => {
    expect(Object.keys(parseCellCredentials(credentials("use1")))).toEqual(["use1"]);
    expect(() => parseCellCredentials("{}")).toThrow("no cells");
    expect(() => parseCellCredentials(JSON.stringify({ USE1: JSON.parse(credentials("use1")).use1 }))).toThrow("not a cell name");
    expect(() => parseCellCredentials(JSON.stringify({ ...JSON.parse(credentials("use1")), euw1: {} }))).toThrow("AWS_CELL_CREDENTIALS.euw1 is malformed");
  });

  it("takes the KMS key from AWS_CELLS only in the cell's own region, and tolerates entries without one", () => {
    const entry = (c: AwsCellConfig) => JSON.stringify({ euw1: c });
    expect(awsCell(entry(config()), "euw1")?.proxy_root_key_arn).toBe(KEY_ARN);
    expect(() => awsCell(entry(config("us-east-1", KEY_ARN)), "euw1")).toThrow("cell's region");
    expect(() => awsCell(entry({ ...config(), proxy_root_key_arn: "alias/nest-euw1-proxy-root" }), "euw1")).toThrow();
    expect(awsCell(entry(config("us-east-1", null)), "euw1")?.proxy_root_key_arn).toBeUndefined();
  });
});

describe("FleetDO's AWS clients", () => {
  it("reaches KMS, EC2 and SSM in the cell's region, not AWS_REGION", async () => {
    const cell = uniqueCell();
    await inFleet(cell, { ...legacyEnv, AWS_CELL_CREDENTIALS: credentials(cell) }, { config: config() }, async (inst) => {
      inst.ec2Override = undefined;
      inst.ssmOverride = undefined;
      const i = inst as unknown as { kms(): unknown; ec2(): unknown; ssm(): unknown };
      expect(endpoint(i.kms())).toBe("https://kms.eu-west-1.amazonaws.com/");
      expect(endpoint(i.ec2())).toBe("https://ec2.eu-west-1.amazonaws.com/");
      expect(endpoint(i.ssm())).toBe("https://ssm.eu-west-1.amazonaws.com/");
    });
  });

  it("knows its cell from its own name, before any host or placement names it", async () => {
    const cell = uniqueCell();
    const view = await inFleet(cell, { AWS_CELL_CREDENTIALS: credentials(cell) }, { config: config() }, (inst) => inst.fleetView());
    expect(view.aws).toMatchObject({ cell, sources: { credentials: "cell" } });
    const written = await runInDurableObject(fleetStub(cell), async (_inst, state) =>
      state.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'cell'").toArray().length);
    expect(written).toBe(0);
  });

  it("says which source the cell uses in the operator view, never the values", async () => {
    const own = uniqueCell();
    const view = await inFleet(own, { ...legacyEnv, AWS_CELL_CREDENTIALS: credentials(own) }, { config: config() }, (inst) => inst.fleetView());
    expect(view.aws).toEqual({ cell: own, region: "eu-west-1", sources: { region: "cell", credentials: "cell", kms_key: "cell" } });
    expect(JSON.stringify(view)).not.toContain(SECRET);

    const legacy = uniqueCell();
    const old = await inFleet(legacy, legacyEnv, { config: config("us-east-1", null) }, (inst) => inst.fleetView());
    expect(old.aws).toEqual({ cell: legacy, region: "us-east-1", sources: { region: "cell", credentials: "legacy", kms_key: "legacy" } });
    expect(JSON.stringify(old)).not.toContain(LEGACY_SECRET);

    const broken = uniqueCell();
    const bad = await inFleet(broken, { ...legacyEnv, AWS_CELL_CREDENTIALS: `{"${broken}": {"access_key_id": "${SECRET}"}}` }, {}, (inst) => inst.fleetView());
    expect(bad.aws).toEqual({ cell: broken, region: "us-east-1", sources: { region: "legacy", credentials: "legacy", kms_key: "legacy" },
      error: `AWS_CELL_CREDENTIALS.${broken} is malformed (access_key_id, secret_access_key)` });
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });
});

describe("the cell's root CA certificate", () => {
  it("is self-signed through the cell's KMS key once when there is no legacy certificate, kept, and chains every intermediate", async () => {
    const cell = uniqueCell();
    const kms = await FakeKms.create();
    const creds = { AWS_CELL_CREDENTIALS: credentials(cell) };
    const [first, inter] = await inFleet(cell, creds, { config: config(), kms }, async (inst) =>
      [await inst.rootCertificatePem(), await signProxyCa(inst)] as const);
    expect(new Set(kms.keyIds)).toEqual(new Set([KEY_ARN]));
    x509.cryptoProvider.set(crypto);
    expect(new x509.X509Certificate(first).subject).toBe(`CN=nest ${cell} proxy root CA`);
    expect(await chains(inter.cert_pem, first)).toBe(true);
    expect(await keptRoot(cell)).toBe(first);
    // A new instance (no in-memory cache) returns the kept certificate, not a fresh one.
    expect(await inFleet(cell, creds, { config: config(), kms }, (inst) => inst.rootCertificatePem())).toBe(first);
  });

  it("on use1's deploy day (key from the cell entry, legacy credentials, the matching legacy certificate) adopts that certificate", async () => {
    const cell = uniqueCell();
    const kms = await FakeKms.create();
    const legacyPem = await legacyRoot(kms);
    kms.keyIds = [];
    const over = { ...legacyEnv, ROOT_CA_CERT_PEM: legacyPem };
    const [view, pem, inter] = await inFleet(cell, over, { config: config("us-east-1"), kms }, async (inst) =>
      [await inst.fleetView(), await inst.rootCertificatePem(), await signProxyCa(inst)] as const);
    expect(view.aws).toEqual({ cell, region: "us-east-1", sources: { region: "cell", credentials: "legacy", kms_key: "cell" } });
    expect(pem).toBe(legacyPem);
    expect(await keptRoot(cell)).toBe(legacyPem);
    expect(new Set(kms.keyIds)).toEqual(new Set([keyArn("us-east-1")]));
    expect(await chains(inter.cert_pem, legacyPem)).toBe(true);
  });

  it("fails closed when the legacy certificate is for another key, and keeps nothing", async () => {
    const cell = uniqueCell();
    const legacyPem = await legacyRoot(await FakeKms.create());
    const kms = await FakeKms.create();
    await expect(inFleet(cell, { ...legacyEnv, ROOT_CA_CERT_PEM: legacyPem }, { config: config("us-east-1"), kms }, (inst) => signProxyCa(inst)))
      .rejects.toThrow("ROOT_CA_CERT_PEM is not a certificate for the cell's KMS key");
    expect(await keptRoot(cell)).toBeNull();
  });

  it("fails closed when the cell's key changes: rotation is never a side effect of configuration", async () => {
    const cell = uniqueCell();
    const creds = { AWS_CELL_CREDENTIALS: credentials(cell) };
    const before = await inFleet(cell, creds, { config: config(), kms: await FakeKms.create() }, (inst) => inst.rootCertificatePem());
    await expect(inFleet(cell, creds, { config: config(), kms: await FakeKms.create() }, (inst) => inst.rootCertificatePem()))
      .rejects.toThrow("the root certificate the cell keeps is not a certificate for the cell's KMS key");
    expect(await keptRoot(cell)).toBe(before);
  });

  it("matches the key and the certificate whatever valid DER encodes the public key", async () => {
    // KMS's encoding differs from the certificate's.
    const a = uniqueCell();
    const kmsA = await FakeKms.create();
    const legacyA = await legacyRoot(kmsA);
    kmsA.encoding = "compressed";
    expect(await inFleet(a, { ...legacyEnv, ROOT_CA_CERT_PEM: legacyA }, { config: config("us-east-1"), kms: kmsA }, (inst) => inst.rootCertificatePem())).toBe(legacyA);

    // The certificate's encoding (made by another tool) differs from KMS's.
    const b = uniqueCell();
    const kmsB = await FakeKms.create();
    const legacyB = await withCompressedKey(await legacyRoot(kmsB), kmsB);
    x509.cryptoProvider.set(crypto);
    expect(new x509.X509Certificate(legacyB).publicKey.rawData.byteLength).toBe(59); // 91 in WebCrypto's uncompressed form
    const [pem, inter] = await inFleet(b, { ...legacyEnv, ROOT_CA_CERT_PEM: legacyB }, { config: config("us-east-1"), kms: kmsB }, async (inst) =>
      [await inst.rootCertificatePem(), await signProxyCa(inst)] as const);
    expect(pem).toBe(legacyB);
    expect(await chains(inter.cert_pem, legacyB)).toBe(true);
  });
});

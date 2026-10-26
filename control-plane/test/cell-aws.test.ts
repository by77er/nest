// Everything AWS is per cell (src/lib/cells.ts): region, credentials, the proxy root CA key and its
// certificate, with the legacy globals as a one-release fallback that the operator view names.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { createRootCertificate, kmsRoot } from "../src/lib/ca";
import { awsCell, cellAws, cellCredentials, type AwsCellConfig } from "../src/lib/cells";
import type { Env } from "../src/env";
import { csrPem, FakeKms, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const LEGACY_SECRET = "legacy/secret/value/do-not-print";
const KEY_ARN = "arn:aws:kms:eu-west-1:589531222691:key/1234abcd-12ab-34cd-56ef-1234567890ab";
const config = (cellRegion = "eu-west-1", key: string | null = KEY_ARN): AwsCellConfig => ({
  region: cellRegion, launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"],
  spot: true, max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  ...(key ? { proxy_root_key_arn: key } : {}),
});
const legacyEnv = { AWS_ACCESS_KEY_ID: "AKIALEGACY0000000000", AWS_SECRET_ACCESS_KEY: LEGACY_SECRET, AWS_REGION: "us-east-1", ROOT_CA_KMS_KEY_ID: "alias/nest-use1-proxy-root" };
const credentials = (cell: string) => JSON.stringify({ [cell]: { access_key_id: "AKIACELL000000000000", secret_access_key: SECRET } });

/** Runs `f` in the cell's FleetDO with these env overrides (on that instance only) and test doubles. */
async function inFleet<T>(cell: string, over: Partial<Env>, setup: { config?: AwsCellConfig | null; kms?: FakeKms }, f: (inst: FleetDO) => Promise<T>): Promise<T> {
  return runInDurableObject(fleetStub(cell), async (inst: FleetDO, state) => {
    state.storage.sql.exec("INSERT OR IGNORE INTO kv (key, value) VALUES ('cell', ?)", cell);
    Object.defineProperty(inst, "env", { value: { ...env, ...over }, configurable: true });
    inst.cellConfigOverride = setup.config === undefined ? null : setup.config;
    inst.kmsOverride = setup.kms;
    return f(inst);
  });
}

const endpoint = (client: unknown) => (client as { endpoint: string }).endpoint;

describe("per-cell AWS settings", () => {
  it("prefers the cell's own region, credentials and KMS key, and names each source", () => {
    const a = cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("euw1") }, "euw1", config());
    expect(a.region).toBe("eu-west-1");
    expect(a.credentials).toEqual({ access_key_id: "AKIACELL000000000000", secret_access_key: SECRET });
    expect(a.kmsKeyId).toBe(KEY_ARN);
    expect(a.sources).toEqual({ region: "cell", credentials: "cell", kms_key: "cell" });
  });

  it("falls back to the legacy globals per setting for a cell without its own entry", () => {
    const a = cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("other") }, "use1", config("us-east-1", null));
    expect(a.credentials?.access_key_id).toBe("AKIALEGACY0000000000");
    expect(a.kmsKeyId).toBe("alias/nest-use1-proxy-root");
    expect(a.sources).toEqual({ region: "cell", credentials: "legacy", kms_key: "legacy" });
    expect(cellAws({}, "use1", null).sources).toEqual({ region: "none", credentials: "none", kms_key: "none" });
    // A FleetDO that doesn't know its cell yet can only use the legacy globals.
    expect(cellAws({ ...legacyEnv, AWS_CELL_CREDENTIALS: credentials("use1") }, null, null).sources.credentials).toBe("legacy");
  });

  it("rejects malformed credentials without ever quoting a value", () => {
    const bad = [
      SECRET, // not JSON: V8's message would quote its start
      JSON.stringify([SECRET]),
      JSON.stringify({ use1: { access_key_id: "lowercase-" + SECRET, secret_access_key: SECRET } }),
      JSON.stringify({ use1: { access_key_id: "AKIACELL000000000000", secret_access_key: "", extra: SECRET } }),
    ];
    for (const json of bad) {
      let message = "";
      try {
        cellCredentials(json, "use1");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/^AWS_CELL_CREDENTIALS/);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("wJalr");
    }
    expect(cellCredentials(credentials("use1"), "euw1")).toBeNull();
  });

  it("takes the KMS key from AWS_CELLS only in the cell's own region, and tolerates entries without one", () => {
    const entry = (c: AwsCellConfig) => JSON.stringify({ euw1: c });
    expect(awsCell(entry(config()), "euw1")?.proxy_root_key_arn).toBe(KEY_ARN);
    expect(() => awsCell(entry(config("us-east-1")), "euw1")).toThrow("cell's region");
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
    const bad = await inFleet(broken, { AWS_CELL_CREDENTIALS: `{"${broken}": {"access_key_id": "${SECRET}"}}` }, {}, (inst) => inst.fleetView());
    expect(bad.aws).toMatchObject({ cell: broken, error: expect.stringContaining("malformed") });
    expect(JSON.stringify(bad)).not.toContain(SECRET);
  });
});

describe("the cell's root CA certificate", () => {
  /** The root certificate and one intermediate signed for a fresh CSR, in one FleetDO call. */
  const issue = (inst: FleetDO) => (inst as unknown as { signProxyCa(csr: string): Promise<{ cert_pem: string }> });

  it("is self-signed through the cell's KMS key once, kept, and chains every intermediate", async () => {
    const cell = uniqueCell();
    const kms = await FakeKms.create();
    const creds = { AWS_CELL_CREDENTIALS: credentials(cell) };
    const [first, inter] = await inFleet(cell, creds, { config: config(), kms }, async (inst) =>
      [await inst.rootCertificatePem(), await issue(inst).signProxyCa(await csrPem())] as const);
    expect(new Set(kms.keyIds)).toEqual(new Set([KEY_ARN]));
    x509.cryptoProvider.set(crypto);
    const root = new x509.X509Certificate(first);
    expect(root.subject).toBe(`CN=nest ${cell} proxy root CA`);
    expect(await new x509.X509Certificate(inter.cert_pem).verify({ publicKey: root.publicKey, signatureOnly: true })).toBe(true);
    // A new instance (no in-memory cache) returns the stored certificate, not a fresh one.
    const again = await inFleet(cell, creds, { config: config(), kms }, async (inst) => {
      (inst as unknown as { kmsRoot: unknown }).kmsRoot = null;
      return inst.rootCertificatePem();
    });
    expect(again).toBe(first);
  });

  it("adopts the legacy ROOT_CA_CERT_PEM when it is the cell key's certificate, so baked images stay valid", async () => {
    const cell = uniqueCell();
    const kms = await FakeKms.create();
    const legacyPem = await createRootCertificate(await kms.publicKey(), kmsRoot("", kms, "k").sign, "CN=nest proxy root CA", 86_400_000 * 365);
    const pem = await inFleet(cell, { ...legacyEnv, ROOT_CA_CERT_PEM: legacyPem }, { config: config("us-east-1", null), kms }, (inst) => inst.rootCertificatePem());
    expect(pem).toBe(legacyPem);
    expect(kms.keyIds).toContain("alias/nest-use1-proxy-root");

    // Another cell with its own key never takes that certificate.
    const other = uniqueCell();
    const otherKms = await FakeKms.create();
    const own = await inFleet(other, { ...legacyEnv, ROOT_CA_CERT_PEM: legacyPem, AWS_CELL_CREDENTIALS: credentials(other) }, { config: config(), kms: otherKms }, (inst) => inst.rootCertificatePem());
    expect(own).not.toBe(legacyPem);
    expect(own).toContain("BEGIN CERTIFICATE");
  });

  it("gets a new certificate when the cell's key changes", async () => {
    const cell = uniqueCell();
    const creds = { AWS_CELL_CREDENTIALS: credentials(cell) };
    const before = await inFleet(cell, creds, { config: config(), kms: await FakeKms.create() }, (inst) => inst.rootCertificatePem());
    const rotated = await FakeKms.create();
    const after = await inFleet(cell, creds, { config: config(), kms: rotated }, async (inst) => {
      (inst as unknown as { kmsRoot: unknown }).kmsRoot = null;
      return inst.rootCertificatePem();
    });
    expect(after).not.toBe(before);
    x509.cryptoProvider.set(crypto);
    expect(await new x509.X509Certificate(after).verify({ publicKey: await crypto.subtle.importKey("spki", await rotated.publicKey(), { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]), signatureOnly: true })).toBe(true);
  });
});

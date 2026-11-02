// Caller identity for MCP servers (docs/control-plane/api/clients/#caller-identity-for-mcp-servers):
// the key schedule, the per-caller token cache, BrokerDO's keys and signing, and the JWKS route. Tokens
// are checked by test/jwt.ts, a verifier written from the spec as an MCP server would write it. What
// AgentDO and the connector send is in test/mcp.test.ts ("caller identity").
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BrokerDO } from "../src/do/broker";
import {
  IDENTITY_KEY_AHEAD_MS, IDENTITY_KEY_RETAIN_MS, IDENTITY_KEY_SIGNS_MS, IdentityTokens, keyPlan, type IdentitySubject,
} from "../src/lib/identity";
import { BASE } from "./helpers";
import { fetchJwks, type Jwk, thumbprint, verifyIdentity } from "./jwt";

const D = 24 * 3_600_000;
const T0 = 1_800_000_000_000;
const AUD = "https://mcp.example.com/mcp";

describe("the key schedule", () => {
  // The spec: the next key is published a day before it signs; a key signs 30 days; a retired key stays
  // published a day (a token lives 5 minutes).
  it("has the documented periods", () => {
    expect([IDENTITY_KEY_SIGNS_MS, IDENTITY_KEY_AHEAD_MS, IDENTITY_KEY_RETAIN_MS]).toEqual([30 * D, D, D]);
  });

  const a = { kid: "a", signs_from_ms: T0 };
  const b = { kid: "b", signs_from_ms: T0 + 30 * D };
  const c = { kid: "c", signs_from_ms: T0 + 60 * D };
  it.each([
    ["no key: the first signs at once", [], T0, { signer: null, published: [], drop: [], next_signs_from_ms: T0 }],
    ["one key, early in its period", [a], T0 + 29 * D - 1, { signer: "a", published: ["a"], drop: [], next_signs_from_ms: null }],
    ["a day before its period ends, the next key is due, to sign when it ends", [a], T0 + 29 * D, { signer: "a", published: ["a"], drop: [], next_signs_from_ms: T0 + 30 * D }],
    ["nothing ran that day: the next key still gets a day of publication, and the current one signs on", [a], T0 + 40 * D,
      { signer: "a", published: ["a"], drop: [], next_signs_from_ms: T0 + 41 * D }],
    ["the next key is published but doesn't sign before its time", [a, b], T0 + 30 * D - 1, { signer: "a", published: ["a", "b"], drop: [], next_signs_from_ms: null }],
    ["at its time it signs; the old key stays published", [a, b], T0 + 30 * D, { signer: "b", published: ["b", "a"], drop: [], next_signs_from_ms: null }],
    ["the old key is published until a day after it retired", [a, b], T0 + 31 * D - 1, { signer: "b", published: ["b", "a"], drop: [], next_signs_from_ms: null }],
    ["then it goes", [a, b], T0 + 31 * D, { signer: "b", published: ["b"], drop: ["a"], next_signs_from_ms: null }],
    ["each key retires when the one after it starts signing", [c, a, b], T0 + 60 * D + 1, { signer: "c", published: ["c", "b"], drop: ["a"], next_signs_from_ms: null }],
  ])("%s", (_name, keys, now, want) => {
    expect(keyPlan(keys, now)).toEqual(want);
  });
});

describe("the caller's token cache", () => {
  const subject = (o: Partial<IdentitySubject> = {}): IdentitySubject => ({ aud: AUD, sub: "agt_1", owner: "user", epoch: 1, tainted: false, ...o });
  function cache() {
    let now = T0;
    const signed: IdentitySubject[] = [];
    let release: () => void = () => undefined;
    let gate: Promise<void> | null = null;
    const ids = new IdentityTokens(async (s) => {
      signed.push(s);
      if (gate) await gate;
      return { token: `tok${signed.length}`, exp_ms: now + 5 * 60_000 };
    }, () => now);
    return {
      ids, signed, advance: (ms: number) => { now += ms; },
      hold: () => { gate = new Promise((r) => { release = r; }); }, release: () => { gate = null; release(); },
    };
  }

  it("reuses a token for its first four minutes, then signs again", async () => {
    const c = cache();
    await c.ids.ensure(subject());
    expect(c.ids.current(subject())).toBe("tok1");
    c.advance(4 * 60_000 - 1);
    await c.ids.ensure(subject());
    expect(c.ids.current(subject())).toBe("tok1");
    c.advance(1);
    expect(c.ids.current(subject())).toBeNull();
    await c.ids.ensure(subject());
    expect(c.ids.current(subject())).toBe("tok2");
    expect(c.signed).toHaveLength(2);
  });

  it("a token is never served for another taint, epoch, audience or label set", async () => {
    const c = cache();
    await c.ids.ensure(subject());
    for (const other of [{ tainted: true }, { epoch: 2 }, { aud: "https://other.example.com/mcp" }, { labels: { task: "t1" } }, { client: "cli_x" }]) {
      expect(c.ids.current(subject(other))).toBeNull();
    }
    // Key order doesn't make another subject.
    expect(c.ids.current({ tainted: false, epoch: 1, owner: "user", sub: "agt_1", aud: AUD })).toBe("tok1");
  });

  it("concurrent requests for one subject share one signature", async () => {
    const c = cache();
    c.hold();
    const both = Promise.all([c.ids.ensure(subject()), c.ids.ensure(subject())]);
    c.release();
    await both;
    expect(c.signed).toHaveLength(1);
  });
});

describe("BrokerDO's keys and the JWKS", () => {
  const broker = () => env.BROKER.get(env.BROKER.idFromName("broker"));

  it("GET /.well-known/jwks.json answers without auth, briefly cacheable, with public Ed25519 keys named by their thumbprints", async () => {
    const j = await fetchJwks();
    expect(j.status).toBe(200);
    expect(j.cacheControl).toBe("public, max-age=300");
    expect(j.keys.length).toBeGreaterThanOrEqual(1);
    for (const k of j.keys) {
      expect(k).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig" });
      // A private key never leaves BrokerDO.
      expect(Object.keys(k).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x"]);
      expect(k.kid).toBe(await thumbprint(k));
    }
    // Not under the admin token: a wrong one changes nothing.
    const res = await SELF.fetch(`${BASE}/.well-known/jwks.json`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(200);
  });

  it("signs a subject with iss, iat and exp (5 minutes) of its own, verifiable against the JWKS; only the subject's claims get in", async () => {
    const r = await broker().signIdentity({ aud: AUD, sub: "agt_x", owner: "user", epoch: 3, tainted: true });
    const v = await verifyIdentity(r.token, { aud: AUD, keys: (await fetchJwks()).keys });
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (!v.ok) return;
    expect(v.claims).toEqual({ aud: AUD, sub: "agt_x", owner: "user", epoch: 3, tainted: true, iss: "https://nest.test", iat: v.claims.iat, exp: v.claims.iat + 300 });
    expect(r.exp_ms).toBe(v.claims.exp * 1000);
    // A caller can't set the issuer or the lifetime, or add a claim.
    for (const extra of [{ exp: 9_999_999_999 }, { iss: "https://evil.test" }, { admin: true }]) {
      await expect(Promise.resolve().then(() => broker().signIdentity({ aud: AUD, sub: "agt_x", ...extra } as any))).rejects.toThrow(/caller identity/);
    }
  });

  it("the verifier refuses a token for another audience, an altered one, an unsigned one and one whose kid names another key", async () => {
    const r = await broker().signIdentity({ aud: AUD, sub: "agt_x" });
    const keys = (await fetchJwks()).keys;
    expect((await verifyIdentity(r.token, { aud: AUD, keys })).ok).toBe(true);
    expect(await verifyIdentity(r.token, { aud: "https://other.example.com/mcp", keys })).toMatchObject({ ok: false, why: expect.stringMatching(/^aud/) });
    const [h, p, sig] = r.token.split(".") as [string, string, string];
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    expect(await verifyIdentity(`${h}.${b64({ ...claims, sub: "agt_other" })}.${sig}`, { aud: AUD, keys })).toMatchObject({ ok: false, why: "bad signature" });
    expect(await verifyIdentity(`${b64({ alg: "none" })}.${p}.`, { aud: AUD, keys })).toMatchObject({ ok: false });
    const other: Jwk = { kty: "OKP", crv: "Ed25519", x: (await crypto.subtle.exportKey("jwk", ((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair).publicKey) as JsonWebKey).x!, kid: "other" };
    expect(await verifyIdentity(`${b64({ alg: "EdDSA", typ: "JWT", kid: "other" })}.${p}.${sig}`, { aud: AUD, keys: [...keys, other] })).toMatchObject({ ok: false, why: "bad signature" });
  });

  it("rotation: the next key is published a day before it signs, a retired key verifies until it leaves the JWKS a day later", async () => {
    // A BrokerDO of its own, so moving its keys' times moves no other test's.
    const b = env.BROKER.get(env.BROKER.idFromName(`identity-rotation-${crypto.randomUUID()}`));
    const plant = (sql: string, ...args: unknown[]) => runInDurableObject(b, (_: BrokerDO, st) => { st.storage.sql.exec(sql, ...args); });
    const times = () => runInDurableObject(b, (_: BrokerDO, st) =>
      st.storage.sql.exec<{ kid: string; signs_from_ms: number }>("SELECT kid, signs_from_ms FROM identity_keys ORDER BY signs_from_ms").toArray());
    const kidOf = (t: string) => JSON.parse(atob(t.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/"))).kid as string;

    const first = await b.identityJwks();
    expect(first.keys).toHaveLength(1);
    const k1 = first.keys[0]!.kid;
    const tok1 = (await b.signIdentity({ aud: AUD, sub: "agt_r" })).token;
    expect(kidOf(tok1)).toBe(k1);

    // Half a day before k1's period ends: k2 is made and published, to sign a day from now; k1 still signs.
    await plant("UPDATE identity_keys SET signs_from_ms = ? WHERE kid = ?", Date.now() - (IDENTITY_KEY_SIGNS_MS - 0.5 * D), k1);
    const tok2 = (await b.signIdentity({ aud: AUD, sub: "agt_r" })).token;
    expect(kidOf(tok2)).toBe(k1);
    const second = await b.identityJwks();
    expect(second.keys.map((k) => k.kid)[0]).toBe(k1);
    expect(second.keys).toHaveLength(2);
    const k2 = second.keys[1]!.kid;
    const k2From = (await times()).find((t) => t.kid === k2)!.signs_from_ms;
    expect(k2From - Date.now()).toBeGreaterThan(D - 60_000);

    // k2's time comes: it signs, and k1, now retired, is still published, so k1's tokens still verify.
    await plant("UPDATE identity_keys SET signs_from_ms = ? WHERE kid = ?", Date.now() - 1_000, k2);
    const tok3 = (await b.signIdentity({ aud: AUD, sub: "agt_r" })).token;
    expect(kidOf(tok3)).toBe(k2);
    const third = (await b.identityJwks()).keys;
    expect(third.map((k) => k.kid).sort()).toEqual([k1, k2].sort());
    expect((await verifyIdentity(tok1, { aud: AUD, keys: third })).ok).toBe(true);
    expect((await verifyIdentity(tok3, { aud: AUD, keys: third })).ok).toBe(true);

    // A day after k1 retired it leaves the JWKS and storage: a token it signed no longer verifies.
    await plant("UPDATE identity_keys SET signs_from_ms = ? WHERE kid = ?", Date.now() - IDENTITY_KEY_RETAIN_MS - 1_000, k2);
    const fourth = (await b.identityJwks()).keys;
    expect(fourth.map((k) => k.kid)).toEqual([k2]);
    expect(await verifyIdentity(tok1, { aud: AUD, keys: fourth })).toMatchObject({ ok: false, why: `unknown kid ${k1}` });
    expect((await verifyIdentity(tok3, { aud: AUD, keys: fourth })).ok).toBe(true);
    expect((await times()).map((t) => t.kid)).toEqual([k2]);
  });

  it("concurrent first uses make one key", async () => {
    const b = env.BROKER.get(env.BROKER.idFromName(`identity-first-${crypto.randomUUID()}`));
    await Promise.all([b.identityJwks(), b.signIdentity({ aud: AUD, sub: "agt_a" }), b.signIdentity({ aud: AUD, sub: "agt_b" }), b.identityJwks()]);
    expect((await b.identityJwks()).keys).toHaveLength(1);
  });
});

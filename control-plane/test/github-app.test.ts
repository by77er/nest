// The GitHub App's JWT and REST client (lib/github.ts), which BrokerDO mints sandboxes' installation tokens
// with (docs/control-plane/durable-objects/broker/). Pure: a fake fetch stands in for GitHub.
import { beforeAll, describe, expect, it } from "vitest";
import { appJwt, GitHubApi, importAppKey, pkcs1ToPkcs8 } from "../src/lib/github";
import { b64url, b64urlToBytes, bytesToB64 } from "../src/lib/util";

const APP_ID = "424242";

/** The inner `RSAPrivateKey` of a PKCS#8 RSA key: what GitHub hands out (`BEGIN RSA PRIVATE KEY`). */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  // PrivateKeyInfo ::= SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING { RSAPrivateKey } }
  const len = (o: number): [number, number] => {
    const b = pkcs8[o]!;
    if (b < 0x80) return [b, o + 1];
    const n = b & 0x7f;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + pkcs8[o + 1 + i]!;
    return [v, o + 1 + n];
  };
  let [, o] = len(1); // outer SEQUENCE
  o += 3; // INTEGER 0
  const [algLen, algBody] = len(o + 1);
  o = algBody + algLen;
  const [keyLen, keyBody] = len(o + 1); // OCTET STRING
  return pkcs8.slice(keyBody, keyBody + keyLen);
}
const pem = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${bytesToB64(der).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

let appKeys: CryptoKeyPair;
let appPkcs1Pem: string;

async function verifyJwt(jwt: string): Promise<{ iat: number; exp: number; iss: string } | null> {
  const [h, p, sig] = jwt.split(".");
  if (!h || !p || !sig) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", appKeys.publicKey, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok || JSON.parse(new TextDecoder().decode(b64urlToBytes(h))).alg !== "RS256") return null;
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
}

beforeAll(async () => {
  appKeys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true,
    ["sign", "verify"]) as CryptoKeyPair;
  appPkcs1Pem = pem("RSA PRIVATE KEY", pkcs1Of(new Uint8Array(await crypto.subtle.exportKey("pkcs8", appKeys.privateKey) as ArrayBuffer)));
});

describe("the GitHub App's JWT and client", () => {
  it("a PKCS#1 key (what GitHub hands out) and its PKCS#8 form both sign a JWT that verifies with the App's public key, within GitHub's limits", async () => {
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", appKeys.privateKey) as ArrayBuffer);
    // The wrapper is exactly the PKCS#8 WebCrypto exports (an independent encoder of the same key).
    expect(b64url(pkcs1ToPkcs8(pkcs1Of(pkcs8)))).toBe(b64url(pkcs8));
    const now = Date.UTC(2026, 9, 31, 12);
    for (const p of [appPkcs1Pem, pem("PRIVATE KEY", pkcs8)]) {
      const c = await verifyJwt(await appJwt(APP_ID, await importAppKey(p), now));
      expect(c).toEqual({ iat: now / 1000 - 60, exp: now / 1000 + 540, iss: APP_ID });
      // GitHub: exp at most 10 minutes ahead.
      expect(c!.exp - now / 1000).toBeLessThanOrEqual(600);
    }
  });

  it("mints a token narrowed to one repo and the permissions asked for, with GitHub's headers; a repo without the App is null", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/installation")) return new Response(url.includes("/nope/") ? "{}" : JSON.stringify({ id: 7 }), { status: url.includes("/nope/") ? 404 : 200 });
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: "2026-10-31T13:00:00Z" }), { status: 201 });
    }) as unknown as typeof fetch;
    const api = new GitHubApi(fake, "https://gh.example");
    expect(await api.installation("jwt", "me/app")).toBe(7);
    expect(await api.installation("jwt", "nope/x")).toBeNull();
    expect(await api.mint("jwt", 7, "app", { issues: "write" })).toEqual({ token: "ghs_x", expires_ms: Date.UTC(2026, 9, 31, 13) });
    const mint = seen.at(-1)!;
    expect(mint.url).toBe("https://gh.example/app/installations/7/access_tokens");
    expect(JSON.parse(String(mint.init.body))).toEqual({ repositories: ["app"], permissions: { issues: "write" } });
    expect(mint.init.headers).toMatchObject({ authorization: "Bearer jwt", accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" });
    // A redirect is a refusal, never followed with the token.
    expect(mint.init.redirect).toBe("manual");
  });

  it("the default fetch works under workerd (no incorrect `this`: Illegal invocation)", async () => {
    // Every other client test injects a fake fetch, which binds nothing (review lesson 8). Nothing
    // listens at the discard port, so a correctly invoked fetch fails on the connection instead.
    const r = await new GitHubApi(undefined, "http://127.0.0.1:9").request("t", "GET", "/x");
    expect(r.kind).toBe("lost");
    expect((r as { why: string }).why).not.toMatch(/Illegal invocation/);
    expect((r as { why: string }).why).toMatch(/^network: /);
  });
});

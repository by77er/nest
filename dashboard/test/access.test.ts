// The Worker admits a request only with a valid Cloudflare Access token for the dashboard's
// application (src/access.ts), and fails closed otherwise. The oracle is Cloudflare's token format:
// an RS256 JWT signed by one of the team's keys, published as a JWKS at
// <team>/cdn-cgi/access/certs. A key pair generated here plays the team.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAccessKeys } from "../src/access";
import worker, { type Env } from "../src/worker";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-of-the-dashboard-application";
const CERTS = `${TEAM}/cdn-cgi/access/certs`;
const CONTROL_PLANE = "https://cp.example";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

type Pair = { privateKey: CryptoKey; publicKey: CryptoKey };
const rsa = () => crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
) as Promise<Pair>;

let team: Pair;
let stranger: Pair;
let jwks: { keys: JsonWebKey[] };

async function sign(claims: Record<string, unknown>, opts: { signer?: CryptoKey; kid?: string; alg?: string } = {}): Promise<string> {
  const head = b64urlJson({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const body = b64urlJson(claims);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.signer ?? team.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const nowS = () => Math.floor(Date.now() / 1000);
const good = () => ({ iss: TEAM, aud: [AUD], exp: nowS() + 600, iat: nowS() - 5, nbf: nowS() - 5, email: "owner@example.com" });

let assets: string[];
let upstream: { url: string; auth: string | null }[];
let certFetches: number;

const env = (over: Partial<Env> = {}): Env => ({
  ASSETS: { fetch: async (r: Request) => { assets.push(new URL(r.url).pathname); return new Response("<html>"); } } as unknown as Fetcher,
  NEST_CONTROL_PLANE: CONTROL_PLANE,
  NEST_CELLS: "use1",
  ACCESS_TEAM_DOMAIN: TEAM,
  DASHBOARD_AUD: AUD,
  NEST_ADMIN_TOKEN: "admin-token",
  ...over,
});

async function call(path: string, token?: string, e: Env = env()): Promise<Response> {
  const headers: Record<string, string> = token === undefined ? {} : { "cf-access-jwt-assertion": token };
  return worker.fetch(new Request(`https://dash.example${path}`, { headers }) as never, e);
}

beforeAll(async () => {
  team = await rsa();
  stranger = await rsa();
  jwks = { keys: [{ ...(await crypto.subtle.exportKey("jwk", team.publicKey)), kid: "k1", alg: "RS256", use: "sig" } as JsonWebKey] };
});

beforeEach(() => {
  // The deployed Worker: `vite build` sets DEV to false (src/worker.ts).
  vi.stubEnv("DEV", false);
  resetAccessKeys();
  assets = [];
  upstream = [];
  certFetches = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === CERTS) {
      certFetches++;
      return Response.json(jwks);
    }
    if (url.startsWith(CONTROL_PLANE)) {
      upstream.push({ url, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ hosts: [], launches: [], sandboxes: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the dashboard Worker's Access check", () => {
  it("serves the page and proxies the API with a valid token", async () => {
    const token = await sign(good());
    expect((await call("/", token)).status).toBe(200);
    expect(assets).toEqual(["/"]);
    const api = await call("/api/fleet?cell=use1", token);
    expect(api.status).toBe(200);
    expect(upstream).toEqual([{ url: `${CONTROL_PLANE}/v1/admin/fleet?cell=use1`, auth: "Bearer admin-token" }]);
  });

  it("caches the team's keys across requests", async () => {
    const token = await sign(good());
    await call("/", token);
    await call("/api/cells", token);
    expect(certFetches).toBe(1);
  });

  const refused: [string, () => Promise<string | undefined>, Partial<Env>?][] = [
    ["no token", async () => undefined],
    ["a token that is not a JWT", async () => "not-a-jwt"],
    ["the wrong audience", async () => sign({ ...good(), aud: ["another-application"] })],
    ["the wrong issuer", async () => sign({ ...good(), iss: "https://other.cloudflareaccess.com" })],
    ["an expired token", async () => sign({ ...good(), exp: nowS() - 1 })],
    ["no expiry", async () => sign({ ...good(), exp: undefined })],
    ["a token not valid yet", async () => sign({ ...good(), nbf: nowS() + 3600 })],
    ["a signature by another key under the team's kid", async () => sign(good(), { signer: stranger.privateKey })],
    ["an unknown kid", async () => sign(good(), { kid: "k-unknown" })],
    ["alg none", async () => {
      const t = await sign(good());
      return `${b64urlJson({ alg: "none", kid: "k1" })}.${t.split(".")[1]}.`;
    }],
    ["a payload changed after signing", async () => {
      const [h, , s] = (await sign(good())).split(".");
      return `${h}.${b64urlJson({ ...good(), email: "someone@else" })}.${s}`;
    }],
    ["a valid token on a Worker with no audience configured", async () => sign(good()), { DASHBOARD_AUD: undefined }],
    ["a valid token on a Worker with no team configured", async () => sign(good()), { ACCESS_TEAM_DOMAIN: undefined }],
  ];
  it.each(refused)("refuses %s with 403, page and API alike", async (_name, token, over) => {
    const t = await token();
    for (const path of ["/", "/index.html", "/api/cells", "/api/fleet?cell=use1"]) {
      expect((await call(path, t, env(over))).status, path).toBe(403);
    }
    expect(assets).toEqual([]);
    expect(upstream).toEqual([]);
  });

  it("refuses when the team's keys cannot be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    expect((await call("/api/fleet?cell=use1", await sign(good()))).status).toBe(403);
  });

  it("refetches the keys for a kid it has not seen once the cache is old enough, so a rotated key works", async () => {
    const now = vi.spyOn(Date, "now");
    const t0 = Date.now();
    now.mockReturnValue(t0);
    expect((await call("/", await sign(good()))).status).toBe(200);
    const rotated = await rsa();
    jwks = { keys: [...jwks.keys, { ...(await crypto.subtle.exportKey("jwk", rotated.publicKey)), kid: "k2" } as JsonWebKey] };
    now.mockReturnValue(t0 + 31_000);
    expect((await call("/", await sign(good(), { signer: rotated.privateKey, kid: "k2" }))).status).toBe(200);
    expect(certFetches).toBe(2);
    now.mockRestore();
    jwks = { keys: jwks.keys.slice(0, 1) };
  });
});

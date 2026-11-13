// The app's own GitHub App (README.md#github-tokens, src/github-app.ts): its JWT against WebCrypto and a key made
// here, and its installation tokens against the fake GitHub (test/fake-nest.ts), which checks the JWT with the
// run's public key, keeps installations, and refuses a token past its expiry or its installation.
import { env } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { githubFor, PERMISSIONS } from "../src/github";
import { appJwt, appTokenCache, AppTokens, importAppKey, pkcs1ToPkcs8, resetAppTokens, TOKEN_REUSE_MS, tokenSource } from "../src/github-app";
import { NestError, nestFrom } from "../src/nest";
import { FakeNest, GH_APP_ID, GH_INSTALLATION_ID, GRANT_PERMISSIONS, installFetch } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
let restore: () => void;
beforeAll(() => {
  restore = installFetch(fake);
});
afterAll(() => restore());
beforeEach(() => {
  resetAppTokens();
  gh.installations = [{ id: GH_INSTALLATION_ID, account: null, repos: "all", permissions: { ...GRANT_PERMISSIONS } }];
  gh.tokenLifeMs = 3_600_000;
  gh.failures = [];
  fake.grantRepos = null;
  fake.grantListing = null;
});
afterEach(() => vi.restoreAllMocks());

const appEnv = env as unknown as Env;
const nest = () => nestFrom(appEnv)!;
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const newRepo = () => `o-${rand()}/r-${rand()}`;
const lookups = (repo: string) => gh.callsTo("GET", new RegExp(`^/repos/${repo}/installation$`)).length;

// --- the key and the JWT ---------------------------------------------------------------------------------

const b64urlDecode = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** The PKCS#1 key inside WebCrypto's PKCS#8 export: the PrivateKeyInfo's OCTET STRING (RFC 5208), read independently of the app's code. */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
  let at = 0;
  const header = () => {
    const tag = pkcs8[at++]!;
    let len = pkcs8[at++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + pkcs8[at++]!;
    }
    return { tag, len };
  };
  header();
  for (let i = 0; i < 2; i++) {
    const { len } = header();
    at += len;
  }
  const key = header();
  expect(key.tag).toBe(0x04);
  return pkcs8.slice(at, at + key.len);
}

/** A PEM of `der` under `label`, made at run time (no key, nor a key's armor, is ever in the source). */
const armor = (label: string, der: Uint8Array) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...der)).replace(/.{64}/g, "$&\n")}\n-----END ${label}-----\n`;

async function newKey() {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const pkcs1 = pkcs1Of(pkcs8);
  const pem = armor("RSA PRIVATE KEY", pkcs1);
  return { pair, pkcs8, pkcs1, pem };
}

describe("the App's JWT", () => {
  it("wraps a PKCS#1 key as exactly the PKCS#8 WebCrypto exports for it", async () => {
    const k = await newKey();
    expect([...pkcs1ToPkcs8(k.pkcs1)]).toEqual([...k.pkcs8]);
  });

  it("is RS256 over its header and claims, under the App's PKCS#1 key: iss the App's id, issued a minute back, 9 minutes to live", async () => {
    const k = await newKey();
    const now = 1_794_000_000_123;
    const jwt = await appJwt("4242", await importAppKey(k.pem), now);
    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(h!)))).toEqual({ alg: "RS256", typ: "JWT" });
    const s = Math.floor(now / 1000);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(c!)))).toEqual({ iat: s - 60, exp: s + 540, iss: "4242" });
    const verify = (input: string) => crypto.subtle.verify("RSASSA-PKCS1-v1_5", k.pair.publicKey, b64urlDecode(sig!), new TextEncoder().encode(input));
    expect(await verify(`${h}.${c}`)).toBe(true);
    // The signature covers the claims: another iss doesn't verify.
    const other = btoa(JSON.stringify({ iat: s - 60, exp: s + 540, iss: "4243" })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verify(`${h}.${other}`)).toBe(false);
  });

  it("is what GitHub takes: the fake checks it with the run's public key", async () => {
    const repo = newRepo();
    await new AppTokens(appEnv).token(repo, PERMISSIONS.metadata);
    expect(gh.jwts.at(-1)).toMatchObject({ iss: String(GH_APP_ID) });
  });

  it("missing secrets, or a key GitHub refuses, fail as an outage (retried), never a refusal, and say which secret", async () => {
    const repo = newRepo();
    const unset = new AppTokens({ ...appEnv, GITHUB_APP_ID: undefined });
    await expect(unset.token(repo, PERMISSIONS.metadata)).rejects.toMatchObject({ status: 503, permanent: false, message: expect.stringContaining("GITHUB_APP_ID") });
    const other = await newKey();
    const wrong = new AppTokens({ ...appEnv, GITHUB_APP_PRIVATE_KEY: other.pem });
    const e = await wrong.token(repo, PERMISSIONS.metadata).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 503, permanent: false, message: expect.stringContaining("GITHUB_APP_PRIVATE_KEY") });
    // Nothing of the key in what it says.
    expect(String(e)).not.toContain("PRIVATE KEY-----");
  });
});

// --- installation tokens ---------------------------------------------------------------------------------

describe("installation tokens", () => {
  it("are narrowed to the one repo and each call's permissions, from the App's installation on the repo", async () => {
    const repo = newRepo();
    const account = repo.split("/")[0]!;
    gh.install({ id: 9_001, account });
    const before = gh.mints().length;
    const a = await githubFor(appEnv, nest(), repo, PERMISSIONS.checks);
    const b = await githubFor(appEnv, nest(), repo, PERMISSIONS.repoSettings);
    expect(gh.mints().slice(before)).toEqual([
      { installation: 9_001, repositories: [repo.split("/")[1]], permissions: { checks: "write" } },
      { installation: 9_001, repositories: [repo.split("/")[1]], permissions: { administration: "write" } },
    ]);
    expect([a.installationId, a.appId]).toEqual([9_001, GH_APP_ID]);
    // A token reaches only its repo: another repo of the same installation isn't shown it.
    const sibling = `${account}/other-${rand()}`;
    await expect(b.call("GET", `/repos/${sibling}`)).rejects.toMatchObject({ status: 404 });
  });

  it("are reused per installation, repo and permissions while more than 10 minutes are left, and minted again after", async () => {
    const repo = newRepo();
    const src = new AppTokens(appEnv);
    const before = gh.mints().length;
    gh.tokenLifeMs = TOKEN_REUSE_MS + 60_000;
    const a = await src.token(repo, { issues: "read", pull_requests: "read" });
    // The same permissions in another order are the same set.
    const b = await src.token(repo, { pull_requests: "read", issues: "read" });
    expect(b.token).toBe(a.token);
    expect(gh.mints().length - before).toBe(1);
    // Within 10 minutes of its expiry: minted again.
    gh.tokenLifeMs = TOKEN_REUSE_MS - 60_000;
    const c = await src.token(repo, { checks: "write" });
    const d = await src.token(repo, { checks: "write" });
    expect(d.token).not.toBe(c.token);
    expect(gh.mints().length - before).toBe(3);
  });

  it("look the repo's installation up again after 10 minutes, and at once when a binding asks (fresh)", async () => {
    const repo = newRepo();
    const src = new AppTokens(appEnv);
    await src.token(repo, PERMISSIONS.metadata);
    await src.token(repo, PERMISSIONS.checks);
    expect(lookups(repo)).toBe(1);
    await src.token(repo, PERMISSIONS.checks, { fresh: true });
    expect(lookups(repo)).toBe(2);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    await src.token(repo, PERMISSIONS.checks);
    expect(lookups(repo)).toBe(3);
  });

  it("a lookup that answers another installation (the App reinstalled) drops every token of the old one", async () => {
    const repo = newRepo();
    const account = repo.split("/")[0]!;
    gh.install({ id: 9_101, account });
    const src = new AppTokens(appEnv);
    const old = await src.token(repo, PERMISSIONS.checks);
    await src.token(repo, PERMISSIONS.metadata);
    expect(appTokenCache().tokens.filter((t) => t.installation === 9_101)).toHaveLength(2);
    gh.reinstall(account, 9_102);
    const now = await src.token(repo, PERMISSIONS.checks, { fresh: true });
    expect(now.installationId).toBe(9_102);
    expect(now.token).not.toBe(old.token);
    expect(appTokenCache().tokens.filter((t) => t.installation === 9_101)).toEqual([]);
    // And the call that isn't fresh takes the new installation's too.
    expect((await src.token(repo, PERMISSIONS.metadata)).installationId).toBe(9_102);
  });

  it.each([401, 404])("a token GitHub answers %i is dropped, and the repo's installation looked up again", async (status) => {
    const repo = newRepo();
    const gh1 = await githubFor(appEnv, nest(), repo, PERMISSIONS.metadata);
    expect(lookups(repo)).toBe(1);
    gh.fail(new RegExp(`^GET /repos/${repo}$`), status);
    await expect(gh1.repoInfo(repo)).rejects.toMatchObject({ status });
    const mints = gh.mints().length;
    const gh2 = await githubFor(appEnv, nest(), repo, PERMISSIONS.metadata);
    expect(lookups(repo)).toBe(2);
    expect(gh.mints().length).toBe(mints + 1);
    expect((await gh2.repoInfo(repo)).full_name).toBe(repo);
  });

  it("an installation GitHub no longer has (uninstalled): the lookup says so, and nothing cached for it is handed out", async () => {
    const repo = newRepo();
    gh.install({ id: 9_201, account: repo.split("/")[0]! });
    const src = new AppTokens(appEnv);
    await src.token(repo, PERMISSIONS.metadata);
    // Uninstalled, and on no other installation (the default one gone too).
    gh.uninstall(9_201);
    gh.uninstall(GH_INSTALLATION_ID);
    await expect(src.token(repo, PERMISSIONS.metadata, { fresh: true })).rejects.toMatchObject({ status: 404, message: expect.stringContaining("isn't installed") });
    expect(appTokenCache().tokens.filter((t) => t.installation === 9_201)).toEqual([]);
  });

  it("are GitHub's to refuse, not nest's grant: nest isn't asked, and a permission the installation wasn't granted is GitHub's refusal", async () => {
    const repo = newRepo();
    const account = repo.split("/")[0]!;
    const src = new AppTokens(appEnv);
    fake.grantRepos = ["someone/else"];
    const asked = fake.calls.length;
    await src.token(repo, PERMISSIONS.metadata, { fresh: true });
    expect(fake.calls.length).toBe(asked);
    // An installation granted no issues permission: GitHub refuses the mint (422), a refusal that will repeat.
    gh.install({ id: 9_301, account, permissions: { metadata: "read" } });
    await expect(src.token(repo, PERMISSIONS.issuesWrite, { fresh: true })).rejects.toMatchObject({ status: 422, permanent: true });
    // A repo its installation doesn't select: the same.
    gh.install({ id: 9_301, account, repos: [], permissions: { metadata: "read" } });
    await expect(src.token(repo, PERMISSIONS.metadata, { fresh: true })).rejects.toMatchObject({ status: 404 });
  });

  it("the App's slug is GitHub's own answer", async () => {
    expect(await new AppTokens(appEnv).appSlug()).toBe("nest-test");
  });
});

describe("the App's installations and their repos", () => {
  it("lists every installation (paged) and each one's own repos (paged, capped), with a token for the installation's repos and metadata only", async () => {
    const acct = `many-${rand()}`;
    for (let n = 0; n < 150; n++) gh.repo(`${acct}/r${String(n).padStart(3, "0")}`);
    gh.installations = [
      ...Array.from({ length: 120 }, (_, n) => ({ id: 20_000 + n, account: `filler-${n}-${rand()}`, repos: new Set<string>(), permissions: { ...GRANT_PERMISSIONS } })),
      { id: 30_001, account: acct, repos: "all" as const, permissions: { ...GRANT_PERMISSIONS } },
    ];
    const src = new AppTokens(appEnv);
    const list = await src.installationsList();
    expect(list).toHaveLength(121);
    expect(list.at(-1)).toEqual({ id: 30_001, account: acct });
    const whole = await src.installationRepos(30_001);
    expect(whole).toMatchObject({ complete: true });
    expect(whole.repos).toHaveLength(150);
    expect(whole.repos[0]).toBe(`${acct}/r000`);
    const capped = await src.installationRepos(30_001, 120);
    expect(capped.repos).toHaveLength(120);
    expect(capped.complete).toBe(false);
    // A token per listing: no repo named, metadata only, revoked after (GitHub no longer knows it).
    const listing = { installation: 30_001, repositories: undefined, permissions: { metadata: "read" } };
    expect(gh.mints().filter((m) => m.installation === 30_001)).toEqual([listing, listing]);
    const listed = gh.callsTo("GET", /^\/installation\/repositories$/);
    expect(listed.length).toBeGreaterThan(0);
    for (const c of listed) {
      expect(gh.calls.some((d) => d.method === "DELETE" && d.path === "/installation/token" && d.token === c.token)).toBe(true);
      expect(gh.tokens.has(c.token!)).toBe(false);
    }
    // Only this installation's own repos.
    const other = newRepo();
    gh.repo(other);
    expect((await src.installationRepos(30_001)).repos).not.toContain(other);
  });
});

describe("the fallback: nest's tokens", () => {
  it("GITHUB_TOKEN_SOURCE=nest takes every token from nest, none from the App; unset, the App's", async () => {
    const repo = newRepo();
    expect(tokenSource({ ...appEnv, GITHUB_TOKEN_SOURCE: undefined }, nest()).kind).toBe("app");
    expect(tokenSource({ ...appEnv, GITHUB_TOKEN_SOURCE: "app" }, nest()).kind).toBe("app");
    const fallback = { ...appEnv, GITHUB_TOKEN_SOURCE: "nest" };
    expect(tokenSource(fallback, nest()).kind).toBe("nest");
    const asked = fake.callsTo("POST", /^\/v1\/clients\/self\/github-token$/).length;
    const minted = gh.mints().length;
    const g = await githubFor(fallback, nest(), repo, PERMISSIONS.checks);
    expect(fake.callsTo("POST", /^\/v1\/clients\/self\/github-token$/).at(-1)!.body).toEqual({ repo, permissions: { checks: "write" } });
    expect(fake.callsTo("POST", /^\/v1\/clients\/self\/github-token$/).length).toBe(asked + 1);
    expect(gh.mints().length).toBe(minted);
    expect([g.appId, g.installationId]).toEqual([GH_APP_ID, GH_INSTALLATION_ID]);
    // Works with no App secrets at all: the way out of a key problem.
    await githubFor({ ...fallback, GITHUB_APP_ID: undefined, GITHUB_APP_PRIVATE_KEY: undefined }, nest(), repo, PERMISSIONS.metadata);
  });
});

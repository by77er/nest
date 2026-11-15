// BrokerDO's GitHub installation tokens (docs/control-plane/durable-objects/broker/#github-app): which
// installation a token is minted from, and the installation cache behind every mint (`githubToken`, the
// path brokered actions take; a sandbox's own tokens go through the same mint). A fake GitHub (as in
// repos.test.ts: a fetch handler for https://api.github.com over the global fetch BrokerDO calls) records
// every mint.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrokerDO } from "../src/do/broker";
import { installationVerdict, retryMintFresh, STALE_INSTALLATION_STATUSES } from "../src/lib/github";
import { adminJson } from "./helpers";
import { bytesToB64 } from "../src/lib/util";

class FakeGitHub {
  /** repo (lowercase) → installation id. */
  readonly installs = new Map<string, number>();
  readonly mints: { installation: number; repositories: string[]; permissions: Record<string, string>; token: string; expires_at: string }[] = [];
  private n = 0;
  /** Every mint asked for (refused ones too), by installation; and a status every mint is refused with, when set. */
  readonly mintAsks: number[] = [];
  refuseMints: number | null = null;
  /** A permission the App wasn't granted: a mint asking for it is refused 422, as GitHub does. */
  ungranted: string | null = null;
  /** Installation lookups (`GET /repos/{repo}/installation`). */
  lookups = 0;

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      this.lookups++;
      const id = this.installs.get(m[1]!.toLowerCase());
      return id ? json(200, { id }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      const body = await req.json() as { repositories: string[]; permissions: Record<string, string> };
      const installation = Number(m[1]);
      this.mintAsks.push(installation);
      if (this.refuseMints !== null) return json(this.refuseMints, { message: "refused" });
      if (this.ungranted && Object.hasOwn(body.permissions, this.ungranted)) return json(422, { message: "The permissions requested are not granted to this installation." });
      const ok = body.repositories.every((name) => [...this.installs].some(([r, i]) => i === installation && r.endsWith(`/${name}`)));
      if (!ok) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      // Built at run time and low in entropy (review lesson 9).
      const token = `ghs_ins${String(++this.n).padStart(30, "0")}`;
      const expires_at = new Date(Date.now() + 3_600_000).toISOString();
      this.mints.push({ installation, ...body, token, expires_at });
      return json(201, { token, expires_at, permissions: body.permissions });
    }
    return json(404, { message: "Not Found" });
  }
}

const gh = new FakeGitHub();
const realFetch = globalThis.fetch;
const brokerStub = () => env.BROKER.get(env.BROKER.idFromName("broker"));
beforeAll(async () => {
  // Any RSA key will do: the fake doesn't check the JWT. Kept if another file stored the App already.
  const have = await runInDurableObject(brokerStub(), async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = 'github_app'").one().n);
  if (!have) {
    const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey) as ArrayBuffer);
    // The armor is built from its label, so no literal key block sits in the source for the secret scan.
    const armor = (edge: "BEGIN" | "END") => `-----${edge} ${"PRIVATE KEY"}-----`;
    const pem = [armor("BEGIN"), ...bytesToB64(der).match(/.{1,64}/g)!, armor("END"), ""].join("\n");
    await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ app_id: "77", private_key: pem }) } });
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    return new URL(req.url).hostname === "api.github.com" ? gh.handle(req) : realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
/** A repo the App is installed on, in a fresh installation (each test its own: tokens are cached per repo). */
function repo(): string {
  const r = `own-${rand()}/app-${rand()}`;
  gh.installs.set(r, 1000 + Math.floor(Math.random() * 1e6));
  return r;
}

const CALLER = { agent: "agt_cachetest", call: "agt_cachetest/1/1" };
/** A token as BrokerDO mints it for a brokered action. */
const mint = (r: string, permissions: Record<string, string>) =>
  brokerStub().githubToken(r, permissions as Record<string, "read">, CALLER);
/** A mint that must be refused: the refusal's message. */
async function refusal(r: string, permissions: Record<string, string>): Promise<string> {
  try {
    await Promise.resolve().then(() => mint(r, permissions));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`${r} ${JSON.stringify(permissions)} was minted`);
}

describe("the installation a token was minted from", () => {
  it("a cached token answers its own mint's installation, not the repo's installation now", async () => {
    const r = repo();
    const first = await mint(r, { contents: "read" });
    const minted = gh.installs.get(r)!;
    expect(first.installation).toBe(minted);
    // The repo's installation changes, and the cached lookup is past its day, so a lookup now would say
    // the new one. The cached token isn't stale (no mint is refused): it is served, and it was minted
    // from the first installation.
    gh.installs.set(r, minted + 7);
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_app_installations SET fetched_ms = 0 WHERE repo = ?", r);
    });
    const before = gh.mints.length;
    expect(await mint(r, { contents: "read" })).toMatchObject({ token: first.token, installation: minted });
    expect(gh.mints.length).toBe(before);
  });

  it("a cached token answers its own installation even after another mint refreshed the repo's lookup to a new one", async () => {
    const r = repo();
    // (1) Permission set A, minted from installation X.
    const a = await mint(r, { contents: "read" });
    const x = gh.installs.get(r)!;
    expect(a.installation).toBe(x);
    // (2) The repo moves to installation Y, and its lookup row passes its day.
    const y = x + 11;
    gh.installs.set(r, y);
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await runInDurableObject(broker, (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_app_installations SET fetched_ms = 0 WHERE repo = ?", r);
    });
    // (3) Permission set B: looked up afresh, minted from Y; the lookup row now says Y.
    const b = await mint(r, { checks: "write" });
    expect(b.installation).toBe(y);
    expect(await runInDurableObject(broker, (_i: BrokerDO, st) =>
      st.storage.sql.exec<{ installation: number }>("SELECT installation FROM github_app_installations WHERE repo = ?", r).one().installation)).toBe(y);
    // (4) A again: its cached token, which was minted from X, and says so.
    const mints = gh.mints.length;
    expect(await mint(r, { contents: "read" })).toMatchObject({ token: a.token, installation: x });
    expect(gh.mints.length).toBe(mints);
  });
});

// --- The installation cache (state-machine sweep, bug 7) ---------------------------------------------------

describe("the installation cache", () => {
  const refused = (status: number) => Object.assign(new Error("refused"), { github_status: status });
  it("retries a refused mint afresh only once, only from the cache, only for a status that may mean stale (pure)", () => {
    // [status, from cache, attempt, retried]
    const table: [number | null, boolean, number, boolean][] = [
      [404, true, 0, true], [401, true, 0, true], [422, true, 0, true],
      [404, false, 0, false], [404, true, 1, false],
      [403, true, 0, false], [400, true, 0, false], [429, true, 0, false], [null, true, 0, false],
    ];
    for (const [status, cached, attempt, want] of table) {
      expect(retryMintFresh(status === null ? new Error("lost") : refused(status), cached, attempt), `${status} ${cached} ${attempt}`).toBe(want);
    }
    expect(STALE_INSTALLATION_STATUSES).toEqual([401, 404, 422]);
  });

  it("a fresh lookup decides: stale only if a repo moved or the App is gone from it (pure)", () => {
    expect(installationVerdict(7, [7])).toBe("same");
    expect(installationVerdict(7, [7, 7])).toBe("same");
    expect(installationVerdict(7, [8])).toBe("stale");
    expect(installationVerdict(7, [null])).toBe("stale");
    expect(installationVerdict(7, [7, 8])).toBe("stale");
  });

  it("a reinstalled App (a new installation id) mints at once from the new installation, not 502 for a day", async () => {
    const r = repo();
    await mint(r, { contents: "read" });
    const old = gh.installs.get(r)!;
    // Uninstalled and installed again: the cached id now names nothing.
    gh.installs.set(r, old + 1);
    const before = gh.mintAsks.length;
    const t = await mint(r, { checks: "read" });
    expect(gh.mintAsks.slice(before)).toEqual([old, old + 1]);
    expect(gh.mints.at(-1)).toMatchObject({ installation: old + 1, token: t.token });
    // The answer names the installation the token came from: the new one, not the cached id it first tried.
    expect(t.installation).toBe(old + 1);
    // Asked again, the cached token keeps answering that installation.
    expect(await mint(r, { checks: "read" })).toMatchObject({ token: t.token, installation: old + 1 });
    // Uninstalled outright: refused, looked up afresh, not installed. Its row is gone, so the next request
    // asks GitHub where the App is rather than minting from the dead id again.
    gh.installs.delete(r);
    expect(await refusal(r, { contents: "read", checks: "read" })).toContain("isn't installed");
    const gone = gh.mintAsks.length;
    await refusal(r, { checks: "write", contents: "read" });
    expect(gh.mintAsks.length).toBe(gone);
    gh.installs.set(r, old + 1);
    // The cache now holds the new id: the next mint goes straight there.
    const next = gh.mintAsks.length;
    await mint(r, { checks: "write" });
    expect(gh.mintAsks.slice(next)).toEqual([old + 1]);
  });

  it("a refusal from a freshly looked-up installation is final: one mint, no loop", async () => {
    const r = repo();
    gh.refuseMints = 422;
    try {
      // Nothing cached: looked up, minted once, refused.
      const a = gh.mintAsks.length;
      expect(await refusal(r, { contents: "read" })).toContain("GitHub: minting an installation token");
      expect(gh.mintAsks.length - a).toBe(1);
      // Cached now: refused, looked up afresh, still the same installation: a real refusal, one mint.
      const b = gh.mintAsks.length;
      const l = gh.lookups;
      expect(await refusal(r, { checks: "read" })).toContain("GitHub: minting an installation token");
      expect(gh.mintAsks.length - b).toBe(1);
      expect(gh.lookups - l).toBe(1);
    } finally {
      gh.refuseMints = null;
    }
  });

  it("a real refusal (a permission the App lacks) leaves another permission set's cached token in use and costs one mint", async () => {
    const r = repo();
    const t = await mint(r, { contents: "read" });
    gh.ungranted = "issues";
    try {
      const before = gh.mintAsks.length;
      expect(await refusal(r, { issues: "write" })).toContain("GitHub: minting an installation token");
      expect(gh.mintAsks.length - before).toBe(1);
      // A's token wasn't dropped: served from the cache, no mint.
      const again = gh.mintAsks.length;
      expect((await mint(r, { contents: "read" })).token).toBe(t.token);
      expect(gh.mintAsks.length).toBe(again);
    } finally {
      gh.ungranted = null;
    }
  });

  it("a real refusal confirmed by a lookup isn't looked up again for a while: repeated, it costs one GitHub call", async () => {
    const r = repo();
    await mint(r, { contents: "read" });
    gh.ungranted = "issues";
    try {
      const calls = () => gh.mintAsks.length + gh.lookups;
      // The first: the mint is refused, a lookup confirms the installation (two calls).
      let before = calls();
      expect(await refusal(r, { issues: "write" })).toContain("GitHub: minting an installation token");
      expect(calls() - before).toBe(2);
      // Again at once: the mint alone.
      before = calls();
      const lookups = gh.lookups;
      expect(await refusal(r, { issues: "write" })).toContain("GitHub: minting an installation token");
      expect(calls() - before).toBe(1);
      expect(gh.lookups).toBe(lookups);
    } finally {
      gh.ungranted = null;
    }
    // Once that lapses, a refusal is looked up again: a reinstall since is found and minted from.
    gh.installs.set(r, gh.installs.get(r)! + 1);
    const broker = env.BROKER.get(env.BROKER.idFromName("broker")) as DurableObjectStub;
    await runInDurableObject(broker, (inst: unknown) => {
      const confirmed = (inst as { confirmedInstallations: Map<string, number> }).confirmedInstallations;
      for (const k of confirmed.keys()) confirmed.set(k, Date.now() - 1);
    });
    expect((await mint(r, { issues: "write" })).token).toBe(gh.mints.at(-1)!.token);
    expect(gh.mints.at(-1)!.installation).toBe(gh.installs.get(r));
  });

  it("after a reinstall, a token cached from the old installation is never served again", async () => {
    const r = repo();
    const t = await mint(r, { contents: "read" });
    gh.installs.set(r, gh.installs.get(r)! + 1);
    // Another request finds the installation stale; the old installation's tokens go with it.
    await mint(r, { checks: "read" });
    const again = await mint(r, { contents: "read" });
    expect(again.token).not.toBe(t.token);
    expect(gh.mints.at(-1)).toMatchObject({ installation: gh.installs.get(r), token: again.token });
  });

  it("a replaced github_app never hands out the old App's cached tokens", async () => {
    const r = repo();
    const first = await mint(r, { contents: "read" });
    expect((await mint(r, { contents: "read" })).token).toBe(first.token);
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const was = await runInDurableObject(broker, (_i, st) => st.storage.sql.exec<{ value: string }>("SELECT value FROM secrets WHERE name = 'github_app'").one().value);
    const creds = JSON.parse(was) as { app_id: string; private_key: string };
    await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ ...creds, app_id: `${creds.app_id}9` }) } });
    try {
      const after = await mint(r, { contents: "read" });
      expect(after.token).not.toBe(first.token);
    } finally {
      await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: was } });
    }
  });
});

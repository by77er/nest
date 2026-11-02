// A client's GitHub App tokens (docs/control-plane/api/clients/#github-tokens): `POST
// /v1/clients/self/github-token` mints, through BrokerDO, a token for exactly the repo and permissions
// asked for, only within the client's grant, audited and never logged. A fake GitHub (as in
// repos.test.ts: a fetch handler for https://api.github.com over the global fetch BrokerDO calls)
// records every mint.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerDO } from "../src/do/broker";
import { adminJson, BASE, enrollHost, uniqueCell } from "./helpers";
import { bytesToB64 } from "../src/lib/util";

class FakeGitHub {
  /** repo (lowercase) → installation id. */
  readonly installs = new Map<string, number>();
  readonly mints: { installation: number; repositories: string[]; permissions: Record<string, string>; token: string; expires_at: string }[] = [];
  private n = 0;

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      const id = this.installs.get(m[1]!.toLowerCase());
      return id ? json(200, { id }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      const body = await req.json() as { repositories: string[]; permissions: Record<string, string> };
      const installation = Number(m[1]);
      const ok = body.repositories.every((name) => [...this.installs].some(([r, i]) => i === installation && r.endsWith(`/${name}`)));
      if (!ok) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      // Built at run time and low in entropy (review lesson 9).
      const token = `ghs_cli${String(++this.n).padStart(30, "0")}`;
      const expires_at = new Date(Date.now() + 3_600_000).toISOString();
      this.mints.push({ installation, ...body, token, expires_at });
      return json(201, { token, expires_at, permissions: body.permissions });
    }
    return json(404, { message: "Not Found" });
  }
}

const gh = new FakeGitHub();
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // Any RSA key will do: the fake doesn't check the JWT. Kept if another file stored the App already.
  const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
  const have = await runInDurableObject(broker, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = 'github_app'").one().n);
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

async function newClient(github?: Record<string, unknown>) {
  const grant = { cells: [uniqueCell()], ...(github ? { github } : {}) };
  const c = await adminJson("/v1/admin/clients", { body: { name: `g-${rand()}`, grant } }, 201);
  return { id: c.client as string, token: c.token as string };
}

const ask = (token: string | null, body: unknown) => SELF.fetch(`${BASE}/v1/clients/self/github-token`, {
  method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body),
});
async function askJson(token: string | null, body: unknown, status: number): Promise<any> {
  const res = await ask(token, body);
  const text = await res.text();
  expect(res.status, text).toBe(status);
  return JSON.parse(text);
}

async function auditTexts(): Promise<string[]> {
  const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
  return Promise.all(listed.objects.map(async (o) => (await env.BUCKET.get(o.key))!.text()));
}

describe("POST /v1/clients/self/github-token", () => {
  it("mints for exactly the repo and permissions asked for, never wider than asked; reuses per client and never shares across clients", async () => {
    const r = repo();
    const grant = { repos: [r.toUpperCase()], permissions: { checks: "write", contents: "read", administration: "write", repository_projects: "admin" } };
    const c = await newClient(grant);
    const before = gh.mints.length;
    // The repo in another case is the same repo (GitHub's names are case-insensitive); the levels may be lower than granted.
    const t = await askJson(c.token, { repo: r.toUpperCase(), permissions: { checks: "read", repository_projects: "write" } }, 200);
    const mint = gh.mints[before]!;
    expect(gh.mints.length).toBe(before + 1);
    expect(mint).toMatchObject({ installation: gh.installs.get(r), repositories: [r.split("/")[1]], permissions: { checks: "read", repository_projects: "write" } });
    expect(Object.keys(mint.permissions).sort()).toEqual(["checks", "repository_projects"]);
    expect(t).toEqual({ token: mint.token, expires_at: mint.expires_at, repo: r, permissions: { checks: "read", repository_projects: "write" } });

    // The same request again: the cached token (no mint). Other permissions: a token of their own.
    expect((await askJson(c.token, { repo: r, permissions: { repository_projects: "write", checks: "read" } }, 200)).token).toBe(mint.token);
    const admin = await askJson(c.token, { repo: r, permissions: { administration: "write" } }, 200);
    expect(gh.mints.slice(before + 1).map((m) => m.permissions)).toEqual([{ administration: "write" }]);
    expect(admin.token).not.toBe(mint.token);

    // Another client with the same grant never gets this client's token.
    const other = await newClient(grant);
    const o = await askJson(other.token, { repo: r, permissions: { checks: "read", repository_projects: "write" } }, 200);
    expect(o.token).not.toBe(mint.token);
    expect(gh.mints.length).toBe(before + 3);
  });

  it("outside the grant (repo, permission, level) is 403; a malformed request (unknown name, case, look-alikes, no permission) is 400; neither mints", async () => {
    const r = repo();
    const c = await newClient({ repos: [r], permissions: { checks: "write", contents: "read", repository_projects: "write" } });
    const before = gh.mints.length;
    const outside: [unknown, string][] = [
      [{ repo: `${r.split("/")[0]}/other`, permissions: { checks: "read" } }, `github repo ${r.split("/")[0]}/other`],
      [{ repo: `${r}x`, permissions: { checks: "read" } }, "github repo"],
      [{ repo: r, permissions: { issues: "read" } }, "github permission issues"],
      [{ repo: r, permissions: { checks: "write", contents: "write" } }, "github permission contents: write (the grant has read)"],
      [{ repo: r, permissions: { repository_projects: "admin" } }, "github permission repository_projects: admin (the grant has write)"],
    ];
    for (const [body, why] of outside) {
      const e = await askJson(c.token, body, 403);
      expect(e.error.code, JSON.stringify(body)).toBe("forbidden");
      expect(e.error.message).toContain(why);
    }
    // A client whose grant has no `github` mints nothing.
    const none = await newClient();
    expect((await askJson(none.token, { repo: r, permissions: { checks: "read" } }, 403)).error.message).toContain(`github repo ${r}`);

    const malformed: unknown[] = [
      { repo: r, permissions: {} },
      { repo: r, permissions: { Checks: "read" } },
      { repo: r, permissions: { "сhecks": "read" } }, // Cyrillic es
      { repo: r, permissions: { checks: "READ" } },
      { repo: r, permissions: { checks: "admin" } }, // GitHub offers checks only read and write
      { repo: r, permissions: { members: "read" } }, // an organization permission
      { repo: r, permissions: { workflows: "read" } }, // write only
      { repo: r, permissions: JSON.parse('{"__proto__": "read", "checks": "read"}') },
      { repo: r.replace("app", "аpp"), permissions: { checks: "read" } }, // Cyrillic a
      { repo: `${r}/`, permissions: { checks: "read" } },
      { repo: `${r.split("/")[0]}/*`, permissions: { checks: "read" } },
      { repo: r, permissions: { checks: "read" }, repositories: ["x"] },
      { repo: [r], permissions: { checks: "read" } },
    ];
    for (const body of malformed) expect((await askJson(c.token, body, 400)).error.code, JSON.stringify(body)).toBe("invalid_message");
    expect(gh.mints.length).toBe(before);
  });

  it("writes an audit record naming the client, repo, permissions and installation; a refusal by GitHub is audited too", async () => {
    const r = repo();
    const missing = `own-${rand()}/not-installed`;
    const c = await newClient({ repos: [r, missing], permissions: { statuses: "write" } });
    const t = await askJson(c.token, { repo: r, permissions: { statuses: "write" } }, 200);
    const mine = (await auditTexts()).filter((x) => x.includes(`"${c.id}"`));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]!)).toMatchObject({
      event: "github_installation_token", repos: [r], permissions: { statuses: "write" }, installation: gh.installs.get(r),
      expires_ms: Date.parse(t.expires_at), caller: { client: c.id },
    });

    expect((await askJson(c.token, { repo: missing, permissions: { statuses: "write" } }, 403)).error.message).toContain("isn't installed");
    const refused = (await auditTexts()).filter((x) => x.includes(`"${c.id}"`) && x.includes(missing));
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0]!)).toMatchObject({ caller: { client: c.id }, refused: expect.stringContaining("isn't installed") });
  });

  it("never puts the token in a log line or an audit record", async () => {
    const r = repo();
    const c = await newClient({ repos: [r], permissions: { checks: "write" } });
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const saved = methods.map((m) => console[m]);
    for (const m of methods) console[m] = (...a: unknown[]) => lines.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    let token: string;
    try {
      token = (await askJson(c.token, { repo: r, permissions: { checks: "write" } }, 200)).token;
      // GitHub's refusal too (the App was uninstalled): its error path logs nothing of the earlier token.
      gh.installs.delete(r);
      expect((await askJson(c.token, { repo: r, permissions: { checks: "read" } }, 502)).error.message).toContain("not accessible");
    } finally {
      methods.forEach((m, i) => { console[m] = saved[i]!; });
    }
    expect(token).toMatch(/^ghs_cli/);
    expect(lines.filter((l) => l.includes("ghs_cli"))).toEqual([]);
    const audits = await auditTexts();
    expect(audits.some((x) => x.includes(`"${c.id}"`))).toBe(true);
    expect(audits.filter((x) => x.includes("ghs_cli"))).toEqual([]);
  });

  it("only a client's token has a self: the operator is 403, no token or a host's token 401, a deleted client's or a rotated-out token 401; none mints", async () => {
    const r = repo();
    const body = { repo: r, permissions: { checks: "read" } };
    const before = gh.mints.length;
    expect((await askJson("test-admin-token", body, 403)).error.code).toBe("forbidden");
    expect((await askJson(null, body, 401)).error.code).toBe("unauthorized");
    const host = await enrollHost(uniqueCell(), "brain");
    expect((await askJson(host.host_token, body, 401)).error.code).toBe("unauthorized");

    const rotated = await newClient({ repos: [r], permissions: { checks: "read" } });
    await adminJson(`/v1/admin/clients/${rotated.id}/rotate`, { method: "POST" });
    expect((await askJson(rotated.token, body, 401)).error.code).toBe("unauthorized");

    const deleted = await newClient({ repos: [r], permissions: { checks: "read" } });
    await adminJson(`/v1/admin/clients/${deleted.id}`, { method: "DELETE" });
    expect((await askJson(deleted.token, body, 401)).error.code).toBe("unauthorized");
    expect(gh.mints.length).toBe(before);
  });

  it("answers a retryable 503 while BrokerDO still runs a release without the method (the minutes after a deploy)", async () => {
    const r = repo();
    const c = await newClient({ repos: [r], permissions: { checks: "read" } });
    const proto = BrokerDO.prototype as unknown as Record<string, unknown>;
    const method = proto.clientGithubToken;
    delete proto.clientGithubToken;
    try {
      const e = await askJson(c.token, { repo: r, permissions: { checks: "read" } }, 503);
      expect(e.error).toMatchObject({ code: "internal", retryable: true });
    } finally {
      proto.clientGithubToken = method;
    }
    expect((await askJson(c.token, { repo: r, permissions: { checks: "read" } }, 200)).token).toMatch(/^ghs_cli/);
  });
});

describe("BrokerDO.clientGithubToken", () => {
  it("re-checks the shape whoever calls it: no token for every permission (none named), an organization permission or a malformed repo", async () => {
    const r = repo();
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const before = gh.mints.length;
    const bad: [string, string, Record<string, string>][] = [["cli_x", r, {}], ["cli_x", r, { members: "write" }], ["cli_x", `${r}/..`, { checks: "read" }], ["agt_x", r, { checks: "read" }]];
    for (const [client, rp, perms] of bad) {
      await expect(Promise.resolve().then(() => broker.clientGithubToken(client, rp, perms as Record<string, "read">)), JSON.stringify([client, rp, perms])).rejects.toThrow(/invalid_message/);
    }
    expect(gh.mints.length).toBe(before);
  });
});

describe("a grant's github field", () => {
  it("takes only repository permissions, each at a level GitHub offers for it (admin where it does)", async () => {
    const post = (permissions: Record<string, string>, status: number) =>
      adminJson("/v1/admin/clients", { body: { name: `p-${rand()}`, grant: { github: { repos: ["a/b"], permissions } } } }, status);
    expect((await post({ repository_projects: "admin", workflows: "write", administration: "write" }, 201)).grant.github.permissions)
      .toEqual({ repository_projects: "admin", workflows: "write", administration: "write" });
    const bad: Record<string, string>[] = [{ members: "read" }, { Checks: "read" }, { checks: "admin" }, { workflows: "read" }, { checks: "none" }];
    for (const p of bad) await post(p, 400);
  });
});

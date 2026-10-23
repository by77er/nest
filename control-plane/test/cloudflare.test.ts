// The Cloudflare HTTP client (src/lib/cloudflare.ts): every request's method, path, body and auth,
// checked against a recording fetch, and the error shapes FleetDO relies on (retryable or not,
// already-gone deletes, a create without a token). The API itself is documented at
// developers.cloudflare.com/api/.
import { describe, expect, it } from "vitest";
import {
  CloudflareHttp, gatewayHostname, HOST_ID_BODY, hostOfHostname, hostOfTunnelName, hostnameSuffix, splitDomain, tunnelConfig, tunnelName,
} from "../src/lib/cloudflare";
import { NestError, newId } from "../src/lib/util";

const cfg = { token: "cf-secret-token", accountId: "acc123", domain: "nest.bitcru.sh" };
type Rec = { method: string; url: string; body: unknown; auth: string | null };
const ID = "01jb7k3x9qabcdefghjkmnpqrs";

function recorder(answers: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Rec[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const a = answers.shift();
    calls.push({
      method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(init.body as string) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (a instanceof Error) throw a;
    const status = a?.status ?? 200;
    const body = a?.body ?? { success: true, result: null };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, api: new CloudflareHttp(cfg, fetchFn, "https://cf.test/v4") };
}

const ok = (result: unknown) => ({ body: { success: true, result } });
const notFound = { status: 404, body: { success: false, errors: [{ code: 81044, message: "Record does not exist." }] } };

describe("names", () => {
  it("derives the label and zone, the tunnel name and the hostname from NEST_DOMAIN and the host id", () => {
    expect(splitDomain("nest.bitcru.sh")).toEqual({ label: "nest", zone: "bitcru.sh" });
    expect(() => splitDomain("nest")).toThrow();
    expect(() => splitDomain(".bitcru.sh")).toThrow();
    expect(tunnelName("nest", `hst_${ID}`)).toBe(`nest-${ID}`);
    expect(gatewayHostname("nest", "bitcru.sh", `hst_${ID}`)).toBe(`${ID}-gw-nest.bitcru.sh`);
    expect(hostnameSuffix("nest", "bitcru.sh")).toBe("-gw-nest.bitcru.sh");
  });

  it("recognises only nest's own names, with a real host id, when reading the account back", () => {
    expect(HOST_ID_BODY.test(newId("").slice(0))).toBe(true);
    expect(hostOfTunnelName("nest", `nest-${ID}`)).toBe(`hst_${ID}`);
    expect(hostOfTunnelName("nest", `nest-${ID.slice(1)}`), "25 characters").toBeNull();
    expect(hostOfTunnelName("nest", `nest-${ID}0`), "27 characters").toBeNull();
    expect(hostOfTunnelName("nest", `nest-${ID.slice(0, 25)}i`), "not Crockford").toBeNull();
    expect(hostOfTunnelName("nest", `nest-${ID.toUpperCase()}`)).toBeNull();
    expect(hostOfTunnelName("nest", "nest-laptop")).toBeNull();
    expect(hostOfTunnelName("nest", "nest-")).toBeNull();
    expect(hostOfTunnelName("nest", "bitty")).toBeNull();
    expect(hostOfTunnelName("nest", "rollout")).toBeNull();
    expect(hostOfTunnelName("nest", `nest2-${ID}`)).toBeNull();
    expect(hostOfHostname("nest", "bitcru.sh", `${ID}-gw-nest.bitcru.sh`)).toBe(`hst_${ID}`);
    expect(hostOfHostname("nest", "bitcru.sh", "demo-gw-nest.bitcru.sh")).toBeNull();
    expect(hostOfHostname("nest", "bitcru.sh", "nest.bitcru.sh")).toBeNull();
    expect(hostOfHostname("nest", "bitcru.sh", "-gw-nest.bitcru.sh")).toBeNull();
    expect(hostOfHostname("nest", "bitcru.sh", "8080-sbx1-preview-nest.bitcru.sh")).toBeNull();
    expect(hostOfHostname("nest", "bitcru.sh", `${ID}-gw-nest.other.sh`)).toBeNull();
  });

  it("is configured only when the token, the account and the domain are all set", () => {
    expect(tunnelConfig({ CLOUDFLARE_TUNNEL_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a", NEST_DOMAIN: "nest.bitcru.sh" }))
      .toEqual({ token: "t", accountId: "a", domain: "nest.bitcru.sh" });
    expect(tunnelConfig({ CLOUDFLARE_TUNNEL_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "a" })).toBeNull();
    expect(tunnelConfig({ NEST_DOMAIN: "nest.bitcru.sh", CLOUDFLARE_ACCOUNT_ID: "a" })).toBeNull();
    expect(tunnelConfig({})).toBeNull();
  });
});

describe("requests", () => {
  it("looks a zone up by name and refuses a different one", async () => {
    const r = recorder([ok([{ id: "z1", name: "bitcru.sh" }]), ok([{ id: "z2", name: "bitcru.sh.example" }])]);
    expect(await r.api.zoneId("bitcru.sh")).toBe("z1");
    expect(r.calls[0]).toMatchObject({ method: "GET", url: "https://cf.test/v4/zones?name=bitcru.sh", auth: "Bearer cf-secret-token" });
    await expect(r.api.zoneId("bitcru.sh")).rejects.toThrow(/not on this account/);
  });

  it("creates a remotely managed tunnel and returns its token; a tunnel without a token is an error", async () => {
    const r = recorder([ok({ id: "t1", token: "eyJ.tok", name: "nest-01abc", other: "ignored" }), ok({ id: "t2", name: "nest-01abd" })]);
    expect(await r.api.createTunnel("nest-01abc")).toEqual({ id: "t1", token: "eyJ.tok" });
    expect(r.calls[0]).toMatchObject({
      method: "POST", url: "https://cf.test/v4/accounts/acc123/cfd_tunnel", body: { name: "nest-01abc", config_src: "cloudflare" },
    });
    await expect(r.api.createTunnel("nest-01abd")).rejects.toThrow(/t2 was created without a token/);
  });

  it("routes the hostname to the gateway on loopback and everything else to 404", async () => {
    const r = recorder([ok({})]);
    await r.api.configureIngress("t1", "01abc-gw-nest.bitcru.sh");
    expect(r.calls[0]).toMatchObject({
      method: "PUT", url: "https://cf.test/v4/accounts/acc123/cfd_tunnel/t1/configurations",
      body: { config: { ingress: [{ hostname: "01abc-gw-nest.bitcru.sh", service: "http://127.0.0.1:18790" }, { service: "http_status:404" }] } },
    });
  });

  it("creates a proxied CNAME to the tunnel, also when the envelope has no `success` field", async () => {
    const r = recorder([ok({ id: "r1" }), { body: { result: { id: "r2" } } }]);
    expect(await r.api.createRecord("z1", "01abc-gw-nest.bitcru.sh", "t1", "nest hst_01abc")).toEqual({ id: "r1" });
    expect(r.calls[0]).toMatchObject({
      method: "POST", url: "https://cf.test/v4/zones/z1/dns_records",
      body: { type: "CNAME", name: "01abc-gw-nest.bitcru.sh", content: "t1.cfargotunnel.com", proxied: true, ttl: 1, comment: "nest hst_01abc" },
    });
    expect(await r.api.createRecord("z1", "01abd-gw-nest.bitcru.sh", "t2", "nest hst_01abd")).toEqual({ id: "r2" });
  });

  it("deletes a tunnel after cleaning its connections; a failed cleanup does not stop the delete", async () => {
    const r = recorder([{ status: 400, body: { success: false, errors: [{ code: 1000, message: "nothing to clean" }] } }, ok(null)]);
    await r.api.deleteTunnel("t1");
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "DELETE https://cf.test/v4/accounts/acc123/cfd_tunnel/t1/connections",
      "DELETE https://cf.test/v4/accounts/acc123/cfd_tunnel/t1",
    ]);
    // Refused while connections are active: retryable, so the sweep comes back to it.
    const busy = recorder([ok(null), { status: 400, body: { success: false, errors: [{ code: 1012, message: "tunnel has active connections" }] } }]);
    await expect(busy.api.deleteTunnel("t1")).rejects.toMatchObject({ retryable: true, message: /1012: tunnel has active connections/ });
  });

  it("deletes a record; deleting what is already gone is done, not an error", async () => {
    const r = recorder([{ body: { result: { id: "r1" } } }, notFound, notFound, notFound]);
    await r.api.deleteRecord("z1", "r1");
    expect(r.calls[0]).toMatchObject({ method: "DELETE", url: "https://cf.test/v4/zones/z1/dns_records/r1" });
    await expect(r.api.deleteRecord("z1", "r-gone")).resolves.toBeUndefined();
    await expect(r.api.deleteTunnel("t-gone")).resolves.toBeUndefined();
    // Only deletes forgive a 404.
    const create = recorder([notFound]);
    await expect(create.api.createRecord("z-gone", "x", "t", "c")).rejects.toMatchObject({ retryable: false, message: /HTTP 404/ });
  });

  it("lists tunnels by name prefix and records by hostname suffix, filtering what the API returns", async () => {
    const r = recorder([
      ok([{ id: "a", name: "nest-01abc" }, { id: "b", name: "bitty" }, { id: "c", name: "nest-01def" }]),
      ok([{ id: "x", name: "01abc-gw-nest.bitcru.sh", type: "CNAME" }, { id: "y", name: "bitty.bitcru.sh", type: "CNAME" }]),
    ]);
    expect(await r.api.listTunnels("nest-")).toEqual([{ id: "a", name: "nest-01abc" }, { id: "c", name: "nest-01def" }]);
    expect(r.calls[0]!.url).toBe("https://cf.test/v4/accounts/acc123/cfd_tunnel?is_deleted=false&per_page=100&page=1");
    expect(await r.api.listRecords("z1", "-gw-nest.bitcru.sh")).toEqual([{ id: "x", name: "01abc-gw-nest.bitcru.sh" }]);
    expect(r.calls[1]!.url).toBe("https://cf.test/v4/zones/z1/dns_records?type=CNAME&name.endswith=-gw-nest.bitcru.sh&per_page=100&page=1");
  });

  it("follows pages while a page is full", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, name: `nest-${i.toString(36).padStart(5, "0")}` }));
    const r = recorder([ok(full), ok([{ id: "last", name: "nest-zzzzz" }])]);
    expect((await r.api.listTunnels("nest-")).length).toBe(101);
    expect(r.calls.map((c) => c.url.slice(-6))).toEqual(["page=1", "page=2"]);
  });
});

describe("errors", () => {
  it("reports Cloudflare's error codes; 429 and 5xx are retryable, a 4xx is not", async () => {
    const r = recorder([
      { status: 403, body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
      { status: 429, body: { success: false, errors: [{ code: 971, message: "rate limited" }] } },
      { status: 502, body: "<html>bad gateway</html>" },
      { status: 200, body: { success: false, errors: [{ message: "odd" }] } },
      { status: 200, body: "not json at all" },
    ]);
    await expect(r.api.createTunnel("nest-x")).rejects.toMatchObject({ status: 502, retryable: false, message: /HTTP 403 \(10000: Authentication error\)/ });
    await expect(r.api.createTunnel("nest-x")).rejects.toMatchObject({ retryable: true, message: /HTTP 429/ });
    await expect(r.api.createTunnel("nest-x")).rejects.toMatchObject({ retryable: true, message: /HTTP 502$/ });
    await expect(r.api.createTunnel("nest-x")).rejects.toMatchObject({ retryable: false, message: /HTTP 200 \(odd\)/ });
    await expect(r.api.createTunnel("nest-x")).rejects.toMatchObject({ retryable: false, message: /HTTP 200$/ });
  });

  it("a network failure is a retryable 502 and the token never appears in a URL or message", async () => {
    const r = recorder([new TypeError("fetch failed")]);
    const err = (await r.api.createTunnel("nest-x").catch((e: unknown) => e)) as { message: string; retryable: boolean; status: number };
    expect(err).toMatchObject({ status: 502, retryable: true, message: /fetch failed/ });
    expect(err.message).not.toContain(cfg.token);
    expect(r.calls[0]!.url).not.toContain(cfg.token);
  });
});

describe("the default fetch under workerd", () => {
  it("the default fetch works under workerd (no incorrect `this`: Illegal invocation)", async () => {
    // Every other test injects a fake fetch, which binds nothing; the live Worker calls the
    // platform's fetch, which throws "Illegal invocation" when invoked as a method of another
    // object, before any network. Nothing listens at the discard port, so a fetch that was
    // invoked correctly fails on the connection instead, and the client reports that as retryable.
    const api = new CloudflareHttp({ token: "t", accountId: "acc", domain: "nest.bitcru.sh" }, undefined, "http://127.0.0.1:9/v4");
    const err = await api.zoneId("bitcru.sh").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NestError);
    expect((err as Error).message).not.toMatch(/Illegal invocation/);
    expect((err as Error).message).toMatch(/cloudflare GET \/zones\?name=bitcru\.sh: /);
  });
});

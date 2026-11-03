// The page's Content-Security-Policy (src/csp.ts): sent on HTML, with scripts, connections and fonts only
// from the app, images only from it or data:, no framing, no base, no plugins; and not on the API.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { contentSecurityPolicy, withCsp } from "../src/csp";
import { AccessTeam, APP, FakeNest, installFetch } from "./fake-nest";

const directives = (csp: string): Record<string, string[]> => Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));

describe("the CSP", () => {
  it("allows scripts, connections and fonts only from the app, and nothing to frame it", () => {
    const d = directives(contentSecurityPolicy(new URL("https://projects-nest.bitcru.sh/projects")));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'self'", "wss://projects-nest.bitcru.sh"]);
    expect(d["img-src"]).toEqual(["'self'", "data:"]);
    expect(d["font-src"]).toEqual(["'self'", "data:"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    // Nothing remote anywhere: no host but the app's own WebSocket.
    expect(Object.values(d).flat().filter((v) => /^(https?:|wss?:|\*)/.test(v))).toEqual(["wss://projects-nest.bitcru.sh"]);
  });

  it("goes on pages only", async () => {
    const url = new URL("https://projects.test/");
    expect(withCsp(new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8" } }), url).headers.get("content-security-policy")).toBe(contentSecurityPolicy(url));
    expect(withCsp(new Response("{}", { headers: { "content-type": "application/json" } }), url).headers.get("content-security-policy")).toBeNull();
  });
});

describe("the Worker", () => {
  const fake = new FakeNest();
  let restore: () => void;
  let token: string;
  beforeAll(async () => {
    const team = await AccessTeam.create();
    const certs = await team.certs();
    restore = installFetch(fake, () => certs);
    resetAccessKeys();
    token = await team.token();
  });
  afterAll(() => restore());

  it("sends the policy with the page, after the Access check", async () => {
    const res = await SELF.fetch(`${APP}/projects`, { headers: { "cf-access-jwt-assertion": token } });
    const type = res.headers.get("content-type") ?? "";
    // The page itself, from the assets (an SPA: any path is index.html).
    expect(res.status, type).toBe(200);
    expect(type).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBe(contentSecurityPolicy(new URL(`${APP}/projects`)));
    await res.text();
  });

  it("doesn't send it with the API's JSON", async () => {
    const res = await SELF.fetch(`${APP}/api/projects`, { headers: { "cf-access-jwt-assertion": token } });
    expect(res.headers.get("content-security-policy")).toBeNull();
  });
});

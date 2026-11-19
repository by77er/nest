// What the browser may keep of the page's files (src/asset-cache.ts, README.md#the-ui): the files `vite build`
// names by their content for a year, everything else revalidated, and the security headers on all of them.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { assetCacheControl, IMMUTABLE, REVALIDATE } from "../src/asset-cache";
import { CSP } from "../src/csp";
import worker from "../src/worker";
import { AccessTeam, APP, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let team: AccessTeam;
let token: string;

beforeAll(async () => {
  team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

const JS = "text/javascript; charset=utf-8";
const HTML = "text/html; charset=utf-8";

describe("assetCacheControl", () => {
  it("keeps a hashed build file's 200 for a year, privately", () => {
    // Names `vite build` wrote (dist/client/assets/, listed in the PR): a hash may itself hold `-` or `_`.
    for (const path of [
      "/assets/index-CqelrehK.js",
      "/assets/react-9-62sbiC.js",
      "/assets/DescriptionField-4DiGbNJv.css",
      "/assets/katex-DEcVZfaU.css",
      "/assets/KaTeX_Math-Italic-DA0__PXp.woff",
      "/assets/KaTeX_AMS-Regular-BQhdFMY1.woff2",
      "/assets/KaTeX_Main-Regular-ypZvNtVU.ttf",
      "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
    ]) {
      expect(assetCacheControl(path, 200, path.endsWith(".js") ? JS : "application/octet-stream"), path).toBe(IMMUTABLE);
    }
    expect(IMMUTABLE).toBe("private, max-age=31536000, immutable");
  });

  it("revalidates index.html, the navigation paths, the unhashed files and anything outside /assets/", () => {
    for (const path of ["/", "/index.html", "/projects", "/projects/prj_abc/board", "/scheme.js", "/index-CqelrehK.js", "/assets/sub/index-CqelrehK.js", "/assets/index.js", "/assets/index-short.js"]) {
      expect(assetCacheControl(path, 200, path.endsWith(".js") ? JS : HTML), path).toBe(REVALIDATE);
    }
    expect(REVALIDATE).toBe("no-cache");
  });

  it("never keeps a hashed path's answer that isn't a 200 with the file", () => {
    const path = "/assets/index-CqelrehK.js";
    for (const status of [304, 404, 206, 500]) expect(assetCacheControl(path, status, JS), String(status)).toBe(REVALIDATE);
    // The single-page fallback: a chunk a deploy removed is answered with index.html and a 200.
    expect(assetCacheControl(path, 200, HTML)).toBe(REVALIDATE);
    expect(assetCacheControl(path, 200, "TEXT/HTML")).toBe(REVALIDATE);
  });
});

describe("the Worker's asset answers", () => {
  /** A stand-in for Workers Assets (the test pool has none): its files, index.html for any other path (single-page-application), a 304 when asked with the ETag. */
  function assets() {
    const files: Record<string, string> = { "/assets/index-CqelrehK.js": JS, "/scheme.js": JS, "/index.html": HTML };
    const asked: string[] = [];
    const fetcher = {
      fetch: async (req: Request) => {
        const path = new URL(req.url).pathname;
        asked.push(path);
        const type = files[path] ?? HTML;
        const headers = { "content-type": type, etag: `"${path}"`, "cache-control": "public, max-age=0, must-revalidate" };
        if (req.headers.get("if-none-match") === `"${path}"`) return new Response(null, { status: 304, headers });
        return new Response(type === HTML ? "<!doctype html>" : "export {}", { headers });
      },
    };
    return { fetcher, asked };
  }

  async function get(path: string, headers: Record<string, string> = { "cf-access-jwt-assertion": token }) {
    const a = assets();
    const req = new Request(`${APP}${path}`, { headers });
    const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], { ...env, ASSETS: a.fetcher } as unknown as Parameters<typeof worker.fetch>[1]);
    return { res, asked: a.asked };
  }

  const secured = (res: Response) => {
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  };

  it("serves a hashed file as immutable, and the page, a deep link and /scheme.js revalidated, all with the security headers", async () => {
    const cases: [string, string, string][] = [
      ["/assets/index-CqelrehK.js", JS, IMMUTABLE],
      ["/", HTML, REVALIDATE],
      ["/projects/prj_abc/board?task=tsk_abc", HTML, REVALIDATE],
      ["/scheme.js", JS, REVALIDATE],
    ];
    for (const [path, type, cache] of cases) {
      const { res } = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toBe(type);
      expect(res.headers.get("cache-control"), path).toBe(cache);
      secured(res);
    }
  });

  it("doesn't keep a 304 or a removed chunk's fallback page", async () => {
    const notModified = await get("/assets/index-CqelrehK.js", { "cf-access-jwt-assertion": token, "if-none-match": `"/assets/index-CqelrehK.js"` });
    expect(notModified.res.status).toBe(304);
    expect(notModified.res.headers.get("cache-control")).toBe(REVALIDATE);
    secured(notModified.res);
    const gone = await get("/assets/index-Gone1234.js");
    expect(gone.res.status).toBe(200);
    expect(gone.res.headers.get("content-type")).toBe(HTML);
    expect(gone.res.headers.get("cache-control")).toBe(REVALIDATE);
  });

  it("checks Access first: no token, no asset (not even a hashed one)", async () => {
    const { res, asked } = await get("/assets/index-CqelrehK.js", {});
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(asked).toEqual([]);
  });
});

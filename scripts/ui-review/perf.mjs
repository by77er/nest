#!/usr/bin/env node
// The projects app's performance harness (README.md#perfmjs): loads every page and plays every main flow
// against a built client served statically, with the API answered from large generated fixtures
// (perf-fixtures.mjs) and the agents' traces from a routed WebSocket, under CDP CPU throttling. For each
// page and flow it reports requests and bytes by type, API traffic per idle minute, time to the page's
// content, long tasks, and the renderer's script, layout and style time. Exits non-zero only on a harness
// error (2), never on slow numbers.
//
//   node scripts/ui-review/perf.mjs <out-dir> (--dist DIR | --base-url URL) [--shape summary|full] [--cpu 4]
//        [--rate 20] [--idle 15] [--api-ms 40] [--assets worker|workers-assets] [--only a,b] [--label NAME] [--commit SHA] [--compare other.json]
//   node scripts/ui-review/perf.mjs --compare before.json after.json

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { perfData } from "./perf-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const die = (msg) => {
  console.error(`perf: ${msg}`);
  process.exit(2);
};

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string" },
    dist: { type: "string" },
    shape: { type: "string", default: "summary" },
    cpu: { type: "string", default: "4" },
    rate: { type: "string", default: "20" },
    idle: { type: "string", default: "15" },
    "api-ms": { type: "string", default: "40" },
    assets: { type: "string", default: "worker" },
    only: { type: "string" },
    label: { type: "string" },
    commit: { type: "string" },
    seed: { type: "string", default: "1" },
    compare: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
const USAGE = "usage: perf.mjs <out-dir> (--dist DIR | --base-url URL) [--shape summary|full] [--cpu 4] [--rate 20] [--idle 15] [--api-ms 40] [--assets worker|workers-assets] [--only a,b] [--label NAME] [--commit SHA] [--compare other.json]\n       perf.mjs --compare before.json after.json";
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

// --- results: the headline numbers, Markdown tables, and before/after ------------------------------------

const kb = (b) => (b === null || b === undefined ? "–" : b >= 1_048_576 ? `${(b / 1_048_576).toFixed(2)} MB` : `${(b / 1024).toFixed(b < 10_240 ? 1 : 0)} KB`);
const ms = (x) => (x === null || x === undefined ? "–" : `${Math.round(x)} ms`);
const num = (x) => (x === null || x === undefined ? "–" : String(Math.round(x * 10) / 10));

/** The numbers a table shows per row, and how to print each: [key, title, format]. */
const HEADLINE = [
  ["content", "to content", ms],
  ["requests", "requests", num],
  ["bytes", "transferred", kb],
  ["apiBytes", "API bytes", kb],
  ["apiRaw", "API decoded", kb],
  ["longCount", "long tasks", num],
  ["longTotal", "long total", ms],
  ["longMax", "long max", ms],
  ["script", "script", ms],
  ["layoutStyle", "layout+style", ms],
  ["idleApiReq", "API req/idle min", num],
  ["idleApiBytes", "API bytes/idle min", kb],
  ["keyMax", "worst key→paint", ms],
];

function headline(w) {
  return {
    content: w.content,
    requests: w.net.total.requests,
    bytes: w.net.total.bytes,
    apiBytes: w.net.api.bytes,
    apiRaw: w.net.api.raw,
    longCount: w.long.count,
    longTotal: w.long.total,
    longMax: w.long.max,
    script: w.cdp.script,
    layoutStyle: w.cdp.layout + w.cdp.style,
    idleApiReq: w.idle?.apiRequestsPerMin ?? null,
    idleApiBytes: w.idle?.apiBytesPerMin ?? null,
    keyMax: w.keys?.max ?? null,
  };
}

function rows(report) {
  const out = [];
  for (const s of report.scenarios) {
    if (s.error) out.push({ id: `${s.name}`, error: s.error });
    for (const w of s.windows ?? []) out.push({ id: `${s.name} · ${w.name}`, selector: w.selector, h: headline(w) });
  }
  return out;
}

function markdown(report) {
  const head = `| page / flow | ${HEADLINE.map(([, t]) => t).join(" | ")} |\n|---|${HEADLINE.map(() => "---:").join("|")}|`;
  const body = rows(report).map((r) => (r.error ? `| ${r.id} | error: ${r.error.replace(/\|/g, "/")} |` : `| ${r.id} | ${HEADLINE.map(([k, , f]) => f(r.h[k])).join(" | ")} |`));
  return [
    `# projects perf: ${report.label}`,
    "",
    `Commit ${report.commit ?? "?"} · CPU ${report.cpu}× · API shape \`${report.shape}\` · API latency ${report.apiMs} ms · assets cached as \`${report.assets ?? "?"}\` · trace stream ${report.rate} events/s · idle window ${report.idleSeconds} s · ${report.at}`,
    "",
    head,
    ...body,
    "",
    "Content selectors: " + [...new Set(rows(report).filter((r) => r.selector).map((r) => `${r.id.split(" · ")[0]} \`${r.selector}\``))].join("; "),
    "",
  ].join("\n");
}

function compare(before, after) {
  const a = new Map(rows(before).map((r) => [r.id, r]));
  const keys = [["content", ms], ["requests", num], ["bytes", kb], ["longTotal", ms], ["script", ms], ["idleApiBytes", kb], ["keyMax", ms]];
  const title = Object.fromEntries(HEADLINE.map(([k, t]) => [k, t]));
  const lines = [
    `Before: ${before.label} (${before.commit ?? "?"}, CPU ${before.cpu}×, shape ${before.shape}) · after: ${after.label} (${after.commit ?? "?"}, CPU ${after.cpu}×, shape ${after.shape})`,
    "",
    `| page / flow | ${keys.map(([k]) => `${title[k]} before → after`).join(" | ")} |`,
    `|---|${keys.map(() => "---:").join("|")}|`,
  ];
  for (const r of rows(after)) {
    const b = a.get(r.id);
    if (r.error || !b || b.error) {
      lines.push(`| ${r.id} | ${r.error ? `error: ${r.error.replace(/\|/g, "/")}` : b?.error ? `before: error` : "new"} |`);
      continue;
    }
    lines.push(`| ${r.id} | ${keys.map(([k, f]) => {
      const x = b.h[k];
      const y = r.h[k];
      if (x === null && y === null) return "–";
      const d = x && y !== null ? Math.round(((y - x) / x) * 100) : null;
      return `${f(x)} → ${f(y)}${d === null ? "" : ` (${d > 0 ? "+" : ""}${d}%)`}`;
    }).join(" | ")} |`);
  }
  const seen = new Set(rows(after).map((r) => r.id));
  for (const r of rows(before)) if (!seen.has(r.id)) lines.push(`| ${r.id} | only before |`);
  return lines.join("\n") + "\n";
}

// `--compare before.json after.json`: a table only, nothing run.
if (opt.compare && positionals.length === 1 && positionals[0].endsWith(".json") && !opt.dist && !opt["base-url"]) {
  const [x, y] = [opt.compare, positionals[0]].map((p) => JSON.parse(readFileSync(p, "utf8")));
  process.stdout.write(compare(x, y));
  process.exit(0);
}

if (positionals.length !== 1) die(USAGE);
const out = resolve(positionals[0]);
if (out === REPO || out.startsWith(REPO + "/")) die(`write the output outside the repo, not ${out}`);
if (!opt.dist === !opt["base-url"]) die("give one of --dist (a built client, served here) or --base-url (a server of it)");
if (!["summary", "full"].includes(opt.shape)) die("--shape is summary (main since #308) or full (before it)");
if (!["worker", "workers-assets"].includes(opt.assets)) die("--assets is worker (asset-cache.ts, main since #318) or workers-assets (before it)");
const CPU = Number(opt.cpu);
const RATE = Number(opt.rate);
const IDLE = Number(opt.idle);
const API_MS = Number(opt["api-ms"]);
if (!(CPU >= 1) || !(RATE > 0) || !(IDLE >= 1) || !(API_MS >= 0)) die("--cpu, --rate, --idle and --api-ms are numbers (cpu at least 1)");
mkdirSync(out, { recursive: true });

// --- the built client, served as the app's Worker serves it ------------------------------------------------
// A path that isn't a file gets index.html (single-page-application); every answer has an ETag (a matching
// If-None-Match is a 304), and text is compressed (br, else gzip) as Cloudflare does. `--assets worker`
// (the default) caches as projects/src/asset-cache.ts does since #318: a content-hashed /assets/ file's 200
// or 304 `private, max-age=31536000, immutable`, everything else `no-cache`. `--assets workers-assets`
// is Workers Assets' own `public, max-age=0, must-revalidate` on everything, as before #318.

/** A file `vite build` named by its content (asset-cache.ts's HASHED). */
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;
function cacheControl(path, status, type) {
  if (opt.assets === "workers-assets") return "public, max-age=0, must-revalidate";
  const immutable = (status === 200 || status === 304) && HASHED.test(path) && !/^text\/html\b/.test(type);
  return immutable ? "private, max-age=31536000, immutable" : "no-cache";
}

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
function serveDist(dir) {
  const root = resolve(dir);
  if (!existsSync(join(root, "index.html"))) die(`${root} has no index.html: build the client first (npm run build in projects/)`);
  // Every file read and compressed before the first request (compressing on demand would bill it to the first page).
  const files = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const raw = readFileSync(p);
        const type = TYPES[extname(p)] ?? "application/octet-stream";
        const text = /^(text|application\/(json|manifest)|image\/svg)/.test(type);
        files.set(p, { raw, type, etag: `"${createHash("sha256").update(raw).digest("hex").slice(0, 32)}"`, br: text ? brotliCompressSync(raw) : null, gz: text ? gzipSync(raw) : null });
      }
    }
  };
  walk(root);
  const load = (p) => files.get(p) ?? files.get(join(root, "index.html"));
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let p = join(root, path);
    if (!p.startsWith(root) || !files.has(p)) p = join(root, "index.html");
    const f = load(p);
    const status = req.headers["if-none-match"] === f.etag ? 304 : 200;
    const headers = { "content-type": f.type, etag: f.etag, "cache-control": cacheControl(path, status, f.type) };
    if (status === 304) {
      res.writeHead(304, headers);
      return res.end();
    }
    const enc = String(req.headers["accept-encoding"] ?? "");
    let body = f.raw;
    if (f.br && /\bbr\b/.test(enc)) [body, headers["content-encoding"]] = [f.br, "br"];
    else if (f.gz && /\bgzip\b/.test(enc)) [body, headers["content-encoding"]] = [f.gz, "gzip"];
    headers["content-length"] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let base = opt["base-url"]?.replace(/\/$/, "");
let server = null;
if (opt.dist) ({ server, base } = await serveDist(opt.dist));
try {
  const r = await fetch(base + "/projects");
  if (!r.ok) die(`${base}/projects answered ${r.status}`);
} catch (e) {
  die(`${base} can't be reached (${e.message})`);
}

// --- in the page: long tasks, content shown, key-to-paint ------------------------------------------------

/** Installed before the app's scripts: long tasks (from the start), and when the content selector shows. */
function pageProbe(content) {
  const perf = (window.__perf = { long: [], contentAt: null, keys: [] });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) perf.long.push([e.startTime, e.duration]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  /** When `sel` is first shown (in the DOM with a size), by `performance.now()`, polled every frame. */
  perf.shown = (sel, timeout = 60_000) =>
    new Promise((ok) => {
      const t0 = performance.now();
      const tick = () => {
        const el = document.querySelector(sel);
        const r = el?.getBoundingClientRect();
        if (r && r.height > 0 && r.width > 0) return ok(performance.now());
        if (performance.now() - t0 > timeout) return ok(null);
        requestAnimationFrame(tick);
      };
      tick();
    });
  if (content) perf.first = perf.shown(content);
  perf.h1 = perf.shown("h1");
  // Each key: from its keydown to the frame after it is painted (the next frame's rAF, then a task after it).
  addEventListener(
    "keydown",
    (e) => {
      const t = e.timeStamp;
      requestAnimationFrame(() => setTimeout(() => perf.keys.push(performance.now() - t), 0));
    },
    true,
  );
}

// --- one scenario: its own browser and context, the fixtures, throttling, and windows measured ----------

async function run(sc) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const fx = perfData({ seed: Number(opt.seed), shape: opt.shape });
  const ledger = []; // every response: { at, type, bytes, cached, status }
  const errors = [];
  const sockets = new Set();

  // The agents' traces (routeWebSocket, as selftest.mjs does): the history offer, the 1,000-event
  // backlog, `live`; then the live stream when a flow starts it.
  await context.routeWebSocket(/\/api\/agents\/[^/]+\/trace/, (ws) => {
    const agent = decodeURIComponent(new URL(ws.url()).pathname.split("/")[3]);
    const t = fx.trace(agent);
    const after = Number(new URL(ws.url()).searchParams.get("after") ?? 0);
    const send = (m) => {
      const s = JSON.stringify(m);
      ledger.push({ at: Date.now(), type: "ws", bytes: Buffer.byteLength(s), cached: false, status: 101 });
      ws.send(s);
    };
    const sock = { agent, send, t, sent: t.backlog.length };
    sockets.add(sock);
    ws.onClose(() => sockets.delete(sock));
    ws.onMessage((m) => m === "ping" && ws.send("pong"));
    send(t.history.offer);
    for (const e of t.backlog) if (e.seq > after) send(e);
    send({ type: "live" });
  });

  const page = await context.newPage();
  await page.addInitScript(pageProbe, sc.content ?? null);
  page.on("pageerror", (e) => errors.push(e.message));
  const cdp = await context.newCDPSession(page);
  await setup(cdp, page, fx, ledger);

  const windows = [];
  const ctx = {
    page,
    cdp,
    base,
    sockets,
    /** Measures `fn` as one window: what the network, the main thread and the renderer did during it. */
    async window(name, fn, o = {}) {
      const before = await snapshot(ctx.page, ctx.cdp, ledger);
      const extra = (await fn()) ?? {};
      const after = await snapshot(ctx.page, ctx.cdp, ledger);
      const w = diff(name, before, after, ledger);
      Object.assign(w, extra);
      if (o.idleSeconds) {
        w.idle = { seconds: o.idleSeconds, apiRequestsPerMin: (w.net.api.requests * 60) / o.idleSeconds, apiBytesPerMin: (w.net.api.bytes * 60) / o.idleSeconds, wsBytesPerMin: (w.net.ws.bytes * 60) / o.idleSeconds, api304: w.net.api.notModified };
      }
      windows.push(w);
      return w;
    },
    /** Streams the live trace to every open socket at `--rate` events/s for `seconds`. */
    async stream(seconds) {
      const n = Math.round(RATE * seconds);
      const every = 1000 / RATE;
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        for (const s of sockets) {
          const e = s.t.live[(s.sent - s.t.backlog.length) % s.t.live.length];
          s.sent++;
          s.send({ ...e, seq: s.sent });
        }
        const wait = t0 + (i + 1) * every - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    },
    /** The time from now (in the page) until `sel` shows. */
    async until(sel, act) {
      const page = ctx.page;
      const t0 = await page.evaluate(() => performance.now());
      let failed = null;
      const shown = page.evaluate((s) => window.__perf.shown(s), sel).catch((e) => {
        failed = e;
        return null;
      });
      await act();
      const t1 = await shown;
      if (failed) throw new Error(`waiting for ${sel}: ${failed.message.split("\n")[0]}`);
      if (t1 === null) throw new Error(`${sel} didn't show within 60 s`);
      return t1 - t0;
    },
    /** A fresh page in the same context (its HTTP cache warm), probed and throttled the same way. */
    async newPage() {
      const p = await context.newPage();
      await p.addInitScript(pageProbe, sc.content ?? null);
      p.on("pageerror", (e) => errors.push(e.message));
      const c = await context.newCDPSession(p);
      await setup(c, p, fx, ledger);
      ctx.page = p;
      ctx.cdp = c;
      return p;
    },
  };

  let error = null;
  try {
    await sc.run(ctx);
  } catch (e) {
    error = e.message.split("\n")[0];
    // What the page showed when it failed, for whoever fixes the scenario.
    await ctx.page.screenshot({ path: join(out, `${sc.name}-error.png`) }).catch(() => {});
    await ctx.page.evaluate(() => document.body.outerHTML).then((h) => writeFileSync(join(out, `${sc.name}-error.html`), h)).catch(() => {});
  }
  await browser.close();
  // The app throwing (a fixture whose shape drifted from the API, say) makes the numbers meaningless.
  if (!error && errors.length) error = `the page threw: ${errors[0].slice(0, 200)}`;
  return { name: sc.name, kind: sc.kind, windows, ...(error ? { error } : {}), pageErrors: [...new Set(errors)].slice(0, 5) };
}

/** Throttles the page's CPU, records the network, and answers the API from the fixtures. */
async function setup(cdp, page, fx, ledger) {
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  await cdp.send("Network.enable");
  // Everything not the API (the document, scripts, styles, fonts) as the network delivered it.
  const reqs = new Map();
  cdp.on("Network.responseReceived", (e) => {
    if (new URL(e.response.url).pathname.startsWith("/api/") || e.response.url.startsWith("data:")) return;
    const type = { Document: "document", Script: "script", Stylesheet: "style", Font: "font" }[e.type] ?? "other";
    const cached = !!(e.response.fromDiskCache || e.response.fromMemoryCache || e.response.fromPrefetchCache);
    // What had arrived by the response's start is its headers: taken off, so bytes are bodies only.
    reqs.set(e.requestId, { type, cached, status: e.response.status, headers: e.response.encodedDataLength ?? 0 });
  });
  cdp.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (!r) return;
    reqs.delete(e.requestId);
    const bytes = r.cached ? 0 : Math.max(0, e.encodedDataLength - r.headers);
    ledger.push({ at: Date.now(), type: r.type, bytes, cached: r.cached, status: r.status });
  });
  // The API: CDP's Fetch interception for /api/ only. (page.route would do it too, but Playwright turns the
  // HTTP cache off whenever it routes, and the warm loads need it.) Each answer waits --api-ms, as a Worker's
  // round trip would, and counts its body as Cloudflare would send it (gzip).
  const gz = new Map();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/*", requestStage: "Request" }] });
  cdp.on("Fetch.requestPaused", async (e) => {
    const url = new URL(e.request.url);
    if (!url.pathname.startsWith("/api/") || url.pathname.endsWith("/trace")) return cdp.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
    const headers = Object.fromEntries(Object.entries(e.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    let sent = null;
    try {
      sent = e.request.postData ? JSON.parse(e.request.postData) : null;
    } catch {}
    let status;
    let body;
    let etag = null;
    const hist = /^\/api\/agents\/([^/]+)\/trace\/history$/.exec(url.pathname);
    if (hist) {
      const p = fx.trace(decodeURIComponent(hist[1])).history.pages[url.searchParams.get("before") ?? ""];
      [status, body] = p ? [200, JSON.stringify(p)] : [400, JSON.stringify({ error: "unknown cursor" })];
    } else {
      ({ status, body, etag } = fx.answer(e.request.method, url.pathname.replace(/^\/api/, ""), url.searchParams, headers["if-none-match"] ?? null, sent));
    }
    if (API_MS) await new Promise((r) => setTimeout(r, API_MS));
    let bytes = 0;
    if (body !== null) {
      if (!gz.has(body)) gz.set(body, gzipSync(body).length);
      bytes = gz.get(body);
    }
    const path = `${e.request.method} ${url.pathname.replace(/^\/api/, "").replace(/\/(tsk|agt)_[a-z0-9]+/g, "/$1_*")}${url.searchParams.has("before") ? "?before" : url.search}`;
    ledger.push({ at: Date.now(), type: "api", bytes, raw: body?.length ?? 0, cached: false, status, path });
    const responseHeaders = [{ name: "content-type", value: "application/json" }, { name: "cache-control", value: "no-store" }, ...(etag ? [{ name: "etag", value: etag }] : [])];
    await cdp.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: status, responseHeaders, body: body === null ? "" : Buffer.from(body).toString("base64") }).catch(() => {});
  });
}

async function snapshot(page, cdp, ledger) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const p = await page.evaluate(() => ({ now: performance.now(), long: window.__perf?.long.length ?? 0, keys: window.__perf?.keys.length ?? 0 })).catch(() => ({ now: 0, long: 0, keys: 0 }));
  return { m, p, ledger: ledger.length, page, at: Date.now() };
}

function diff(name, a, b, ledger) {
  const same = a.page === b.page;
  const d = (k) => {
    const x = b.m[k] ?? 0;
    const y = same ? a.m[k] ?? 0 : 0;
    // A renderer swapped in a navigation restarts its counters.
    return Math.max(0, x >= y ? x - y : x) * 1000;
  };
  const net = { total: { requests: 0, bytes: 0 }, cached: 0 };
  for (const t of ["document", "script", "style", "font", "api", "ws", "other"]) net[t] = { requests: 0, bytes: 0 };
  net.api.notModified = 0;
  net.api.raw = 0;
  net.apiPaths = {};
  for (const r of ledger.slice(a.ledger, b.ledger)) {
    if (r.cached) {
      net.cached++;
      continue;
    }
    net[r.type].requests++;
    net[r.type].bytes += r.bytes;
    if (r.type === "api") {
      net.api.raw += r.raw;
      if (r.status === 304) net.api.notModified++;
      // Per endpoint: [requests, bytes (gzip), 304s].
      const e = (net.apiPaths[r.path] ??= [0, 0, 0]);
      e[0]++;
      e[1] += r.bytes;
      if (r.status === 304) e[2]++;
    }
    if (r.type !== "ws") {
      net.total.requests++;
      net.total.bytes += r.bytes;
    }
  }
  return {
    name,
    seconds: (b.at - a.at) / 1000,
    net,
    cdp: { script: d("ScriptDuration"), layout: d("LayoutDuration"), style: d("RecalcStyleDuration"), task: d("TaskDuration"), nodes: b.m.Nodes ?? null, heapMB: b.m.JSHeapUsedSize ? Math.round((b.m.JSHeapUsedSize / 1_048_576) * 10) / 10 : null },
    _long: [same ? a.p.long : 0, b.p.long],
    _keys: [same ? a.p.keys : 0, b.p.keys],
  };
}

/** Fills in a window's long tasks (and keys) from the page's probe, once the window is closed. */
async function settle(page, w) {
  const { long, keys } = await page.evaluate(([l, k]) => ({ long: window.__perf.long.slice(l[0], l[1]), keys: window.__perf.keys.slice(k[0], k[1]) }), [w._long, w._keys]);
  const durations = long.map((x) => x[1]);
  w.long = { count: durations.length, total: durations.reduce((s, x) => s + x, 0), max: durations.length ? Math.max(...durations) : 0, blocking: durations.reduce((s, x) => s + Math.max(0, x - 50), 0) };
  if (keys.length) w.keys = { count: keys.length, max: Math.max(...keys), median: keys.slice().sort((x, y) => x - y)[Math.floor(keys.length / 2)] };
  delete w._long;
  delete w._keys;
}

// --- pages and flows --------------------------------------------------------------------------------------

const P = "/projects/prj_demo";
const LOG = "[data-ds=terminal] .mantine-ScrollArea-viewport";
const TRACE_EVENT = "[data-ds=terminal] [data-kind=tool]";
const MESSAGE = "[data-ds=bubble], [data-ds=message]";

/** A cold load (cache empty), then the same URL in a new page (cache warm), then idle. */
function pageScenario(name, path, content, o = {}) {
  return {
    name,
    kind: "page",
    content,
    async run(ctx) {
      for (const which of ["cold", "warm"]) {
        const page = which === "cold" ? ctx.page : await ctx.newPage();
        const w = await ctx.window(which, async () => {
          await page.goto(base + path, { waitUntil: "commit" });
          if (o.after) {
            if ((await page.evaluate(() => window.__perf.first)) === null) throw new Error(`${content} didn't show (${which})`);
            const t = await o.after(ctx, page);
            return { content: t, selector: `the click, then ${o.afterContent}` };
          }
          const t = await page.evaluate(() => window.__perf.first);
          if (t === null) throw new Error(`${content} didn't show (${which})`);
          // Until the first polls have answered and the page is quiet.
          await page.waitForLoadState("networkidle").catch(() => {});
          // The first paint with content, and the page's heading, for where the time to content went.
          const { fcp, h1 } = await page.evaluate(async () => ({ fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null, h1: await window.__perf.h1 }));
          return { content: t, selector: content, fcp, h1 };
        });
        await settle(page, w);
        if (which === "cold") await page.close().catch(() => {});
      }
      const page = ctx.page;
      const w = await ctx.window("idle", () => page.waitForTimeout(IDLE * 1000), { idleSeconds: IDLE });
      await settle(page, w);
    },
  };
}

/** A flow: the page loaded (not measured), then `steps` measured as one window. */
function flowScenario(name, path, content, steps, o = {}) {
  return {
    name,
    kind: "flow",
    content,
    async run(ctx) {
      const { page } = ctx;
      await page.goto(base + path, { waitUntil: "commit" });
      if ((await page.evaluate(() => window.__perf.first)) === null) throw new Error(`${content} didn't show`);
      await page.waitForLoadState("networkidle").catch(() => {});
      if (o.before) await o.before(ctx);
      await page.waitForTimeout(1000);
      const w = await ctx.window("flow", () => steps(ctx), o.idleSeconds ? { idleSeconds: o.idleSeconds } : {});
      await settle(ctx.page, w);
    },
  };
}

const scrollTop = (page, sel) => page.locator(sel).first().evaluate((l) => {
  const el = l.scrollHeight > l.clientHeight + 1 ? l : (l.closest("[data-ds=page]") ?? l);
  el.scrollTop = 0;
  el.dispatchEvent(new Event("scroll"));
});
const count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
/** Scrolls `scroller` to its top until more of `item` show than before, `pages` times: each page's time. */
async function loadOlder(ctx, scroller, item, pages) {
  const times = [];
  for (let i = 0; i < pages; i++) {
    const n = await count(ctx.page, item);
    const t0 = await ctx.page.evaluate(() => performance.now());
    await scrollTop(ctx.page, scroller);
    const until = Date.now() + 30_000;
    while ((await count(ctx.page, item)) <= n) {
      if (Date.now() > until) throw new Error(`scrolling ${scroller} to its top loaded nothing older (page ${i + 1})`);
      await ctx.page.waitForTimeout(50);
    }
    times.push((await ctx.page.evaluate(() => performance.now())) - t0);
    await ctx.page.waitForTimeout(300);
  }
  return times;
}
const nav = (page, name) => page.locator("#sidebar").getByRole("link", { name: new RegExp(`^${name}`) }).first().click({ timeout: 10_000 });

const DRAWER = "[role=dialog] [data-ds=terminal] [data-kind=tool]";
/** A task with a worker (its trace in the drawer): the fixture's first one in progress. */
const WORKING = perfData({ seed: Number(opt.seed), shape: opt.shape }).project("prj_demo").tasks.find((t) => t.state === "in_progress").id;

const SCENARIOS = [
  // Pages: cold, warm, idle.
  pageScenario("projects", "/projects", "a[href='/projects/prj_demo/board'], a[href='/projects/prj_demo']"),
  pageScenario("board", `${P}/board`, "[data-ds=task-row]"),
  pageScenario("board-drawer", `${P}/board?task=${WORKING}`, DRAWER),
  pageScenario("manager-chat", `${P}/manager`, MESSAGE),
  pageScenario("manager-trace", `${P}/manager?view=trace`, TRACE_EVENT),
  pageScenario("reviews", `${P}/reviews`, "[aria-label^='Show the trace of #']"),
  pageScenario("reviews-trace", `${P}/reviews`, "[aria-label^='Show the trace of #']", {
    afterContent: TRACE_EVENT,
    after: (ctx, page) => ctx.until(TRACE_EVENT, () => page.getByRole("button", { name: "Show the trace of #400" }).click()),
  }),
  pageScenario("routines", `${P}/routines`, "[aria-label='Routine runs'] [aria-label^='Show ']"),
  pageScenario("routines-trace", `${P}/routines`, "[aria-label='Routine runs'] [aria-label^='Show ']", {
    afterContent: TRACE_EVENT,
    after: (ctx, page) => ctx.until(TRACE_EVENT, () => page.locator("[aria-label='Routine runs'] [aria-label^='Show ']").first().click()),
  }),
  pageScenario("triage", `${P}/triage`, "[data-ds=page] [data-ds=panel]"),
  pageScenario("secrets", `${P}/secrets`, "[data-ds=page] [data-ds=table-frame], [data-ds=page] [data-ds=panel]"),
  pageScenario("network", `${P}/network`, "[data-ds=page] [data-ds=panel]"),
  pageScenario("settings", `${P}/settings`, "[data-ds=page] [data-ds=panel]"),
  pageScenario("admin", "/admin", "[data-ds=page] [data-ds=panel], [data-ds=page] [data-ds=table-frame]"),

  // Flows.
  flowScenario("switch-view", `${P}/board`, "[data-ds=task-row]", async (ctx) => {
    const steps = {};
    steps.toManager = await ctx.until(MESSAGE, () => nav(ctx.page, "Manager"));
    await ctx.page.waitForTimeout(1000);
    steps.toReviews = await ctx.until("[aria-label^='Show the trace of #']", () => nav(ctx.page, "Reviews"));
    await ctx.page.waitForTimeout(1000);
    return { steps, content: steps.toManager + steps.toReviews, selector: "Manager, then Reviews" };
  }),
  flowScenario("switch-project", `${P}/board`, "[data-ds=task-row]", async (ctx) => {
    // Widgets' rows (its tasks' ids start tsk_othe), from the click on the switcher.
    const sel = "[data-task^=tsk_othe]";
    const t = await ctx.until(sel, async () => {
      await ctx.page.locator("[data-ds=switcher]").first().click();
      await ctx.page.getByRole("option", { name: /Widgets/ }).or(ctx.page.getByRole("menuitem", { name: /Widgets/ })).or(ctx.page.getByRole("link", { name: /Widgets/ })).first().click({ timeout: 10_000 });
    });
    await ctx.page.waitForURL(/prj_other/);
    await ctx.page.waitForTimeout(1000);
    return { content: t, selector: `${sel} (Widgets' board rows)` };
  }),
  flowScenario("drawer", `${P}/board`, "[data-ds=task-row]", async (ctx) => {
    const { page } = ctx;
    const link = page.locator(`[data-task=${WORKING}] a`).first();
    await link.scrollIntoViewIfNeeded();
    const steps = {};
    steps.open = await ctx.until(DRAWER, () => link.click());
    await page.waitForTimeout(1000);
    const t0 = await page.evaluate(() => performance.now());
    await page.keyboard.press("Escape");
    await page.locator("[role=dialog]").first().waitFor({ state: "hidden" });
    steps.close = (await page.evaluate(() => performance.now())) - t0;
    await page.waitForTimeout(500);
    return { steps, content: steps.open, selector: `${DRAWER} (open), the dialog hidden (close)` };
  }),
  flowScenario("type-composer", `${P}/manager`, MESSAGE, async (ctx) => {
    const box = ctx.page.getByLabel("Message to the manager");
    await box.click();
    await ctx.page.keyboard.type("Please split the export work into tasks.", { delay: 80 });
    // The last key's paint lands after it.
    await ctx.page.waitForTimeout(1000);
    return { typed: 40, messages: await count(ctx.page, MESSAGE) };
  }, { before: async (ctx) => {
    // All 200 messages shown first (three older pages).
    await loadOlder(ctx, "[data-ds=chat-log]", MESSAGE, 3);
  } }),
  flowScenario("stream-chat", `${P}/manager`, MESSAGE, async (ctx) => {
    await ctx.stream(10);
    await ctx.page.waitForTimeout(500);
    return { streamed: Math.round(RATE * 10) };
  }),
  flowScenario("stream-trace", `${P}/manager?view=trace`, TRACE_EVENT, async (ctx) => {
    await ctx.stream(10);
    await ctx.page.waitForTimeout(500);
    return { streamed: Math.round(RATE * 10) };
  }),
  flowScenario("open-trace", `${P}/manager`, MESSAGE, async (ctx) => {
    const t = await ctx.until(`${LOG} [data-kind=tool]`, () => ctx.page.getByRole("tab", { name: "Trace" }).click());
    await ctx.page.waitForTimeout(1000);
    return { content: t, selector: `${LOG} [data-kind=tool]` };
  }),
  flowScenario("older-chat", `${P}/manager`, MESSAGE, async (ctx) => {
    const pages = await loadOlder(ctx, "[data-ds=chat-log]", MESSAGE, 3);
    return { steps: { pages }, content: pages.reduce((s, x) => s + x, 0), selector: "50 more messages, three times" };
  }),
  flowScenario("older-trace", `${P}/manager?view=trace`, TRACE_EVENT, async (ctx) => {
    const pages = await loadOlder(ctx, LOG, "[data-ds=terminal] [data-kind]", 3);
    return { steps: { pages }, content: pages.reduce((s, x) => s + x, 0), selector: "a history page, three times" };
  }),
  flowScenario("drag-reorder", `${P}/board`, "[data-ds=task-row]", async (ctx) => {
    const { page } = ctx;
    const handle = page.getByRole("button", { name: /^Move / }).first();
    await handle.scrollIntoViewIfNeeded();
    const b = await handle.boundingBox();
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(x, y + i * 7, { steps: 1 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    return {};
  }),
  flowScenario("tab-switch", `${P}/manager`, MESSAGE, async (ctx) => {
    const { page } = ctx;
    const times = [];
    for (let i = 0; i < 3; i++) {
      times.push(await ctx.until(`${LOG} [data-kind=tool]`, () => page.getByRole("tab", { name: "Trace" }).click()));
      await page.waitForTimeout(500);
      times.push(await ctx.until(`[data-ds=chat-log] :is(${MESSAGE})`, () => page.getByRole("tab", { name: "Chat" }).click()));
      await page.waitForTimeout(500);
    }
    return { steps: { times }, content: times.reduce((s, x) => s + x, 0) / times.length, selector: "each switch (mean)" };
  }),
  flowScenario("idle-board", `${P}/board`, "[data-ds=task-row]", (ctx) => ctx.page.waitForTimeout(60_000), { idleSeconds: 60 }),
  flowScenario("idle-manager", `${P}/manager`, MESSAGE, (ctx) => ctx.page.waitForTimeout(60_000), { idleSeconds: 60 }),
];

// --- run them, one at a time ----------------------------------------------------------------------------

const wanted = opt.only?.split(",").map((s) => s.trim());
const chosen = SCENARIOS.filter((s) => !wanted || wanted.includes(s.name) || wanted.includes(s.kind));
if (!chosen.length) die(`no scenario matches --only ${opt.only}; they are: ${SCENARIOS.map((s) => s.name).join(", ")}`);

const report = {
  label: opt.label ?? (opt.dist ? resolve(opt.dist) : base),
  commit: opt.commit ?? null,
  at: new Date().toISOString(),
  cpu: CPU,
  shape: opt.shape,
  apiMs: API_MS,
  assets: opt.dist ? opt.assets : "as --base-url serves them",
  rate: RATE,
  idleSeconds: IDLE,
  seed: Number(opt.seed),
  chromium: null,
  scenarios: [],
};
let harnessError = null;
try {
  const b = await chromium.launch();
  report.chromium = b.version();
  await b.close();
} catch (e) {
  die(`can't start Chromium (${e.message.split("\n")[0]}): run \`npx playwright install --only-shell chromium\` in scripts/ui-review`);
}
for (const sc of chosen) {
  const t0 = Date.now();
  try {
    const r = await run(sc);
    report.scenarios.push(r);
    const w = r.windows.map((x) => `${x.name}: ${x.content !== undefined ? ms(x.content) + " to content, " : ""}${x.net.total.requests} req ${kb(x.net.total.bytes)}, long ${x.long?.count ?? "?"}/${ms(x.long?.total)}`).join("; ");
    console.log(`${sc.name.padEnd(16)} ${r.error ? `ERROR ${r.error}` : w} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  } catch (e) {
    harnessError = e;
    report.scenarios.push({ name: sc.name, kind: sc.kind, error: `harness: ${e.message.split("\n")[0]}` });
    console.log(`${sc.name.padEnd(16)} HARNESS ERROR ${e.message}`);
  }
}
server?.close();

// Times to 0.1 ms: the clocks' noise is far above that.
writeFileSync(join(out, "perf.json"), JSON.stringify(report, (_k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v), 2) + "\n");
writeFileSync(join(out, "perf.md"), markdown(report));
console.log(`\n${join(out, "perf.json")}\n${join(out, "perf.md")}`);
if (opt.compare) {
  const other = JSON.parse(readFileSync(opt.compare, "utf8"));
  const table = compare(other, report);
  writeFileSync(join(out, "compare.md"), table);
  process.stdout.write("\n" + table);
}
// A scenario that couldn't be played is a harness error (exit 2); slow numbers never are.
process.exit(harnessError || report.scenarios.some((s) => s.error) ? 2 : 0);

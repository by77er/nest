#!/usr/bin/env node
// Captures an app's pages and states at 1440, 1280 and 390 px in light and dark, runs the design
// review's automated checks on each, and writes the screenshots and report.json to <out-dir>.
// Exits 1 if any check fails, 2 on a usage or setup error. See README.md.
//
//   node scripts/ui-review/review.mjs <app> <out-dir> [--base-url URL] [--pages a,b] [--widths 1440,390] [--schemes dark]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { measure, scanHitOverlap } from "./checks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WIDTHS = [1440, 1280, 390];
const SCHEMES = ["light", "dark"];
const CHECKS = ["overflow", "clipping", "frame", "nav", "contrast", "measure", "hit-overlap", "page-error"];

const die = (msg) => {
  console.error(`ui-review: ${msg}`);
  process.exit(2);
};

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-url": { type: "string" },
    pages: { type: "string" },
    widths: { type: "string" },
    schemes: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (opt.help || positionals.length !== 2) die("usage: review.mjs <app> <out-dir> [--base-url URL] [--pages a,b] [--widths 1440,1280,390] [--schemes light,dark]");
const [appName, outArg] = positionals;
const configPath = join(HERE, "apps", `${appName}.mjs`);
if (!existsSync(configPath)) die(`no app config ${configPath}`);
const app = (await import(configPath)).default;
const out = resolve(outArg);
if (out === REPO || out.startsWith(REPO + "/")) die(`write the output outside the repo, not ${out}`);
mkdirSync(out, { recursive: true });

const list = (s, all, parse = String) => (s ? s.split(",").map((x) => parse(x.trim())) : all);
const widths = list(opt.widths, WIDTHS, Number);
const schemes = list(opt.schemes, SCHEMES);
const wanted = list(opt.pages, null);
const states = app.states.filter((s) => !wanted || wanted.includes(s.name) || wanted.includes(s.section));
if (!states.length) die(`no state matches --pages ${opt.pages}; the states are: ${app.states.map((s) => s.name).join(", ")}`);

// --- the app: a given URL, or its own `vite dev` on a free port ---
async function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

let server = null;
const stopServer = () => {
  if (server && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
  }
};
process.on("exit", stopServer);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

let base = opt["base-url"]?.replace(/\/$/, "");
if (!base) {
  const appDir = join(REPO, app.dir);
  const vite = join(appDir, "node_modules", ".bin", "vite");
  if (!existsSync(vite)) die(`${app.dir} has no node_modules: run \`npm ci\` in it first`);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const log = openSync(join(out, "vite.log"), "w");
  server = spawn(vite, ["--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, detached: true, stdio: ["ignore", log, log] });
  const until = Date.now() + 120_000; // workerd's first start compiles the Worker
  for (;;) {
    if (server.exitCode !== null) die(`vite dev exited (${server.exitCode}); see ${join(out, "vite.log")}`);
    try {
      if ((await fetch(base + app.ready)).ok) break;
    } catch {}
    if (Date.now() > until) die(`vite dev didn't answer ${base}${app.ready} within 120 s; see ${join(out, "vite.log")}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --- capture and check ---
let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  die(`can't start Chromium (${e.message.split("\n")[0]}): run \`npx playwright install --only-shell chromium\` in scripts/ui-review`);
}

const failures = [];
const shots = [];
const fail = (check, shot, detail) => failures.push({ check, state: shot.state, width: shot.width, scheme: shot.scheme, detail });

for (const scheme of schemes) {
  for (const width of widths) {
    for (const state of states) {
      if (state.widths && !state.widths.includes(width)) continue;
      const shot = { state: state.name, section: state.section, width, scheme, file: `${state.name}-${width}-${scheme}.png` };
      const context = await browser.newContext({
        viewport: { width, height: width < 600 ? 844 : 900 },
        // A phone is a touch screen: `pointer: coarse` applies, as do its larger hit targets.
        ...(width < 600 ? { hasTouch: true, isMobile: true } : {}),
        colorScheme: scheme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      // A state that serves failing answers on purpose expects the browser's "Failed to load resource".
      page.on("console", (m) => m.type() === "error" && !(state.httpErrors && /Failed to load resource/.test(m.text())) && errors.push(m.text()));
      try {
        await app.serve(page, state);
        await page.goto(base + state.path, { waitUntil: "networkidle" });
        await page.locator("h1").first().waitFor({ timeout: 15_000 });
        if (state.ready) await state.ready(page);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500); // past the 300 ms spinner delay and a poll's first answer
        if (state.after) {
          await state.after(page);
          await page.waitForTimeout(500);
        }
        const r = await page.evaluate(measure, { ...app.selectors, viewportOnly: state.full === false });
        shot.frame = r.frame;
        for (const [check, list] of Object.entries(r.problems)) for (const d of list) fail(check, shot, d);
        // On a touch screen's width: through the whole page and its scrollers, then back to the top.
        if (width < 600) for (const d of await scanHitOverlap(page, { full: state.full !== false })) fail("hit-overlap", shot, d);
        for (const d of (await state.check?.(page, { width, scheme })) ?? []) fail(state.checkName ?? "app", shot, d);
        if (app.errorText && (await page.getByText(app.errorText).count())) fail("page-error", shot, `the page shows "${app.errorText}"`);
        await page.screenshot({ path: join(out, shot.file), fullPage: state.full !== false });
      } catch (e) {
        fail("page-error", shot, `capture failed: ${e.message.split("\n")[0]}`);
      }
      for (const e of errors) fail("page-error", shot, e);
      shots.push(shot);
      const n = failures.filter((f) => f.state === shot.state && f.width === width && f.scheme === scheme).length;
      console.log(`${shot.file.padEnd(48)} ${n ? `${n} problem${n > 1 ? "s" : ""}` : "ok"}`);
      await context.close();
    }
  }
}
await browser.close();

// --- the frame across a section's views: same h1 left, header width and content left edge ---
for (const scheme of schemes) {
  for (const width of widths) {
    const bySection = new Map();
    for (const s of shots.filter((s) => s.scheme === scheme && s.width === width && s.frame && s.section)) {
      if (!bySection.has(s.section)) bySection.set(s.section, []);
      bySection.get(s.section).push(s);
    }
    for (const [section, list] of bySection) {
      const ref = list[0];
      for (const s of list.slice(1)) {
        for (const [key, what] of [["h1Left", "the h1's left edge"], ["contentLeft", "the content's left edge"], ["headerWidth", "the header's width"]]) {
          const a = ref.frame[key];
          const b = s.frame[key];
          if (a !== null && b !== null && Math.abs(a - b) > 1) fail("frame", s, `${what} is ${b} px, ${b > a ? "+" : ""}${Math.round((b - a) * 10) / 10} px from ${ref.state}'s (section ${section})`);
        }
      }
    }
  }
}

const byCheck = Object.fromEntries([...new Set([...CHECKS, ...failures.map((f) => f.check)])].map((c) => [c, failures.filter((f) => f.check === c).length]));
const report = { app: appName, base, at: new Date().toISOString(), widths, schemes, passed: failures.length === 0, checks: byCheck, shots, failures };
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");

console.log(`\n${shots.length} screens in ${out}`);
for (const [c, n] of Object.entries(byCheck)) console.log(`  ${n ? "FAIL" : "pass"}  ${c}${n ? `: ${n}` : ""}`);
if (failures.length) {
  console.log("");
  for (const f of failures.slice(0, 40)) console.log(`${f.check}  ${f.state}-${f.width}-${f.scheme}: ${f.detail}`);
  if (failures.length > 40) console.log(`… and ${failures.length - 40} more in report.json`);
}
process.exit(failures.length ? 1 : 0);

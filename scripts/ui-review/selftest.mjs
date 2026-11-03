#!/usr/bin/env node
// The checks can fail: a page with one planted violation per check must fail exactly those checks,
// and the same page without them must pass every one. No app or server needed.
//
//   node scripts/ui-review/selftest.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { measure } from "./checks.mjs";

const sel = {
  frame: "[data-ds=page]",
  header: "[data-ds=page-header]",
  measure: "[data-measure]",
  containers: ["[data-ds=panel]"],
  nav: { rows: "[data-ds=nav-row]", brand: "#brand", active: "[aria-current=page]" },
  viewportOnly: false,
};

/** A small app page; each `bad` key plants one violation. */
const html = (bad = {}) => `<!doctype html><html><head><style>
  body { margin: 0; font: 14px/20px sans-serif; background: #fafafa; color: #212529; display: flex; }
  nav { width: 200px; padding: 16px; } #brand { margin-left: 10px; font-size: 12px; }
  a { display: flex; gap: 8px; padding: 0 8px; border-left: 2px solid transparent; color: #212529; text-decoration: none; }
  a span:first-child { width: 20px; }
  a[aria-current=page] { background: ${bad.nav ? "#3b6fc0" : "#f1f3f5"}; border-left-color: #212529; }
  [data-ds=page] { flex: 1; padding: 32px; min-width: 0; }
  [data-measure] { max-width: 400px; ${bad.measure ? "margin: 0 auto;" : ""} }
  [data-ds=panel] { border: 1px solid #e9ecef; padding: 16px; background: #fff; }
  .cut { width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .faint { color: ${bad.contrast ? "#c8c8c8" : "#666e76"}; }
  .chip { position: relative; font: inherit; border: 1px solid #ced4da; background: #fff; color: #212529; padding: 2px 8px; }
  .chip.reach { z-index: 1; }
  .chip.reach::before { content: ""; position: absolute; top: 0; bottom: 0; left: 0; right: -60px; }
</style></head><body>
  <nav><div id="brand">nest</div>
    <a data-ds="nav-row" href="#" aria-current="page"><span>*</span><span>Board</span></a>
    <a data-ds="nav-row" href="#" ${bad.edge ? 'style="margin-left: 12px"' : ""}><span>*</span><span>Settings</span></a>
  </nav>
  <div data-ds="page"><div data-measure="form">
    <div data-ds="page-header"><h1>Gadgets</h1>${bad.h1 ? "<h1>Again</h1>" : ""}</div>
    <div data-ds="panel"><p class="faint">Updated 2 min ago</p>
      ${bad.clip ? '<p class="cut">A title far too long for its box</p>' : '<p class="cut">Short</p>'}
      ${bad.escape ? '<div style="width: 2000px">Wider than its panel</div>' : ""}
      <p><button class="chip ${bad.tap ? "reach" : ""}">Waiting</button> <button class="chip">Detach</button></p>
    </div>
  </div></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const run = async (bad, touch = false) => {
  await page.setContent(html(bad));
  return (await page.evaluate(measure, { ...sel, touch })).problems;
};
const failing = (problems) => Object.keys(problems).filter((k) => problems[k].length).sort();

const clean = await run({});
assert.deepEqual(failing(clean), [], `the clean page fails: ${JSON.stringify(clean)}`);
// On touch: two neighbouring controls pass; one whose ::before reaches over the other takes its taps.
assert.deepEqual(failing(await run({}, true)), [], "the clean page fails on touch");
const reach = await run({ tap: true }, true);
assert.deepEqual(failing(reach), ["hit-overlap"], `a hit area over a neighbour: ${JSON.stringify(reach)}`);
assert.match(reach["hit-overlap"][0], /a tap on <button> "Detach" at \d+,\d+ lands on <button> "Waiting"/);
// Without touch, hit areas aren't checked.
assert.deepEqual(failing(await run({ tap: true })), []);
for (const [bad, checks] of [
  [{ contrast: true }, ["contrast"]],
  [{ clip: true }, ["clipping"]],
  [{ escape: true }, ["clipping", "overflow"]],
  [{ measure: true }, ["measure"]],
  [{ h1: true }, ["frame"]],
  [{ nav: true }, ["contrast", "nav"]], // white-on-blue Board text is also under 4.5:1
  [{ edge: true }, ["nav"]],
]) {
  const got = await run(bad);
  assert.deepEqual(failing(got), checks, `${JSON.stringify(bad)}: ${JSON.stringify(got)}`);
}
// The frame's geometry moves when the measure is centred: the cross-view check compares it.
await page.setContent(html({}));
const left = (await page.evaluate(measure, sel)).frame;
await page.setContent(html({ measure: true }));
const centred = (await page.evaluate(measure, sel)).frame;
assert.ok(centred.h1Left - left.h1Left > 100 && centred.contentLeft === left.contentLeft, JSON.stringify({ left, centred }));

await browser.close();
console.log("selftest: every check fails its planted violation and passes the clean page");

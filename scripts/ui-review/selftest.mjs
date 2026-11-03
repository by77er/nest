#!/usr/bin/env node
// The checks can fail: a page with one planted violation per check must fail exactly those checks,
// and the same page without them must pass every one. No app or server needed.
//
//   node scripts/ui-review/selftest.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { measure } from "./checks.mjs";
import { countTraffic, tabKeepCheck } from "./trace-tabs.mjs";

const sel = {
  frame: "[data-ds=page]",
  header: "[data-ds=page-header]",
  measure: "[data-measure]",
  containers: ["[data-ds=panel]"],
  nav: { rows: "[data-ds=nav-row]", brand: "#brand", active: "[aria-current=page]" },
  viewportOnly: false,
  content: { root: "[data-ds=rich]", minHeading: 4, figures: "[data-ds=figure-canvas]" },
};

/** A small app page; each `bad` key plants one violation. */
const html = (bad = {}) => `<!doctype html><html><head><style>
  body { margin: 0; font: 14px/20px sans-serif; background: #fafafa; color: #212529; display: flex; }
  nav { width: 200px; padding: 16px; } #brand { margin-left: 10px; font-size: 12px; }
  a { display: flex; align-items: center; min-height: 44px; gap: 8px; padding: 0 8px; border-left: 2px solid transparent; color: #212529; text-decoration: none; }
  p a { display: inline; min-height: 0; padding: 0; }
  .prose { line-height: ${bad.tightLine ? "16px" : "24px"}; }
  a span:first-child { width: 20px; }
  a[aria-current=page] { background: ${bad.nav ? "#3b6fc0" : "#f1f3f5"}; border-left-color: #212529; }
  [data-ds=page] { flex: 1; padding: 32px; min-width: 0; }
  [data-measure] { max-width: 400px; ${bad.measure ? "margin: 0 auto;" : ""} }
  [data-ds=panel] { border: 1px solid #e9ecef; padding: 16px; background: #fff; }
  .cut { width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .faint { color: ${bad.contrast ? "#c8c8c8" : "#666e76"}; }
  [data-ds=rich] h4 { font-size: ${bad.small ? "11px" : "inherit"}; font-weight: 600; }
  [data-ds=figure-canvas] { width: 120px; height: 40px; border: 1px solid #dee2e6; background: ${bad.figure ? "#1a1b1e" : "#ffffff"}; }
  .chip { position: relative; font: inherit; min-height: 44px; min-width: 44px; border: 1px solid #ced4da; background: #fff; color: #212529; padding: 2px 8px; }
  .tiny { font: inherit; padding: 0 4px; }
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
      <p><span style="color: transparent">⎿</span> a character kept for copy, drawn as something else: not read, so not checked</p>
      ${bad.clip ? '<p class="cut">A title far too long for its box</p>' : '<p class="cut">Short</p>'}
      ${bad.escape ? '<div style="width: 2000px">Wider than its panel</div>' : ""}
      <p><button class="chip ${bad.tap ? "reach" : ""}">Waiting</button> <button class="chip">Detach</button></p>
      <p class="prose">A sentence with <a href="#">an inline link</a> in it, on a 24 px line: the inline exception.</p>
      ${bad.tiny ? '<div><button class="tiny">Tiny</button></div>' : ""}
      ${bad.crowded ? '<div><a href="#" style="display: block; min-height: 0; padding: 0">One</a><a href="#" style="display: block; min-height: 0; padding: 0">Two</a></div>' : ""}
      ${bad.covered ? '<div style="position: relative"><button class="chip">Hidden</button><div style="position: absolute; inset: 0; background: rgba(255,255,255,0.01)"></div></div>' : ""}
      <div data-ds="rich">${bad.heading ? "<h2>Plan</h2>" : "<h4>Plan</h4>"}<p>The message's text.</p><div data-ds="figure-canvas"></div></div>
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
{ const t = await run({}, true); assert.deepEqual(failing(t), [], `the clean page fails on touch: ${JSON.stringify(t["hit-size"])}`); }
const reach = await run({ tap: true }, true);
// (The neighbour is then covered at its centre too: hit-size says so.)
assert.deepEqual(failing(reach), ["hit-overlap", "hit-size"], `a hit area over a neighbour: ${JSON.stringify(reach)}`);
assert.match(reach["hit-overlap"][0], /a tap on <button> "Detach" at \d+,\d+ lands on <button> "Waiting"/);
// Without touch, hit areas aren't checked.
assert.deepEqual(failing(await run({ tap: true })), []);
// On touch, a 20 px button standing on its own takes too few of the taps in its 44 px square; the
// inline link in a sentence passes at 24 px.
const tiny = await run({ tiny: true }, true);
assert.deepEqual(failing(tiny), ["hit-size"], `a small target: ${JSON.stringify(tiny)}`);
assert.match(tiny["hit-size"][0], /<button> "Tiny": \d+ of \d+ taps in its 44 px square/);
assert.deepEqual(failing(await run({ tiny: true })), [], "without touch, sizes aren't checked");
// Two links stacked 20 px apart: closer than 24 px (WCAG 2.5.8's spacing), each too small to tap.
const crowded = await run({ crowded: true }, true);
assert.deepEqual(failing(crowded), ["hit-size"], `crowded links: ${JSON.stringify(crowded)}`);
assert.match(crowded["hit-size"][0], /<a> "One": 20 px from <a> "Two", closer than 24/);
// A button covered at its centre by a plain element can't be tapped at all.
const covered = await run({ covered: true }, true);
assert.deepEqual(failing(covered), ["hit-size"], `a covered button: ${JSON.stringify(covered)}`);
assert.match(covered["hit-size"][0], /<button> "Hidden": covered at its centre by <div>/);
// An inline link on a line under 24 px fails too.
const tight = await run({ tightLine: true }, true);
assert.deepEqual(failing(tight), ["hit-size"], `a tight line: ${JSON.stringify(tight)}`);
assert.match(tight["hit-size"][0], /an inline link on a 16 px line/);
for (const [bad, checks] of [
  [{ contrast: true }, ["contrast"]],
  [{ clip: true }, ["clipping"]],
  [{ escape: true }, ["clipping", "overflow"]],
  [{ measure: true }, ["measure"]],
  [{ h1: true }, ["frame"]],
  [{ nav: true }, ["contrast", "nav"]], // white-on-blue Board text is also under 4.5:1
  [{ edge: true }, ["nav"]],
  [{ heading: true }, ["content"]],
  [{ small: true }, ["content"]],
  [{ figure: true }, ["content"]],
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

// The trace's tabs: a sheet whose Trace tab is kept (hidden, `display: none`) passes; one that mounts the
// trace again on each switch (a new socket, its history fetched again, scroll and expansion lost) fails.
const tabsPage = (remount) => `<!doctype html><html><body>
  <div role="tablist"><button role="tab" id="d">Details</button><button role="tab" id="t">Trace</button></div>
  <div id="details">details</div><div id="trace" style="display: none"></div>
  <script>
    const make = () => {
      const box = document.getElementById("trace");
      box.innerHTML = '<div data-ds="terminal"><div class="mantine-ScrollArea-viewport" style="height: 100px; overflow: auto">' +
        Array.from({ length: 60 }, (_, i) => "<p>line " + i + "</p>").join("") +
        '<button data-slot="more" aria-expanded="false">more</button></div></div>';
      const more = box.querySelector("[data-slot=more]");
      more.onclick = () => more.setAttribute("aria-expanded", more.getAttribute("aria-expanded") === "true" ? "false" : "true");
      new WebSocket("ws://selftest.local/api/agents/agt_x/trace");
      fetch("/api/agents/agt_x/trace/history?before=c1");
    };
    let made = false;
    document.getElementById("t").onclick = () => {
      if (${remount} || !made) { make(); made = true; }
      document.getElementById("trace").style.display = "block";
      document.getElementById("details").style.display = "none";
    };
    document.getElementById("d").onclick = () => {
      document.getElementById("trace").style.display = "none";
      document.getElementById("details").style.display = "block";
      if (${remount}) document.getElementById("trace").innerHTML = "";
    };
  </script></body></html>`;
for (const remount of [false, true]) {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const traffic = countTraffic(p);
  await p.routeWebSocket(/\/trace$/, () => traffic.socket());
  await p.route("http://selftest.local/**", (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith("/trace/history")) {
      traffic.historyPage();
      return route.fulfill({ contentType: "application/json", body: "{}" });
    }
    return route.fulfill({ contentType: "text/html", body: tabsPage(remount) });
  });
  await p.goto("http://selftest.local/");
  const problems = await tabKeepCheck(p);
  if (remount) {
    assert.equal(problems.length, 4, `the remounting tabs must fail all four: ${JSON.stringify(problems)}`);
  } else {
    assert.deepEqual(problems, [], "the kept tabs pass");
  }
  await p.close();
}

await browser.close();
console.log("selftest: every check fails its planted violation and passes the clean page");

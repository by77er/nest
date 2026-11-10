#!/usr/bin/env node
// The checks can fail: a page with one planted violation per check must fail exactly those checks,
// and the same page without them must pass every one. No app or server needed.
//
//   node scripts/ui-review/selftest.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { inkChatFit, inkHeaderGap, inkPrs, inkTrace, removeFocusCheck, waitsCheck, workflowsAgree } from "./apps/projects.mjs";
import { measure, restoreTouch, scanHits } from "./checks.mjs";
import { countTraffic, tabKeepCheck } from "./trace-tabs.mjs";
import { proseProblems } from "./trace-prose.mjs";

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
      <p class="cut" data-ds="truncate" ${bad.cutUntitled ? "" : 'title="A row title cut on purpose, its full text its title"'}>A row title cut on purpose, its full text its title</p>
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
  // A deliberate cut must carry its whole text as its title; without it, it's clipping like any other.
  [{ cutUntitled: true }, ["clipping"]],
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

// hit-overlap ignores a control clipped away where the hit area meets it (a trace row scrolled out of
// its log, under a button above the log): no tap there is meant for it. Unclipped, the same row counts.
{
  const clipPage = (clipped) => `<!doctype html><html><head><style>
    body { margin: 0; font: 14px/20px sans-serif; }
    .reach { position: absolute; top: 100px; left: 20px; min-height: 44px; min-width: 44px; z-index: 1; }
    .reach::before { content: ""; position: absolute; top: -40px; left: 0; right: 0; bottom: 0; }
    .log { position: absolute; top: 120px; left: 20px; width: 200px; height: 20px; ${clipped ? "overflow: hidden;" : ""} }
    .log button { position: relative; top: -60px; min-height: 44px; }
  </style></head><body><button class="reach">Reach</button><div class="log"><button>Row</button></div></body></html>`;
  const overlap = async (clipped) => {
    await page.setContent(clipPage(clipped));
    return (await page.evaluate(measure, { ...sel, touch: true })).problems["hit-overlap"];
  };
  assert.deepEqual(await overlap(true), [], "a control clipped out of its scroller isn't a neighbour");
  assert.equal((await overlap(false)).length, 1, "the same control, unclipped, is");
  // A parent that clips only sideways (overflow-x: clip, overflow-y: visible) leaves a control sticking
  // out below it painted and tappable: still a neighbour (the reviewer's plantclip2).
  const xOnly = (style) => `<!doctype html><html><head><style>
    body { margin: 0; font: 16px/20px sans-serif; }
    .t::after { content: ""; position: absolute; inset: -30px 0; }
  </style></head><body><div style="margin-top: 200px"><div style="${style}; height: 1px"><a href="/b" style="display: block; position: relative; width: 200px; height: 20px">B</a></div><div style="position: relative; margin-top: 24px"><a class="t" href="/a" style="position: relative; display: inline-block; width: 200px">A</a></div></div></body></html>`;
  const overlapOf = async (style) => {
    await page.setContent(xOnly(style));
    return (await page.evaluate(measure, { ...sel, touch: true })).problems["hit-overlap"];
  };
  assert.equal((await overlapOf("overflow-x: clip; overflow-y: visible")).length, 1, "a control sticking out of a parent that clips only sideways is a neighbour");
  assert.equal((await overlapOf("")).length, 1, "and so it is with no overflow at all");
  // Inside a clip margin a control is still painted: a neighbour.
  assert.equal((await overlapOf("overflow: clip; overflow-clip-margin: 40px")).length, 1, "a control within overflow-clip-margin is a neighbour");
  assert.deepEqual(await overlapOf("overflow: clip"), [], "clipped on both axes, it isn't");
  // Clipping follows the containing block, not the DOM parent: a control fixed, or absolute and escaping
  // a non-positioned overflow: hidden parent, is painted and tappable (the reviewer's plantclip3).
  const escape = (b) => `<!doctype html><html><head><style>
    body { margin: 0; font: 16px/20px sans-serif; }
    .t::after { content: ""; position: absolute; inset: -30px 0; }
  </style></head><body><div style="margin-top: 200px; position: relative">${b}<div style="position: relative; margin-top: 24px"><a class="t" href="/a" style="position: relative; display: inline-block; width: 200px">A</a></div></div></body></html>`;
  const escapes = async (b) => {
    await page.setContent(escape(b));
    return (await page.evaluate(measure, { ...sel, touch: true })).problems["hit-overlap"];
  };
  assert.equal((await escapes(`<div style="overflow: hidden; height: 1px"><a href="/b" style="position: fixed; top: 200px; left: 0; width: 200px; height: 20px; display: block">B</a></div>`)).length, 1, "a fixed control inside an overflow: hidden parent is a neighbour");
  assert.equal((await escapes(`<div style="overflow: hidden; height: 1px"><a href="/b" style="position: absolute; top: 0; left: 0; width: 200px; height: 20px; display: block">B</a></div>`)).length, 1, "an absolute control escaping a non-positioned overflow: hidden parent is a neighbour");
  // The probe sets aside everything inside the reaching control too: a child of it with
  // pointer-events: auto, reaching over the neighbour, can't hide the overlap.
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; font: 16px/20px sans-serif; }
    .t::after { content: ""; position: absolute; inset: -30px 0; }
    .t span { position: absolute; inset: -30px 0 0; pointer-events: auto; }
  </style></head><body><div style="margin-top: 200px; position: relative"><div style="height: 1px"><a href="/b" style="display: block; width: 200px; height: 20px">B</a></div><div style="position: relative; margin-top: 24px"><a class="t" href="/a" style="position: relative; display: inline-block; width: 200px">A<span></span></a></div></div></body></html>`);
  assert.equal((await page.evaluate(measure, { ...sel, touch: true })).problems["hit-overlap"].length, 1, "a reaching child with pointer-events: auto doesn't hide the overlap");
  assert.equal(await page.evaluate(() => document.querySelectorAll("[data-hit-probe]").length + [...document.head.querySelectorAll("style")].filter((x) => x.textContent.includes("data-hit-probe")).length), 0, "the probe leaves nothing behind");
}

// The trace's Markdown (trace-prose.mjs): an assistant's answer on a terminal, clean, then with each of
// the design review's (#141) planted failures: a serif span, a 20 px paragraph, a wide fence that doesn't
// scroll in itself, and a line spilled past the trace.
{
  const prosePage = (plant = "") => `<!doctype html><html><head><style>
    body { margin: 0; font: 14px/20px sans-serif; }
    [data-ds=terminal] { width: 400px; padding: 12px; font-family: "JetBrains Mono Variable", monospace; font-size: 13px; line-height: 20px; white-space: pre-wrap; }
    [data-ds=term-prose] { white-space: normal; min-width: 0; }
    [data-ds=term-prose] p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    [data-ds=term-prose] :where(pre, table, code, strong) { font: inherit; }
    [data-ds=term-prose] pre { margin: 0; white-space: pre; overflow-x: auto; contain: inline-size; }
    [data-md=table] { overflow-x: auto; contain: inline-size; }
    [data-md=table] td { white-space: pre; }
  </style></head><body><div data-ds="terminal"><div data-ds="term-prose">
    <p>The push was refused, so <strong>the broker</strong> opens it, after <code>npm run build</code>.</p>
    <pre><code>${"npm run build && npx vitest run --reporter=verbose ".repeat(4)}</code></pre>
    <div data-md="table"><table><tr><td>${"the-integration-suite-".repeat(6)}</td></tr></table></div>
  </div></div><script>(${plant || "() => {}"})()</script></body></html>`;
  const plants = {
    serif: () => { const s = document.createElement("span"); s.style.fontFamily = "serif"; s.textContent = "x"; document.querySelector("[data-ds=term-prose] p").append(s); },
    bigger: () => { document.querySelector("[data-ds=term-prose] p").style.fontSize = "20px"; },
    noScrollPre: () => { document.querySelector("[data-ds=term-prose] pre").style.overflowX = "visible"; },
    spill: () => { const p = document.querySelector("[data-ds=term-prose] p"); p.style.whiteSpace = "pre"; p.textContent = "x".repeat(400); },
  };
  // Each plant's problem, and only its kind (a 20 px paragraph's children inherit its size).
  const expected = { serif: /<span> isn't mono \(serif\)/, bigger: /<p> is 20px, not the terminal's 13px/, noScrollPre: /a wide trace fence doesn't scroll in itself/, spill: /<p> spills past the trace's line/ };
  const kind = { serif: /isn't mono/, bigger: /is 20px, not the terminal's 13px/, noScrollPre: /doesn't scroll in itself/, spill: /spills past/ };
  const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p.setContent(prosePage());
  assert.deepEqual(await p.evaluate(proseProblems), [], "the clean trace Markdown passes");
  for (const [name, fn] of Object.entries(plants)) {
    await p.setContent(prosePage(fn.toString()));
    const problems = await p.evaluate(proseProblems);
    assert.match(problems[0] ?? "", expected[name], `${name}: ${JSON.stringify(problems)}`);
    for (const pr of problems) assert.match(pr, kind[name], `${name}: only its own kind: ${JSON.stringify(problems)}`);
  }
  await p.close();
}

// The projects app's rhythm measures (apps/projects.mjs), on planted pages: what's painted, not the
// grown hit boxes. Each clean page passes; each plant (the reviewer's cases) fails.
{
  const base = `body { margin: 0; font: 14px/20px sans-serif; } .mantine-Badge-root { display: inline-block; height: 18px; line-height: 18px; padding: 0 6px; }`;
  const page2 = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const at = async (html, css, fn) => {
    await page2.setContent(`<!doctype html><style>${base}${css}</style>${html}`);
    return page2.evaluate(fn);
  };
  // A task's PRs: three lines each (number and title; badges; who attached it), 24 px apart.
  const pr = (n) => `<div data-pr="${n}" style="display: flex; flex-direction: column; gap: 4px"><div><a href="#" style="padding-block: 12px; margin-block: -12px; display: inline-block">#${n}</a> A title</div><div style="display: flex; gap: 4px"><span class="mantine-Badge-root">Open</span></div><div>Attached by you</div></div>`;
  const prs = `<div class="list" style="display: flex; flex-direction: column; gap: 32px">${pr(1)}${pr(2)}</div>`;
  assert.deepEqual(await at(prs, "", inkPrs), [], "the clean PRs pass");
  for (const [plant, css] of [
    ["a 44 px badge line", "[data-pr] > :nth-child(2) { min-height: 44px; align-items: center; }"],
    ["PRs 4 px apart", ".list { gap: 4px !important; }"],
    ["the meta line pushed 40 px down", "[data-pr] > :nth-child(3) { margin-top: 40px; }"],
  ]) assert.notDeepEqual(await at(prs, css, inkPrs), [], `PRs: ${plant} must fail`);
  // A transcript: tool calls, each in a wrapper of its own (a FadeIn), call then result.
  const tool = (n) => `<div class="fade"><div data-kind="tool" style="display: flex; flex-direction: column; gap: 2px; margin-block: 12px"><button data-ds="term-line" data-slot="call" style="all: unset; display: block; padding-block: 12px; margin-block: -12px"><span data-slot="text">Bash(step ${n})</span></button><div data-ds="term-line" data-kind="tool_result">⎿ done ${n}</div></div></div>`;
  const term = `<div data-ds="terminal">${tool(1)}${tool(2)}${tool(3)}</div>`;
  assert.deepEqual(await at(term, "", inkTrace), [], "the clean transcript passes");
  for (const [plant, css] of [
    ["a top-aligned 44 px call row", "[data-slot=call] { min-height: 44px !important; padding: 0 !important; margin: 0 !important; display: flex !important; align-items: flex-start; }"],
    ["a result pushed 30 px down", "[data-kind=tool_result] { margin-top: 30px; }"],
  ]) assert.notDeepEqual(await at(term, css, inkTrace), [], `trace: ${plant} must fail`);
  // The header: its meta line's text under the h1's, the same on touch as with a mouse.
  const header = `<div data-ds="page-header"><h1 style="margin: 0; font-size: 24px; line-height: 32px">Gadgets</h1><div data-slot="meta"><a href="#">by77er/gadgets</a> · Auto-assign on</div></div>`;
  const mouse = await at(header, "", inkHeaderGap);
  const grown = await at(header, "[data-slot=meta] a { padding-block: 12px; display: inline-block; }", inkHeaderGap);
  const kept = await at(header, "[data-slot=meta] a { padding-block: 12px; margin-block: -12px; display: inline-block; }", inkHeaderGap);
  assert.ok(Math.abs(kept - mouse) <= 4, `a hit box grown without its line passes (${kept} vs ${mouse})`);
  assert.ok(Math.abs(grown - mouse) > 4, `a header link that grows its line must fail (${grown} vs ${mouse})`);
  // The chat fits the viewport (chat-fit): a phone's layout, the page's column the one scroller, the
  // composer pinned at its bottom. Clean, it passes; the reviewer's plants fail.
  const chat = `<div data-ds="page" style="height: 788px; margin-top: 56px; overflow-y: auto; box-sizing: border-box; padding: 16px 16px 0">
    <h1 style="margin: 0">Gadgets</h1>
    <div style="display: flex; flex-direction: column; gap: 12px">
      <div data-ds="chat-log">${Array.from({ length: 40 }, (_, k) => `<p style="margin: 0 0 12px">Message ${k + 1}</p>`).join("")}</div>
      <div data-ds="composer-dock" style="position: sticky; bottom: 0; background: #fff; padding: 12px 0"><textarea style="width: 100%; height: 60px"></textarea></div>
    </div></div>`;
  const fit = (css) => at(chat, `body { margin: 0; } ${css}`, inkChatFit);
  assert.deepEqual(await fit(""), [], `the clean chat fits: ${JSON.stringify(await fit(""))}`);
  for (const [plant, css] of [
    ["the page 200 px taller", "[data-ds=page] { padding-bottom: 200px !important; }"],
    ["the composer pushed 400 px down", "[data-ds=composer-dock] { margin-top: 400px !important; }"],
    ["the document scrolling", "[data-ds=page] { height: 1200px !important; }"],
    ["a short chat's composer floating above the bottom", "[data-ds=chat-log] p:nth-child(n+3) { display: none; } [data-ds=composer-dock] { position: static; }"],
  ]) assert.notDeepEqual(await fit(css), [], `chat-fit: ${plant} must fail`);
  // Settings' live workers against the saved toggle (workflowsAgree): clean passes; an Applied row that
  // contradicts it, and a differing one that doesn't say so, fail.
  const workers = (on, rows) => `<label class="mantine-Switch-root"><input type="checkbox" role="switch" ${on ? "checked" : ""}> Workers may change CI workflows</label>
    <div role="list" aria-label="Live workers' push tokens">${rows.map(([agent, state, text, matches]) => `<div data-agent="${agent}"><span data-slot="state">${state}</span><span data-slot="workflows" data-matches="${matches}">${text}</span></div>`).join("")}</div>`;
  assert.deepEqual(await at(workers(false, [["agt_1", "Applied", "Its pushes may not change workflows", true], ["agt_2", "Pending", "Still may change workflows · until its layer applies", false]]), "", workflowsAgree), [], "agreeing workers pass");
  for (const [plant, html] of [
    ["an Applied row that contradicts the toggle", workers(false, [["agt_1", "Applied", "Still may change workflows · until its layer applies", false]])],
    ["a differing row that doesn't say so", workers(true, [["agt_1", "Pending", "Its pushes may not change workflows", true]])],
    ["no toggle on the page", `<div role="list" aria-label="Live workers' push tokens"></div>`],
    ["an agreeing row that says it differs", workers(false, [["agt_1", "Applied", "Can't change workflows yet · until its layer applies again", false]])],
  ]) assert.notDeepEqual(await at(html, "", workflowsAgree), [], `workflows: ${plant} must fail`);
  await page2.close();
}

// #135's state checks, on planted pages (the design review's cases that once passed): the manager's waits
// (no raw ids; the section there when the column shows; task and PR lines linked), and focus after a
// keyboard Remove (the next row's, in the same role's panel).
{
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const waitsPage = `<!doctype html><div data-slot="manager-context"><section><h4>Waiting for</h4>
    <div role="list" data-slot="waits">
      <div role="listitem"><p><a href="/b?task=t1">Export gadgets as CSV</a> to be In review or Done · 45 min left</p></div>
      <div role="listitem"><p><a href="https://github.com/o/r/pull/118">#118</a> to merge · 2 h left</p></div>
      <div role="listitem"><p>The owner's reply · 26 h left</p></div>
    </div></section></div>`;
  const waitsPlants = {
    "raw id and snake_case": () => document.querySelector("[data-slot=waits]").append(" tsk_demo4 in_review"),
    "the section missing": () => document.querySelectorAll("[data-slot=waits]").forEach((e) => e.remove()),
    "links removed": () => document.querySelectorAll("[data-slot=waits] a").forEach((a) => a.replaceWith(document.createTextNode(a.textContent))),
  };
  await p.setContent(waitsPage);
  assert.deepEqual(await waitsCheck(p), [], "the clean waits pass");
  for (const [name, plant] of Object.entries(waitsPlants)) {
    await p.setContent(waitsPage);
    await p.evaluate(plant);
    assert.notDeepEqual(await waitsCheck(p), [], `waits: ${name} must fail`);
  }
  const panels = `<!doctype html><div data-role="worker"><button aria-label="Remove b">x</button><button aria-label="Remove c">x</button></div><div data-role="manager"><button aria-label="Remove b">x</button></div>`;
  p.removedNext = { role: "worker", host: "b" };
  const focusPlants = {
    clean: () => document.querySelector("[data-role=worker] [aria-label='Remove b']").focus(),
    "focus lost to body": () => document.activeElement?.blur(),
    "another panel's Remove": () => document.querySelector("[data-role=manager] [aria-label='Remove b']").focus(),
    "another row's Remove": () => document.querySelector("[data-role=worker] [aria-label='Remove c']").focus(),
  };
  for (const [name, plant] of Object.entries(focusPlants)) {
    await p.setContent(panels);
    await p.evaluate(plant);
    const problems = await removeFocusCheck(p);
    if (name === "clean") assert.deepEqual(problems, [], "focus on the next row's Remove passes");
    else assert.notDeepEqual(problems, [], `focus after Remove: ${name} must fail`);
  }
  await p.close();
}

// The scroll scan (scanHits): hit-overlap and hit-size wherever the reader can scroll, not the first
// viewport only. Each plant is out of the first viewport but one (the reviewer's cases, plantscan.mjs):
// below the fold, in a sideways scroller, in a vertical inner scroller (a drawer's body), below the fold
// and sideways at once, and in the topmost modal's body. The first viewport alone misses each; the scan
// finds each. A clean page with the same scrollers finds nothing.
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p3 = await ctx.newPage();
  const css = "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><style>body { margin: 0; font: 16px/24px sans-serif; } .big { display: block; min-width: 48px; min-height: 48px; } .t::after { content: ''; position: absolute; inset: -30px 0; }</style>";
  // A reaches 30 px above and below itself, over B.
  const pair = '<div style="position: relative; padding: 40px 0"><a class="t big" href="/a" style="position: relative">A</a><a class="big" href="/b">B</a></div>';
  const tiny = '<button style="width: 16px; height: 16px; padding: 0; margin: 60px">x</button>';
  const sideways = (inner) => `<div style="overflow-x: auto; width: 390px"><div style="width: 1600px; position: relative; height: 300px"><div style="position: absolute; left: 1200px; top: 0">${inner}</div></div></div>`;
  const down = (inner) => `<div style="overflow-y: auto; height: 300px"><div style="height: 1200px"></div>${inner}</div>`;
  const modal = (inner) => `<div role="dialog" aria-modal="true" style="position: fixed; inset: 0; background: #fff; display: flex; flex-direction: column"><h2 style="margin: 0">Sheet</h2><div style="overflow-y: auto; flex: 1"><div style="height: 1500px"></div>${inner}</div></div>`;
  const fold = (inner) => `<div style="height: 2000px"></div>${inner}`;
  const cases = {
    "below the fold": fold,
    "in a sideways scroller": sideways,
    "in a vertical inner scroller": down,
    "below the fold, sideways": (x) => fold(sideways(x)),
    "in the topmost modal's body": (x) => `<a class="big" href="/under">Under</a>${modal(x)}`,
  };
  const first = async () => {
    const p = (await p3.evaluate(measure, { ...sel, touch: true, viewportOnly: true })).problems;
    return { "hit-overlap": p["hit-overlap"], "hit-size": p["hit-size"] };
  };
  for (const [name, wrap] of Object.entries(cases)) {
    await p3.setContent(`<!doctype html><html><head>${css}</head><body><h1>Page</h1>${wrap('<a class="big" href="/c">C</a>')}</body></html>`);
    const quiet = await scanHits(p3, sel);
    assert.deepEqual(quiet, { "hit-overlap": [], "hit-size": [] }, `${name}, clean: ${JSON.stringify(quiet)}`);
    for (const [plant, inner, check] of [["an overlap", pair, "hit-overlap"], ["a small target", tiny, "hit-size"]]) {
      await p3.setContent(`<!doctype html><html><head>${css}</head><body><h1>Page</h1>${wrap(inner)}</body></html>`);
      assert.deepEqual((await first())[check], [], `${name}: ${plant} isn't in the first viewport`);
      const y0 = await p3.evaluate(() => window.scrollY);
      const got = await scanHits(p3, sel);
      assert.ok(got[check].length >= 1, `${name}: the scan finds ${plant}: ${JSON.stringify(got)}`);
      assert.equal(await p3.evaluate(() => window.scrollY), y0, `${name}: the scan puts the page's scroll back`);
      assert.equal(await p3.evaluate(() => document.querySelectorAll("[data-hit-scan]").length), 0, `${name}: the scan leaves no marks`);
    }
  }
  // In view, the scan finds it too (its first step is the first viewport).
  await p3.setContent(`<!doctype html><html><head>${css}</head><body><h1>Page</h1>${pair}</body></html>`);
  assert.ok((await scanHits(p3, sel))["hit-overlap"].length >= 1, "in view: the scan finds an overlap");
  // A full-page screenshot ends the touch emulation; restoreTouch brings it back before a scan.
  await p3.setContent(`<!doctype html><html><head>${css}</head><body><h1>Page</h1>${fold("")}</body></html>`);
  assert.ok(await p3.evaluate(() => matchMedia("(pointer: coarse)").matches), "a touch context is coarse");
  await p3.screenshot({ fullPage: true });
  const lost = !(await p3.evaluate(() => matchMedia("(pointer: coarse)").matches));
  await restoreTouch(p3);
  assert.ok(await p3.evaluate(() => matchMedia("(pointer: coarse)").matches), `restoreTouch makes it coarse again (the screenshot ${lost ? "had ended it" : "kept it"})`);
  await ctx.close();
}

await browser.close();
console.log("selftest: every check fails its planted violation and passes the clean page");

// The projects app (projects/): its pages and states, the fixtures that serve them, and where its
// layout primitives mark the frame, the measures, the panels and the nav (data-ds attributes).
import { data } from "../fixtures/projects/demo.mjs";
import { countTraffic, tabKeepCheck } from "../trace-tabs.mjs";
import { proseProblems } from "../trace-prose.mjs";

const menu = async (p) => p.getByRole("button", { name: "Open the menu" }).click();
const DESKTOP = [1440, 1280];
/** Waits for an element TanStack Query shows only after its retries (about 7 s for an error). */
const shown = (selector) => (p) => p.locator(selector).first().waitFor({ timeout: 30_000 });
const PHONE = [390];
/** Waits for the drawer's task, then scrolls the drawer to a section (by its heading) or an element. */
const drawerAt = (target) => async (p) => {
  const el = target.startsWith("[") ? p.locator(target).first() : p.getByRole("heading", { name: target, exact: true });
  await el.waitFor({ timeout: 15_000 });
  // Scrolled to the top, then down from under the drawer's sticky header.
  await el.evaluate((e) => {
    e.scrollIntoView({ block: "start" });
    let s = e.parentElement;
    while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    s?.scrollBy(0, -96);
  });
};
/** Opens a drawer picker (scrolled into view first, so its list opens on screen), optionally typing a search. */
const picker = (heading, button, search) => async (p) => {
  await drawerAt(heading)(p);
  await p.getByRole("button", { name: button }).click();
  if (search) await p.keyboard.type(search);
};

/** The trace's scroller (its log), and the drawer's Trace tab where it's tabs (below `xl`). */
const LOG = "[data-ds=terminal] .mantine-ScrollArea-viewport";
const traceTab = async (p) => {
  const tab = p.getByRole("tab", { name: "Trace" });
  if (await tab.count()) {
    await tab.click();
    await p.locator(LOG).first().waitFor();
    await p.waitForTimeout(300);
  }
};
/** Scroll the log to its top (where older pages load) until `text` shows. */
const toTop = (text) => async (p) => {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    await p.locator(LOG).first().evaluate((v) => v.scrollTo({ top: 0 }));
    await p.waitForTimeout(400);
    // Shown inside the log's viewport, not only rendered above it.
    const inside = await p.locator(LOG).first().evaluate((v, t) => {
      const el = [...v.querySelectorAll("[data-slot=older]")].find((e) => e.textContent.includes(t));
      if (!el) return false;
      const a = el.getBoundingClientRect();
      const b = v.getBoundingClientRect();
      return a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    }, text);
    if (inside) return;
  }
  throw new Error(`"${text}" didn't show at the top of the trace`);
};
/** Expand the last collapsed result and open its call's input, scrolled to that call. */
async function expandResult(p) {
  const tool = await p.locator("[data-kind=tool]", { has: p.locator("[data-slot=more]") }).last().elementHandle();
  await (await tool.$("[data-slot=more]")).click();
  await (await tool.$("[data-slot=call]")).click();
  await tool.evaluate((el) => el.scrollIntoView({ block: "start" }));
}

/**
 * The trace: its log never scrolls sideways (long lines wrap), and its glyphs render from a text font,
 * never an emoji font (CDP's platform fonts per glyph).
 */
async function traceCheck(page) {
  const problems = await page.evaluate(() =>
    [...document.querySelectorAll("[data-ds=terminal] .mantine-ScrollArea-viewport")]
      .filter((v) => v.clientWidth > 0 && v.scrollWidth > v.clientWidth + 1)
      .map((v) => `the trace's log scrolls sideways: ${v.scrollWidth} px of content in ${v.clientWidth} px`),
  );
  // An assistant's Markdown (README.md#the-live-trace): mono at the terminal's one size, nothing but a
  // fence or a table scrolling sideways, inside itself (trace-prose.mjs; selftest.mjs plants each failure).
  problems.push(...(await page.evaluate(proseProblems)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-ds=terminal] [data-slot=glyph], [data-kind=tool_result][data-error=true] [data-slot=text]" });
  for (const nodeId of nodeIds.slice(0, 40)) {
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    for (const f of fonts) if (/emoji/i.test(f.familyName)) problems.push(`a trace glyph renders in ${f.familyName}`);
  }
  await cdp.detach();
  return [...new Set(problems)];
}

/**
 * The manager's waits (README.md#waiting) read as words: no raw task id, no snake_case state; where the
 * context column shows (from `lg`; a closed disclosure below), the section is there when the fixture has
 * waits, and each task's and PR's line links to it (only the owner's reply is plain text).
 */
export async function waitsCheck(page) {
  return page.evaluate(() => {
    const out = [];
    const context = document.querySelector("[data-slot=manager-context]");
    const shown = !!context && context.getBoundingClientRect().height > 0 && getComputedStyle(context).visibility !== "hidden";
    const lists = [...document.querySelectorAll("[data-slot=waits], [data-slot=recent-waits]")];
    if (shown && !lists.length) out.push("the manager's context column has no waits, though the fixture has some");
    for (const list of lists) {
      const t = list.textContent ?? "";
      if (/tsk_[a-z0-9]|\b[a-z]+_[a-z]+\b/.test(t)) out.push(`the manager's waits show a raw id or state: ${t.slice(0, 120)}`);
      for (const item of list.querySelectorAll("[role=listitem]")) {
        if (!/^The owner's reply/.test((item.textContent ?? "").trim()) && !item.querySelector("a[href]")) out.push(`a wait's task or PR isn't a link: ${(item.textContent ?? "").slice(0, 80)}`);
      }
    }
    return out;
  });
}

/**
 * After a host is removed by keyboard (`page.removedNext`: the host whose row followed it), focus is on
 * that row's Remove, in the same role's panel: never <body>, nor another panel's.
 */
export async function removeFocusCheck(page) {
  const want = page.removedNext;
  const at = await page.evaluate(() => {
    const el = document.activeElement;
    return { label: el?.getAttribute("aria-label") ?? el?.tagName ?? null, role: el?.closest("[data-role]")?.getAttribute("data-role") ?? null };
  });
  return at.label === `Remove ${want.host}` && at.role === want.role ? [] : [`after removing a host by keyboard, focus is on ${at.label} (${at.role ?? "no panel"}), not ${want.role}'s Remove ${want.host}`];
}

/**
 * The description editor (README.md#descriptions), entered from a fresh page, the editor's code not yet
 * loaded: what's below the description (the Spec heading) is sampled every frame from the click until the
 * editor shows, so `editorCheck` can tell a jump through a loading placeholder from the one move into the
 * form.
 */
async function enterEdit(page) {
  const edit = page.getByRole("button", { name: "Edit the title and description" });
  await edit.waitFor();
  await page.evaluate(() => {
    window.__specTops = [];
    const t0 = performance.now();
    const tick = () => {
      const spec = [...document.querySelectorAll("h3")].find((h) => h.textContent === "Spec");
      if (spec) window.__specTops.push(Math.round(spec.getBoundingClientRect().top));
      if (performance.now() - t0 < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await edit.click();
  await page.locator("[data-ds=rich-editor] [contenteditable=true]").waitFor();
  await page.waitForTimeout(2600);
}

/**
 * The editor's layout: entering it moves what's below the description at most once (no loading
 * placeholder in between); its toolbar is one row on a phone (scrolling sideways), never stacked.
 */
async function editorCheck(page, { width }) {
  const problems = [];
  const tops = await page.evaluate(() => window.__specTops ?? null);
  if (tops) {
    const moves = tops.filter((t, i) => i > 0 && Math.abs(t - tops[i - 1]) > 1).length;
    if (moves > 1) problems.push(`entering Edit moves the page ${moves} times (the Spec heading at ${[...new Set(tops)].join(" → ")} px)`);
  }
  if (width < 768) {
    const rows = await page.evaluate(() => new Set([...document.querySelectorAll("[data-ds=rich-editor] [role=group] button")].map((b) => Math.round(b.getBoundingClientRect().top))).size);
    if (rows > 1) problems.push(`the editor's toolbar wraps into ${rows} rows on a phone`);
  }
  return problems;
}

/** At 1280 px and up, the board's six columns fit beside the sidebar without scrolling. */
async function sixColumns(page, { width }) {
  if (width < 1280) return [];
  const r = await page.evaluate(() => {
    const grid = document.querySelector("[data-ds=columns]");
    return grid && { columns: grid.children.length, scrolls: grid.scrollWidth > grid.clientWidth + 1 };
  });
  if (!r) return ["no board columns"];
  return r.columns !== 6 || r.scrolls ? [`the board shows ${r.columns} columns${r.scrolls ? " and scrolls sideways" : ""}, not six that fit`] : [];
}

// --- the chat's scrolling (the design review of #128): reading back holds your line, following holds the
// end, a new message while reading back shows a pill, and sending goes to the end. Each state's `after`
// acts like a reader (the wheel) and leaves what it measured for `check`.

/** A chat message: a bubble on the page, or a row in a log that scrolls in itself. */
const MESSAGE = "[data-ds=bubble], [data-ds=message]";
const bubbles = (p) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => Math.round(b.getBoundingClientRect().top)), MESSAGE);
const bottoms = (p) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => Math.round(b.getBoundingClientRect().bottom)), MESSAGE);
/**
 * The room below the newest message before what ends the view: the docked composer over the page, or
 * the bottom of a log that scrolls in itself (negative: hidden under it).
 */
const gapAbove = (p) => p.evaluate((sel) => {
  const last = [...document.querySelectorAll(sel)].at(-1)?.getBoundingClientRect();
  const l = document.querySelector("[data-ds=chat-log]");
  // A log that scrolls in itself ends at its bottom; else a docked composer (pinned at the bottom) does.
  const own = l && l.scrollHeight > l.clientHeight + 1;
  const f = document.querySelector("[data-ds=pinned-footer], [data-ds=composer-dock]")?.getBoundingClientRect();
  const limit = own ? l.getBoundingClientRect().bottom : f?.top;
  return last && limit !== undefined ? Math.round(limit - last.bottom) : null;
}, MESSAGE);
/** While following, the newest message is clear of the composer by at least `md` (12 px), not touching it. */
const MIN_GAP = 12;
const endProblems = (gap, when) => (gap === null ? [`${when}: no message or composer`] : gap < MIN_GAP ? [`${when}, the newest message is ${gap} px from the composer (at least ${MIN_GAP})`] : []);
/**
 * Scroll up like a reader (the wheel over the log, or the page), and the first message in view, even if
 * cut by the top: its index and top. That's the message the browser anchors on (the first visible in
 * order; only whole messages are anchors), so growth above it mustn't move it, while growth inside the
 * view moves what's below, as it should.
 */
async function readBack(p, width) {
  // Over the chat's scroller (the log, or on a phone the page's column), and its view's top.
  const log = await p.evaluate(() => {
    const l = document.querySelector("[data-ds=chat-log]");
    if (!l) return null;
    const scroller = l.scrollHeight > l.clientHeight + 1 ? l : (l.closest("[data-ds=page]") ?? l);
    const r = scroller.getBoundingClientRect();
    const top = Math.max(r.top, 0, l.getBoundingClientRect().top);
    const bottom = Math.min(r.bottom, window.innerHeight);
    return { x: r.left + r.width / 2, y: (top + bottom) / 2, top };
  });
  await p.mouse.move(log?.x ?? width / 2, log?.y ?? 300);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(80);
  }
  await p.waitForTimeout(300);
  const tops = await bubbles(p);
  const ends = await bottoms(p);
  const i = ends.findIndex((b) => b > (log?.top ?? 0));
  return { i, top: tops[i] };
}
/** Scroll the chat's scroller (the log, or on a phone the page's column) by a function of it. */
const scrollChat = (p, how) => p.locator("[data-ds=chat-log]").evaluate((l, how) => {
  const el = l.scrollHeight > l.clientHeight + 1 ? l : (l.closest("[data-ds=page]") ?? l);
  el.scrollTop = how === "top" ? 0 : el.scrollHeight / 3;
  el.dispatchEvent(new Event("scroll"));
}, how);
/** The fixture's answer for a path, as `serve` gives it. */
const fixed = (fixture, path) => data(fixture).answer("GET", path)[1];
/** Serves the fixture's chat with `extra()` appended, and takes the owner's messages (POST) into it. */
async function liveChat(p, fixture, extra = () => []) {
  const sent = [];
  await p.route((u) => u.pathname === "/api/projects/prj_demo/chat", async (route) => {
    if (route.request().method() === "POST") {
      const text = JSON.parse(route.request().postData()).text;
      sent.push({ seq: 500 + sent.length, at_ms: Date.now(), sender: "owner", text, delivered: true, error: null });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seq: 500, delivered: true }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([...fixed(fixture, "/projects/prj_demo/chat"), ...extra(), ...sent]) });
  });
}
/** The board's next poll brings longer titles: every chip above and below re-wraps (content grows). */
const longerTitles = (p, fixture) =>
  p.route((u) => u.pathname === "/api/projects/prj_demo/tasks", (route) => {
    const tasks = fixed(fixture, "/projects/prj_demo/tasks").map((t) => ({ ...t, title: `${t.title}, now with a much longer title that wraps onto another line` }));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(tasks) });
  });
// --- the live workers' push tokens agree with the saved setting ----------------------------------------

/**
 * Settings' live workers (README.md#secrets): an Applied row never contradicts the saved "Workers may
 * change CI workflows" toggle (the form not edited, its switch is what's saved); one that differs is
 * marked as such, and shown Pending. Fails without the toggle on the page. Self-contained (it runs in the selftest too).
 */
export function workflowsAgree() {
  const sw = [...document.querySelectorAll('input[role="switch"], input[type="checkbox"]')].find((i) => i.closest("label, .mantine-Switch-root")?.textContent?.includes("Workers may change CI workflows"));
  if (!sw) return ["the \"Workers may change CI workflows\" toggle isn't on the page"];
  const saved = sw.checked;
  const out = [];
  for (const row of document.querySelectorAll('[aria-label="Live workers\' push tokens"] [data-agent]')) {
    const state = row.querySelector("[data-slot=state]")?.textContent?.trim().toLowerCase();
    const line = row.querySelector("[data-slot=workflows]");
    const text = line?.textContent ?? "";
    const has = /^Still may|^Its pushes may change/.test(text);
    if (!line) out.push(`${row.getAttribute("data-agent")}: no line on its workflows`);
    else if (state === "applied" && has !== saved) out.push(`${row.getAttribute("data-agent")}: Applied, "${text}", with the toggle saved ${saved ? "on" : "off"}`);
    else if (has !== saved && line.getAttribute("data-matches") !== "false") out.push(`${row.getAttribute("data-agent")}: "${text}" differs from the saved toggle without saying so`);
    else if (has === saved && line.getAttribute("data-matches") === "false") out.push(`${row.getAttribute("data-agent")}: "${text}" says it differs from the saved toggle, which it agrees with`);
  }
  return out;
}

// --- rhythm: measured on what's painted (text and badges), never on the grown hit boxes ---------------
// Each measure is self-contained (it runs in the page, and in the selftest on planted pages).

/**
 * A task's PRs keep their proximity: within one PR (its number and title, its badges, its meta line),
 * each gap is at most half the gap to the next PR.
 */
export function inkPrs() {
  const ink = (el) => {
    let t = Infinity, b = -Infinity;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.height > 0) [t, b] = [Math.min(t, q.top), Math.max(b, q.bottom)];
    }
    for (const bd of el.querySelectorAll(".mantine-Badge-root")) {
      const q = bd.getBoundingClientRect();
      if (q.height > 0) [t, b] = [Math.min(t, q.top), Math.max(b, q.bottom)];
    }
    return t === Infinity ? null : { top: t, bottom: b };
  };
  const out = [];
  const prs = [...document.querySelectorAll("[data-pr]")].filter((e) => e.getBoundingClientRect().height > 0);
  for (let i = 0; i < prs.length; i++) {
    const lines = [...prs[i].children].map(ink).filter(Boolean);
    const next = prs[i + 1] && ink(prs[i + 1].children[0]);
    if (!next || lines.length < 2) continue;
    const between = Math.round(next.top - lines.at(-1).bottom);
    for (let k = 1; k < lines.length; k++) {
      const within = Math.round(lines[k].top - lines[k - 1].bottom);
      if (within > between / 2) out.push(`PR ${prs[i].getAttribute("data-pr")}: line ${k + 1} is ${within} px below line ${k}, the next PR ${between} px away (within a PR at most half)`);
    }
  }
  return out;
}

/**
 * A transcript keeps its proximity: a tool call's gap to its result is at most half its gap to the next
 * call, consecutive calls taken in document order (each sits in a wrapper of its own).
 */
export function inkTrace() {
  const ink = (el) => {
    let t = Infinity, b = -Infinity;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.height > 0) [t, b] = [Math.min(t, q.top), Math.max(b, q.bottom)];
    }
    return t === Infinity ? null : { top: t, bottom: b };
  };
  const out = [];
  const groups = [...document.querySelectorAll("[data-ds=terminal] [data-kind=tool]")].filter((g) => g.getBoundingClientRect().height > 0);
  let pairs = 0;
  for (let i = 0; i + 1 < groups.length; i++) {
    const call = groups[i].querySelector("[data-slot=call]");
    const result = groups[i].querySelector("[data-kind=tool_result]");
    const nextCall = groups[i + 1].querySelector("[data-slot=call]");
    const [c, r, g, n] = [call && ink(call), result && ink(result), ink(groups[i]), nextCall && ink(nextCall)];
    if (!c || !r || !g || !n) continue;
    pairs++;
    const within = Math.round(r.top - c.bottom);
    const between = Math.round(n.top - g.bottom);
    if (within > between / 2) out.push(`"${call.textContent.slice(0, 30)}": ${within} px to its result, ${between} px to the next call (within a call at most half)`);
  }
  if (pairs === 0 && groups.length > 1) out.push(`no consecutive tool calls with results measured among ${groups.length}`);
  return out;
}

/** The page header's rhythm: from the h1's text to its meta line's text (the round-5 bug moved the text). */
export function inkHeaderGap() {
  const ink = (el) => {
    let t = Infinity, b = -Infinity;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim()) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const q of r.getClientRects()) if (q.height > 0) [t, b] = [Math.min(t, q.top), Math.max(b, q.bottom)];
    }
    return t === Infinity ? null : { top: t, bottom: b };
  };
  const h1 = document.querySelector("[data-ds=page-header] h1");
  const meta = document.querySelector("[data-ds=page-header] [data-slot=meta]");
  const [a, b] = [h1 && ink(h1), meta && ink(meta)];
  return a && b ? Math.round(b.top - a.bottom) : null;
}

const touchOnly = (fn) => async (p, { width }) => (width >= 600 ? [] : p.evaluate(fn));
const prProximity = touchOnly(inkPrs);
const traceProximity = touchOnly(inkTrace);

/** The header's gap, touch against mouse, within 4 px. */
const headerRhythm = async (p, { width }) => {
  if (width >= 600) return [];
  const touch = await p.evaluate(inkHeaderGap);
  const ctx = await p.context().browser().newContext({ viewport: p.viewportSize(), reducedMotion: "reduce" });
  const mouse = await ctx.newPage();
  await app.serve(mouse, { fixture: "demo" });
  await mouse.goto(p.url(), { waitUntil: "networkidle" });
  await mouse.locator("h1").first().waitFor();
  await mouse.waitForTimeout(800);
  const m = await mouse.evaluate(inkHeaderGap);
  await ctx.close();
  if (touch === null || m === null) return ["the page header's h1 or meta line isn't on the page"];
  return Math.abs(touch - m) > 4 ? [`the header's meta text is ${touch} px below the h1's on touch, ${m} px with a mouse: a touch target grew its line`] : [];
};

/**
 * Touch doesn't change the rhythm: the same page at the same width, without touch, lays out the same.
 * A touch target grows its hit box, never its line, so these blocks' heights (and so proximity: a call
 * and its result, a title and its meta) match within a few px.
 */
const rhythm = (fixture, blocks, after) => async (p, { width }) => {
  if (width >= 600) return [];
  // A block is a selector (its height; a terminal's, its transcript's) or [from, to] (the gap from one's
  // bottom to the other's top: a title and its meta line).
  const measure = (pg) => pg.evaluate((specs) => specs.map((s) => {
    if (Array.isArray(s)) {
      const [a, b] = s.map((x) => document.querySelector(x)?.getBoundingClientRect());
      return a && b ? Math.round(b.top - a.bottom) : null;
    }
    const el = document.querySelector(s);
    return el ? Math.round(s.includes("terminal") ? el.querySelector(".mantine-ScrollArea-viewport")?.scrollHeight ?? el.scrollHeight : el.getBoundingClientRect().height) : null;
  }), blocks);
  const touch = await measure(p);
  const ctx = await p.context().browser().newContext({ viewport: p.viewportSize(), reducedMotion: "reduce" });
  const mouse = await ctx.newPage();
  await app.serve(mouse, { fixture });
  await mouse.goto(p.url(), { waitUntil: "networkidle" });
  await mouse.locator("h1").first().waitFor();
  await mouse.waitForTimeout(800);
  if (after) {
    await after(mouse);
    await mouse.waitForTimeout(800);
  }
  const m = await measure(mouse);
  await ctx.close();
  const name = (b) => (Array.isArray(b) ? `the gap from ${b[0]} to ${b[1]}` : b);
  return blocks.flatMap((b, i) => (touch[i] === null || m[i] === null ? [`${name(b)}: not on the page`] : Math.abs(touch[i] - m[i]) > 4 ? [`${name(b)} is ${touch[i]} px on touch, ${m[i]} px with a mouse: touch targets grew its lines`] : []));
};



/**
 * The chat fits the viewport, at both ends of its scroll (the log, or on a phone the page's column):
 * the document itself never scrolls; the composer is fully on screen and pinned at the viewport's
 * bottom (within the page's bottom padding); and at the end, right under the log.
 */
export function inkChatFit() {
  const out = [];
  const doc = document.documentElement;
  const log = document.querySelector("[data-ds=chat-log]");
  const dock = document.querySelector("[data-ds=composer-dock]");
  const field = dock?.querySelector("textarea");
  if (!log || !dock || !field) return ["no chat log or composer on the page"];
  // The log scrolls itself from `sm` up (overflow auto, even while it's short); on a phone the page's
  // column does.
  const ownScroll = /(auto|scroll)/.test(getComputedStyle(log).overflowY);
  const scroller = ownScroll ? log : (log.closest("[data-ds=page]") ?? log);
  const was = scroller.scrollTop;
  const H = window.innerHeight;
  window.scrollTo(0, 1e6);
  if (window.scrollY > 0 || doc.scrollHeight > H + 1) out.push(`the document scrolls ${doc.scrollHeight - H} px (only the chat should)`);
  window.scrollTo(0, 0);
  for (const end of ["top", "end"]) {
    scroller.scrollTop = end === "top" ? 0 : scroller.scrollHeight;
    const f = field.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    if (f.top < 0 || f.bottom > H + 0.5) out.push(`at the ${end}, the composer is off screen (${Math.round(f.top)}..${Math.round(f.bottom)} of ${H})`);
    // Pinned: flush on a phone (the page's column has no bottom padding), within the page's padding else.
    const slack = ownScroll ? 64 : 4;
    if (d.bottom < H - slack) out.push(`at the ${end}, the composer sits ${Math.round(H - d.bottom)} px above the viewport's bottom, not pinned there`);
    if (end === "end") {
      // The log's last line on screen: its own bottom when it scrolls itself, else its content's end.
      const l = log.getBoundingClientRect();
      const gap = Math.round(d.top - Math.min(l.bottom, H));
      if (gap > 32) out.push(`at the end, the composer is ${gap} px below the log (right under it)`);
    }
  }
  scroller.scrollTop = was;
  return out;
}

/**
 * The chat fits the viewport: the page itself doesn't scroll (only the log does, or on a phone the
 * page's column), and the composer is on screen.
 */
async function chatFits(p) {
  const problems = await p.evaluate(inkChatFit);
  return problems;
}/** The context column beside the chat: all of it shown when it fits the viewport, scrolling only when it doesn't. */
async function contextShown(p) {
  return p.evaluate(() => {
    const c = document.querySelector("[data-slot=context]");
    if (!c) return [];
    const r = c.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    return c.scrollHeight > c.clientHeight + 1 && room > 48 ? [`the context column scrolls ${c.scrollHeight - c.clientHeight} px inside itself with ${Math.round(room)} px of the viewport free below it`] : [];
  });
}
/** An empty chat on a phone and below `sm` (390, 600 wide, a 768×1024 portrait tablet): the composer flush at the bottom. */
async function chatFitsNarrow(p) {
  const was = p.viewportSize();
  const out = (await p.evaluate(inkChatFit)).map((x) => `${was.width} px: ${x}`);
  for (const [width, height] of [[600, 960], [768, 1024]]) {
    await p.setViewportSize({ width, height });
    await p.waitForTimeout(600);
    out.push(...(await p.evaluate(inkChatFit)).map((x) => `${width}×${height}: ${x}`));
  }
  await p.setViewportSize(was);
  await p.waitForTimeout(300);
  return out;
}
/** A two-line draft (Shift+Enter between), still in the composer, unsent; and the chat still fits. */
/** Focus inside a message (its steps' button) shows its meta row (time, actions), as hover does. */
async function metaOnFocus(p) {
  const row = p.locator("[data-sender=manager]", { has: p.getByRole("button", { name: "Used 4 tools" }) });
  const opacity = await row.locator("[data-slot=meta]").evaluate((e) => getComputedStyle(e).opacity);
  return opacity === "1" ? [] : [`focus inside a message leaves its time and actions hidden (opacity ${opacity})`];
}

async function draftKept(p) {
  const problems = await chatFits(p);
  const value = await p.locator("[data-ds=composer-dock] textarea").inputValue();
  if (!value.includes("\n") || !value.endsWith("with prices and tags.")) problems.push(`the draft isn't both lines in the composer: ${JSON.stringify(value)}`);
  return problems;
}

/** A task card's PR link opens the PR (a new tab on GitHub), not the task the whole card links to. */
const cardPrLink = (p) => prLinkIn(p, "[data-slot=manager-context] [data-ds=task-card]", "a context card");
const chatCardPrLink = (p) => prLinkIn(p, "[data-ds=rich] [data-ds=task-card]", "a chat card");
async function prLinkIn(p, cards, where) {
  await p.context().route(/^https:\/\/github\.com\//, (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>PR</title>" }));
  const card = p.locator(cards, { hasText: "#118" }).first();
  await card.scrollIntoViewIfNeeded();
  const link = card.getByRole("link", { name: "#118" });
  const before = p.url();
  const [tab] = await Promise.all([p.context().waitForEvent("page", { timeout: 5_000 }).catch(() => null), link.click()]);
  const problems = [];
  if (!tab || !/github\.com\/[^/]+\/[^/]+\/pull\/118/.test(tab.url())) problems.push(`clicking "#118" in ${where} didn't open the PR (${tab?.url() ?? "no new tab"})`);
  if (p.url() !== before) problems.push(`clicking "#118" in ${where} navigated the page to ${p.url()}`);
  await tab?.close();
  return problems;
}
const stash = (p, problems) => p.evaluate((x) => { window.__reviewProblems = x; }, problems);
const stashed = (p) => p.evaluate(() => window.__reviewProblems ?? ["the scenario didn't run"]);
const reply = (seq, text) => ({ seq, at_ms: Date.now(), sender: "manager", text, delivered: true, error: null });

const scroll = {
  /** Reading back while chips above and below re-wrap on the board's poll: the line stays. */
  readbackGrowth: (fixture) => async (p) => {
    const w = p.viewportSize().width;
    const r0 = await readBack(p, w);
    await longerTitles(p, fixture);
    await p.waitForTimeout(6_000);
    const shift = (await bubbles(p))[r0.i] - r0.top;
    await stash(p, Math.abs(shift) > 2 ? [`reading back, the line moved ${shift} px as content above grew`] : []);
  },
  /** A reply arrives while reading back: the line stays, and a pill says so. */
  readbackNew: (fixture) => async (p) => {
    let extra = [];
    await liveChat(p, fixture, () => extra);
    const w = p.viewportSize().width;
    const r0 = await readBack(p, w);
    extra = [reply(100, "A new reply while you read back: task:tsk_demo7 is merged.")];
    await p.waitForTimeout(4_000);
    const problems = [];
    const shift = (await bubbles(p))[r0.i] - r0.top;
    if (Math.abs(shift) > 2) problems.push(`reading back, a new reply moved the line ${shift} px`);
    const pill = p.getByRole("button", { name: /new message|jump to latest/i });
    if (!(await pill.count())) problems.push("a reply arrived while reading back, with no cue");
    else {
      await pill.first().click();
      await p.waitForTimeout(600);
      problems.push(...endProblems(await gapAbove(p), "after the pill"));
    }
    await stash(p, problems);
  },
  /** Sending while reading back: the page goes to the end, your message clear of the composer. */
  sendReadback: (fixture) => async (p) => {
    await liveChat(p, fixture);
    await readBack(p, p.viewportSize().width);
    await p.getByLabel("Message to the manager").fill("Sent while reading back");
    // Send, as on a phone (where Enter is a new line).
    await p.getByRole("button", { name: "Send" }).click();
    await p.waitForTimeout(1_000);
    // The last message the owner or the manager sent (a turn still streaming comes after it).
    const last = await p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((m) => m.getAttribute("data-sender") !== "stream").at(-1)?.textContent ?? "", MESSAGE);
    const problems = [];
    if (!last.includes("Sent while reading back")) problems.push("the sent message isn't the last one shown");
    problems.push(...endProblems(await gapAbove(p), "after sending"));
    await stash(p, problems);
  },
  /** On open and while content grows (chips re-wrapping on a poll): the newest message stays clear. */
  followGrowth: (fixture) => async (p) => {
    const problems = endProblems(await gapAbove(p), "on open");
    await longerTitles(p, fixture);
    await p.waitForTimeout(6_000);
    problems.push(...endProblems(await gapAbove(p), "after growth"));
    await stash(p, problems);
  },
};

const app = {
  dir: "projects",
  ready: "/projects",
  errorText: "This page hit an error",
  selectors: {
    frame: "[data-ds=page]",
    header: "[data-ds=page-header]",
    measure: "[data-measure]",
    containers: ["[data-ds=panel]", "[data-ds=table-frame]"],
    nav: { rows: "[data-ds=nav-row], [data-ds=switcher]", brand: "#sidebar [aria-label='nest projects: all projects']", active: "[aria-current=page]" },
    // A manager's message: its headings demoted below the page's (an h4 at most), its figures on a light canvas.
    content: { root: "[data-ds=rich]", minHeading: 4, figures: "[data-ds=figure-canvas]" },
  },
  /** Installs the fixtures for a state before the page loads. */
  async serve(page, state) {
    const { answer, trace, history } = data(state.fixture ?? "demo");
    const traffic = countTraffic(page);
    await page.routeWebSocket(/\/api\/agents\/[^/]+\/trace/, (ws) => {
      traffic.socket();
      for (const e of trace) ws.send(JSON.stringify(e));
      ws.onMessage((m) => m === "ping" && ws.send("pong"));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      // The trace's history (older pages); a state may hold every page asked for after it sets `holdHistory`.
      if (/^\/api\/agents\/[^/]+\/trace\/history$/.test(url.pathname)) {
        traffic.historyPage();
        if (page.holdHistory) return new Promise(() => {});
        const p = history[url.searchParams.get("before") ?? ""];
        return route.fulfill({ status: p ? 200 : 400, contentType: "application/json", body: JSON.stringify(p ?? { error: "unknown cursor" }) });
      }
      const [status, body] = answer(route.request().method(), url.pathname.replace(/^\/api/, ""), url.searchParams);
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
  },
  // `section`: views compared for a stable frame. `ready` waits for what the screen is of. `full: false` captures (and checks) only the
  // viewport, for an open overlay. `widths` limits a state to some widths.
  states: [
    { name: "projects", section: "top", path: "/projects" },
    // A project still being created (README.md#creating-a-project).
    { name: "projects-creating", section: "top", path: "/projects", fixture: "creating" },
    { name: "projects-empty", section: "top", path: "/projects", fixture: "empty" },
    { name: "projects-error", section: "top", path: "/projects", fixture: "error", httpErrors: true, ready: shown("[data-ds=error]") },
    { name: "new-project", section: "top", path: "/projects", full: false, after: (p) => p.getByRole("button", { name: "New project" }).first().click() },
    { name: "admin", section: "top", path: "/admin" },
    { name: "board", section: "project", path: "/projects/prj_demo/board", check: sixColumns, checkName: "board-columns" },
    { name: "board-long", section: "project", path: "/projects/prj_demo/board", fixture: "long" },
    { name: "board-needs-you-all", section: "project", path: "/projects/prj_demo/board", after: (p) => p.getByRole("button", { name: /Show all/ }).click() },
    // The task drawer: details and the worker's trace (history and live), side by side from `xl`, tabs below.
    { name: "drawer", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace" },
    { name: "drawer-trace-tab", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, widths: [1280, 390], after: traceTab, check: traceCheck, checkName: "trace" },
    // Switching the drawer's tabs away from the trace and back keeps it: no second socket, no refetch, scroll and expansion kept.
    { name: "drawer-trace-tabs", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, widths: [1280, 390], check: tabKeepCheck, checkName: "trace-tabs" },
    { name: "drawer-trace-expanded", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); await expandResult(p); } },
    { name: "drawer-trace-loading", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); p.holdHistory = true; await toTop("loading earlier…")(p); } },
    { name: "drawer-trace-beginning", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); await toTop("the beginning of the trace")(p); } },
    { name: "drawer-stalled-pr", section: "project", path: "/projects/prj_demo/board?task=tsk_demo8", fixture: "machine", full: false },
    { name: "drawer-stalled-pr-history", section: "project", path: "/projects/prj_demo/board?task=tsk_demo8", fixture: "machine", full: false, after: drawerAt("History") },
    { name: "drawer-ready-pr", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", fixture: "machine", full: false },
    { name: "drawer-ready-pr-history", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", fixture: "machine", full: false, after: drawerAt("History") },
    { name: "drawer-no-worker", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false },
    // A task's PRs and dependencies (PR #127): several PRs in mixed states, a task waiting on others,
    // one that others wait on, one that's over; both pickers, open and with no match; the card's tooltip.
    { name: "board-waiting-tooltip", section: "project", path: "/projects/prj_demo/board", full: false, after: async (p) => { const b = p.locator("[data-task=tsk_demo4] [data-marker=waiting]"); await b.scrollIntoViewIfNeeded(); await b.focus(); } },
    { name: "drawer-prs", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: drawerAt("Pull requests") },
    { name: "drawer-prs-deps", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: drawerAt("Dependencies") },
    { name: "drawer-waiting", section: "project", path: "/projects/prj_demo/board?task=tsk_demo4", full: false },
    { name: "drawer-waiting-deps", section: "project", path: "/projects/prj_demo/board?task=tsk_demo4", full: false, after: drawerAt("Pull requests") },
    { name: "drawer-blocks-deps", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: drawerAt("Pull requests") },
    { name: "drawer-deps-done", section: "project", path: "/projects/prj_demo/board?task=tsk_demo6", full: false, after: drawerAt("Dependencies") },
    { name: "drawer-over", section: "project", path: "/projects/prj_demo/board?task=tsk_demo9", full: false, after: drawerAt("Pull requests") },
    // A done task made of an issue that GitHub refused to close: why, and the retry.
    { name: "drawer-issue-failed", section: "project", path: "/projects/prj_demo/board?task=tsk_demo9", full: false },
    { name: "attach-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR") },
    { name: "attach-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR", "zzz") },
    { name: "attach-picker-typed", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR", "130") },
    { name: "task-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency") },
    // The confirmations before detaching a PR and removing a dependency.
    { name: "detach-confirm", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: async (p) => { await drawerAt("Pull requests")(p); await p.getByRole("button", { name: "Detach PR #121" }).click(); } },
    { name: "remove-dependency-confirm", section: "project", path: "/projects/prj_demo/board?task=tsk_demo4", full: false, after: async (p) => { await drawerAt("Dependencies")(p); await p.getByRole("button", { name: "Stop waiting on Cache gadget thumbnails" }).click(); } },
    { name: "task-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency", "zzz") },
    { name: "new-task", section: "project", path: "/projects/prj_demo/board", full: false, check: editorCheck, checkName: "editor", after: async (p) => { await p.getByRole("button", { name: "New task" }).click(); await p.locator("[data-ds=rich-editor] [contenteditable=true]").waitFor(); } },
    // A task's description (README.md#descriptions): edited in the rich editor, a table kept as written;
    // typed into, with the toolbar showing what's on; the new task's editor focused.
    { name: "drawer-edit", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: enterEdit, check: editorCheck, checkName: "editor" },
    // Escape in the description's text, with a change: the form's own Escape, so it asks before
    // discarding (the editor's keymap would take it; jsdom can't tell, a browser can).
    { name: "drawer-edit-escape", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, checkName: "editor", after: async (p) => {
      await p.getByRole("button", { name: "Edit the title and description" }).click();
      await p.getByRole("textbox", { name: "Details" }).getByText(/^Owners filter/).click();
      await p.keyboard.type("x");
      await p.keyboard.press("Escape");
      await p.getByRole("dialog", { name: "Discard changes?" }).waitFor({ timeout: 3000 }).catch(() => {});
    }, check: async (p) => ((await p.getByRole("dialog", { name: "Discard changes?" }).count()) === 1 ? [] : ["Escape in the description's text with a change doesn't ask to discard it"]) },
    { name: "drawer-edit-typing", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: editorCheck, checkName: "editor", after: async (p) => {
      await p.getByRole("button", { name: "Edit the title and description" }).click();
      // The caret at the end of the scope's last item, as a click past its text puts it.
      const item = p.getByRole("textbox", { name: "Details" }).getByText("Suggestions in the filter bar as you type");
      await item.click();
      await item.evaluate((el) => {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        getSelection().removeAllRanges();
        getSelection().addRange(r);
      });
      await p.keyboard.press("Enter");
      await p.getByRole("button", { name: "Bold" }).click();
      await p.keyboard.type("Keyboard shortcuts");
    } },
    { name: "new-task-typing", section: "project", path: "/projects/prj_demo/board", full: false, check: editorCheck, checkName: "editor", after: async (p) => {
      await p.getByRole("button", { name: "New task" }).click();
      await p.getByLabel("Title").fill("Export gadgets as JSON");
      await p.getByRole("textbox", { name: "Details" }).click();
      await p.getByRole("button", { name: "Task list" }).click();
      await p.keyboard.type("Same columns as the CSV");
    } },
    { name: "manager", section: "project", path: "/projects/prj_demo/manager", full: false, check: waitsCheck, checkName: "waits" },
    // Ended past its automatic restarts: why, and the owner's Restart (README.md#the-manager-lifecycle).
    { name: "manager-ended", section: "project", path: "/projects/prj_demo/manager", fixture: "manager-ended", full: false },
    { name: "manager-rich", section: "project", path: "/projects/prj_demo/manager", fixture: "rich" },
    { name: "manager-rich-view", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false },
    { name: "manager-empty", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false },
    // The owner's messages still being sent (owed; retrying, with why): no Retry, unlike the failed one in "manager".
    { name: "chat-sending", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-sending", full: false },
    { name: "manager-long", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false },
    { name: "manager-long-full", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long" },
    { name: "manager-context-open", section: "project", path: "/projects/prj_demo/manager", widths: PHONE, after: (p) => p.getByRole("button", { name: "About the manager" }).click() },
    { name: "svg-modal", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false, widths: DESKTOP, after: (p) => p.getByRole("button", { name: /Search pipeline: open larger/ }).click() },
    { name: "card-pr-link", section: "project", path: "/projects/prj_demo/manager", full: false, widths: DESKTOP, check: cardPrLink, checkName: "card-links" },
    { name: "card-pr-link-chat", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false, widths: DESKTOP, check: chatCardPrLink, checkName: "card-links" },
    // Touch keeps the rhythm (checks: `rhythm`): text beside a control lays out as with a mouse (the
    // header's meta under its h1, the Manager's context), and the trace keeps its proximity. (Rows of
    // controls, like a project card's title and repo, take a 44 px pitch instead: data-touch-pitch.)
    { name: "rhythm-header", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, widths: PHONE, check: headerRhythm, checkName: "rhythm" },
    { name: "rhythm-prs", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, widths: PHONE, after: drawerAt("Pull requests"), check: prProximity, checkName: "rhythm" },
    { name: "rhythm-trace", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, widths: PHONE, check: traceProximity, checkName: "rhythm" },
    { name: "rhythm-context", section: "project", path: "/projects/prj_demo/manager", widths: PHONE, after: (p) => p.getByRole("button", { name: "About the manager" }).click(), check: rhythm("demo", ["[data-slot=manager-context]"], (p) => p.getByRole("button", { name: "About the manager" }).click()), checkName: "rhythm" },
    // The chat fits the viewport (checks: `chat-fit`): the page doesn't scroll, the composer is on screen.
    { name: "chat-fit", section: "project", path: "/projects/prj_demo/manager", full: false, check: chatFits, checkName: "chat-fit" },
    { name: "context-empty-chat", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false, widths: DESKTOP, check: contextShown, checkName: "clipping" },
    { name: "chat-fit-empty", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false, widths: PHONE, check: chatFitsNarrow, checkName: "chat-fit" },
    { name: "chat-fit-long", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, check: chatFits, checkName: "chat-fit" },
    // The chat (README.md#the-manager-chat): a turn streaming with its tool calls and Stop; the composer
    // with a draft; the jump-to-latest pill; older history paged in; a message's actions; the unread dot.
    { name: "chat-streaming", section: "project", path: "/projects/prj_demo/manager", full: false, ready: shown("[data-sender=stream]") },
    // A reply's steps behind "Used 4 tools", opened, with one call's input and result; a call of the
    // running turn opened in place.
    { name: "chat-steps", section: "project", path: "/projects/prj_demo/manager", full: false, ready: shown("[data-ds=steps-disclosure]"), after: async (p) => { await p.getByRole("button", { name: "Used 4 tools" }).click(); await p.getByRole("button", { name: /^write_spec tsk_demo7/ }).click(); await p.waitForTimeout(400); } },
    // The code-block palette (the skill's syntax table): TypeScript, a diff, JSON and a console session.
    { name: "chat-code", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-code", full: false, ready: shown("[data-ds=code-block] [data-highlighted]") },
    // A heavy reply: a 60-line code block showing its first 20 (then all of it), a table wider than the measure.
    { name: "chat-heavy", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-heavy", full: false, ready: shown("[data-ds=code-block]") },
    { name: "chat-heavy-all", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-heavy", full: false, ready: shown("[data-ds=code-block]"), after: async (p) => { await p.getByRole("button", { name: "Show all 60 lines" }).click(); await p.waitForTimeout(300); } },
    // A running turn a dozen calls in: its last steps, the earlier ones folded above them.
    { name: "chat-busy", section: "project", path: "/projects/prj_demo/manager", fixture: "turn-busy", full: false, ready: shown("[data-sender=stream] [data-ds=steps-disclosure]") },
    // The keyboard reaches a message's time and actions: focus inside it reveals them, as hover does.
    { name: "chat-keyboard", section: "project", path: "/projects/prj_demo/manager", full: false, widths: DESKTOP, ready: shown("[data-ds=steps-disclosure]"), after: async (p) => { await p.getByRole("button", { name: "Used 4 tools" }).focus(); await p.waitForTimeout(300); }, check: metaOnFocus, checkName: "chat-fit" },
    { name: "chat-tool-open", section: "project", path: "/projects/prj_demo/manager", full: false, ready: shown("[data-sender=stream] [data-ds=step]"), after: async (p) => { await p.getByRole("button", { name: /^Bash git push origin search-by-tag, failed/ }).click(); await p.waitForTimeout(400); } },
    { name: "chat-draft", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false, after: async (p) => { await p.getByRole("button", { name: /^Spec a task for/ }).click(); await p.keyboard.type("exporting gadgets as CSV,"); await p.keyboard.press("Shift+Enter"); await p.keyboard.type("with prices and tags."); }, check: draftKept, checkName: "chat-fit" },
    { name: "chat-jump", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-arriving", full: false, after: async (p) => { await scrollChat(p, "third"); await p.getByRole("button", { name: /Jump to latest/ }).waitFor({ timeout: 10_000 }); } },
    { name: "chat-older", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-paged", full: false, after: async (p) => { await scrollChat(p, "top"); await p.getByText("Message 22: how is the search work going?").waitFor({ timeout: 10_000 }); } },
    { name: "chat-actions", section: "project", path: "/projects/prj_demo/manager", full: false, after: async (p) => { await p.getByRole("button", { name: "Message actions" }).first().click(); await p.getByRole("menuitem", { name: /Quote in a reply/ }).waitFor(); } },
    { name: "unread-dot", section: "project", path: "/projects/prj_demo/board", full: false, ready: shown("[data-marker=unread]") },
    // The chat's scrolling, acted out (checks: `chat-scroll`).
    { name: "chat-readback-growth", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.readbackGrowth("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-readback-new", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.readbackNew("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-send-readback", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.sendReadback("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-follow-growth", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false, widths: [1440, 390], after: scroll.followGrowth("rich"), check: stashed, checkName: "chat-scroll" },
    { name: "manager-trace", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, check: traceCheck, checkName: "trace" },
    { name: "manager-trace-connecting", section: "project", path: "/projects/prj_demo/manager?view=trace", fixture: "connecting", full: false, check: traceCheck, checkName: "trace", ready: shown("[data-ds=terminal] [data-ds=loading] p, [data-ds=terminal] [data-ds=loading] .mantine-Text-root") },
    { name: "manager-trace-beginning", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, check: traceCheck, checkName: "trace", after: toTop("the beginning of the trace") },
    { name: "reviews", section: "project", path: "/projects/prj_demo/reviews" },
    { name: "reviews-trace", section: "project", path: "/projects/prj_demo/reviews", after: (p) => p.getByRole("button", { name: "Show the trace of #118" }).click(), check: traceCheck, checkName: "trace" },
    // The Routines page (README.md#routines): routines in each state, proposals, runs, memory; empty; the editor; a run opened with its trace.
    { name: "routines", section: "project", path: "/projects/prj_demo/routines" },
    { name: "routines-empty", section: "project", path: "/projects/prj_demo/routines", fixture: "routines-empty" },
    { name: "routines-long", section: "project", path: "/projects/prj_demo/routines", fixture: "routines-long" },
    { name: "routines-add", section: "project", path: "/projects/prj_demo/routines", full: false, after: (p) => p.getByRole("button", { name: "Add routine" }).click() },
    { name: "routine-edit", section: "project", path: "/projects/prj_demo/routines", full: false, after: (p) => p.getByRole("button", { name: "Edit Dreaming" }).click() },
    { name: "routine-new", section: "project", path: "/projects/prj_demo/routines", full: false, after: async (p) => { await p.getByRole("button", { name: "Add routine" }).click(); await p.getByRole("menuitem", { name: /Custom routine/ }).click(); } },
    { name: "routines-run-open", section: "project", path: "/projects/prj_demo/routines", after: async (p) => { const b = p.getByRole("button", { name: "Show run 2 of Dreaming" }); await b.scrollIntoViewIfNeeded(); await b.click(); await p.locator("[data-ds=terminal]").first().waitFor(); }, check: traceCheck, checkName: "trace" },
    // The Network page (README.md#network): rules per role, live agents applied, pending and failed; empty; a host refused.
    { name: "network", section: "project", path: "/projects/prj_demo/network" },
    { name: "network-empty", section: "project", path: "/projects/prj_demo/network", fixture: "network-empty" },
    // Agents nest refused to stop: why, Retry and Dismiss (README.md#outboxes).
    { name: "network-stops-failed", section: "project", path: "/projects/prj_demo/network", fixture: "stops-failed", full: false },
    { name: "network-stops-long", section: "project", path: "/projects/prj_demo/network", fixture: "stops-long", full: false },
    { name: "network-stop-dismiss", section: "project", path: "/projects/prj_demo/network", fixture: "stops-failed", full: false, after: (p) => p.getByRole("button", { name: "Dismiss the stop of agt_r2m9x4" }).click() },
    { name: "network-refused", section: "project", path: "/projects/prj_demo/network", full: false, after: async (p) => {
      const role = p.locator("[data-role=manager]");
      await role.getByLabel("Add hosts").first().click();
      await p.getByRole("option", { name: "Custom host" }).click();
      await role.getByLabel("Host", { exact: true }).fill("evil.example.org");
      await role.getByRole("button", { name: "Add" }).click();
      await role.getByRole("alert").waitFor();
      await role.evaluate((el) => el.scrollIntoView({ block: "center" }));
    } },
    // The Secrets page (README.md#secrets): the table and the live agents' layers; empty; the form; deleting.
    { name: "secrets", section: "project", path: "/projects/prj_demo/secrets" },
    { name: "secrets-empty", section: "project", path: "/projects/prj_demo/secrets", fixture: "secrets-empty" },
    { name: "secret-form", section: "project", path: "/projects/prj_demo/secrets", full: false, after: (p) => p.getByRole("button", { name: "Add a secret" }).click() },
    { name: "secret-edit", section: "project", path: "/projects/prj_demo/secrets", full: false, after: (p) => p.getByRole("button", { name: "Edit uploads_key" }).click() },
    { name: "board-secret-requests", section: "project", path: "/projects/prj_demo/board", fixture: "secret-requests" },
    // Reviews held for approval in "Needs you" (README.md#the-review-gate); the Reviews page's own rows are in `reviews`.
    { name: "board-held-reviews", section: "project", path: "/projects/prj_demo/board", fixture: "held-reviews", after: async (p) => { await p.getByRole("button", { name: /Show all/ }).click(); } },
    // Many, with long titles and logins: pinned first on Reviews, and all of them in "Needs you".
    { name: "reviews-held-many", section: "project", path: "/projects/prj_demo/reviews", fixture: "held-many" },
    { name: "board-held-many", section: "project", path: "/projects/prj_demo/board", fixture: "held-many", after: async (p) => { await p.getByRole("button", { name: /Show all/ }).click(); } },
    // The gate turned off: the switch off, with what that means.
    { name: "settings-reviews-open", section: "project", path: "/projects/prj_demo/settings", fixture: "reviews-open" },
    { name: "secret-delete", section: "project", path: "/projects/prj_demo/secrets", full: false, after: (p) => p.getByRole("button", { name: "Delete cloudflare_token" }).click() },
    // Removing a host by keyboard leaves focus on a Remove button (the next row's), never <body>.
    { name: "network-remove-keyboard", section: "project", path: "/projects/prj_demo/network", full: false, checkName: "network", after: async (p) => {
      const removes = p.locator("[data-role=worker]").getByRole("button", { name: /^Remove / });
      p.removedNext = { role: "worker", host: (await removes.nth(1).getAttribute("aria-label")).replace(/^Remove /, "") };
      await removes.first().focus();
      await p.keyboard.press("Enter");
      await p.waitForTimeout(200);
    }, check: removeFocusCheck },
    // A host saved before the operator narrowed the grant: kept, marked, not applied.
    { name: "network-narrowed", section: "project", path: "/projects/prj_demo/network", fixture: "network-narrowed", full: false, checkName: "network", after: async (p) => {
      await p.locator('[data-host="downloads.gadgets.example.com"]').evaluate((el) => el.scrollIntoView({ block: "center" }));
    }, check: async (p) => {
      const t = await p.locator('[data-role=worker] [data-host="downloads.gadgets.example.com"]').textContent();
      return /Outside the grant now: kept, not applied/.test(t ?? "") ? [] : [`the narrowed grant's kept host isn't marked: ${t}`];
    } },
    // A refused save: the reason under Save and the named host's row in the danger shade, no toast.
    { name: "network-save-refused", section: "project", path: "/projects/prj_demo/network", fixture: "network-save-refused", httpErrors: true, full: false, checkName: "network", after: async (p) => {
      await p.locator("[data-role=worker]").getByRole("button", { name: "Remove nodejs.org" }).click();
      await p.getByRole("button", { name: "Save" }).click();
      await p.locator("[data-slot=save-error]").waitFor({ timeout: 3000 }).catch(() => {});
      await p.locator("[data-slot=save-error]").evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => {});
    }, check: async (p) => {
      const r = await p.evaluate(() => ({
        error: !!document.querySelector("[data-slot=save-error]")?.textContent?.includes("isn't in this app's grant"),
        row: !!document.querySelector('[data-host="downloads.gadgets.example.com"][data-problem="true"]'),
        toast: !!document.querySelector(".mantine-Notification-root"),
      }));
      return [...(r.error ? [] : ["a refused save shows no reason under Save"]), ...(r.row ? [] : ["a refused save doesn't mark the host it names"]), ...(r.toast ? ["a refused save shows a toast"] : [])];
    } },
    // Triage (README.md#triage): the issues waiting (one with markup shown as text), none, many and long,
    // the board's Needs you item for them, declining one.
    { name: "triage", section: "project", path: "/projects/prj_demo/triage" },
    { name: "triage-empty", section: "project", path: "/projects/prj_demo/triage", fixture: "triage-empty" },
    { name: "triage-long", section: "project", path: "/projects/prj_demo/triage", fixture: "triage-long" },
    { name: "triage-board", section: "project", path: "/projects/prj_demo/board" },
    { name: "triage-decline", section: "project", path: "/projects/prj_demo/triage", full: false, after: (p) => p.getByRole("button", { name: "Decline issue #44" }).click() },
    { name: "settings", section: "project", path: "/projects/prj_demo/settings", checkName: "workflows", check: (p) => p.evaluate(workflowsAgree) },
    { name: "settings-comments-set", section: "project", path: "/projects/prj_demo/settings", fixture: "comments-set" },
    // The models (README.md#models): a custom id shown with its field; the list open.
    { name: "settings-models-custom", section: "project", path: "/projects/prj_demo/settings", fixture: "models-custom" },
    { name: "settings-models-open", section: "project", path: "/projects/prj_demo/settings", full: false, after: async (p) => { const f = p.getByLabel("Manager's model").first(); await f.scrollIntoViewIfNeeded(); await f.click(); } },
    { name: "settings-comments-id-only", section: "project", path: "/projects/prj_demo/settings", fixture: "comments-id-only" },
    { name: "switcher-open", section: "project", path: "/projects/prj_demo/reviews", full: false, widths: DESKTOP, after: async (p) => { await p.getByRole("button", { name: /Switch project/ }).click(); await p.keyboard.type("gad"); } },
    { name: "sidebar-drawer", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: menu },
    { name: "sidebar-drawer-switcher", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: async (p) => { await menu(p); await p.getByRole("button", { name: /Switch project/ }).click(); } },
  ],
};
export default app;

// The projects app (projects/): its pages and states, the fixtures that serve them, and where its
// layout primitives mark the frame, the measures, the panels and the nav (data-ds attributes).
import { data } from "../fixtures/projects/demo.mjs";
import { countTraffic, tabKeepCheck } from "../trace-tabs.mjs";

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

/** The manager's waits (README.md#waiting) read as words: no raw task id, no snake_case state. */
async function waitsCheck(page) {
  const texts = await page.evaluate(() => [...document.querySelectorAll("[data-slot=waits], [data-slot=recent-waits]")].map((el) => el.textContent ?? ""));
  return texts.flatMap((t) => (/tsk_[a-z0-9]|\b[a-z]+_[a-z]+\b/.test(t) ? [`the manager's waits show a raw id or state: ${t.slice(0, 120)}`] : []));
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

const bubbles = (p) => p.evaluate(() => [...document.querySelectorAll("[data-ds=bubble]")].map((b) => Math.round(b.getBoundingClientRect().top)));
const bottoms = (p) => p.evaluate(() => [...document.querySelectorAll("[data-ds=bubble]")].map((b) => Math.round(b.getBoundingClientRect().bottom)));
/** The room between the newest message and the docked composer (negative: under it). */
const gapAbove = (p) => p.evaluate(() => {
  const last = [...document.querySelectorAll("[data-ds=bubble]")].at(-1)?.getBoundingClientRect();
  const f = document.querySelector("[data-ds=pinned-footer]")?.getBoundingClientRect();
  return last && f ? Math.round(f.top - last.bottom) : null;
});
/** While following, the newest message is clear of the composer by at least `md` (12 px), not touching it. */
const MIN_GAP = 12;
const endProblems = (gap, when) => (gap === null ? [`${when}: no message or composer`] : gap < MIN_GAP ? [`${when}, the newest message is ${gap} px from the composer (at least ${MIN_GAP})`] : []);
/**
 * Scroll up like a reader, and the first message in view, even if cut by the top: its index and top.
 * That's the message the browser anchors on (the first visible in order; only whole messages anchor), so
 * growth above it mustn't move it, while growth inside the view moves what's below, as it should.
 */
async function readBack(p, width) {
  await p.mouse.move(width / 2, 300);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(80);
  }
  await p.waitForTimeout(300);
  const tops = await bubbles(p);
  const ends = await bottoms(p);
  const i = ends.findIndex((b) => b > 0);
  return { i, top: tops[i] };
}
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
    const pill = p.getByRole("button", { name: /new message/i });
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
    await p.getByPlaceholder("Write a message").fill("Sent while reading back");
    await p.keyboard.press("Control+Enter");
    await p.waitForTimeout(1_000);
    const last = await p.evaluate(() => [...document.querySelectorAll("[data-ds=bubble]")].at(-1)?.textContent ?? "");
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
      const [status, body] = answer(route.request().method(), new URL(route.request().url()).pathname.replace(/^\/api/, ""));
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
  },
  // `section`: views compared for a stable frame. `ready` waits for what the screen is of. `full: false` captures (and checks) only the
  // viewport, for an open overlay. `widths` limits a state to some widths.
  states: [
    { name: "projects", section: "top", path: "/projects" },
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
    { name: "attach-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR") },
    { name: "attach-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR", "zzz") },
    { name: "attach-picker-typed", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("Pull requests", "Attach PR", "130") },
    { name: "task-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency") },
    // The confirmations before detaching a PR and removing a dependency.
    { name: "detach-confirm", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: async (p) => { await drawerAt("Pull requests")(p); await p.getByRole("button", { name: "Detach PR #121" }).click(); } },
    { name: "remove-dependency-confirm", section: "project", path: "/projects/prj_demo/board?task=tsk_demo4", full: false, after: async (p) => { await drawerAt("Dependencies")(p); await p.getByRole("button", { name: "Stop waiting on Cache gadget thumbnails" }).click(); } },
    { name: "task-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency", "zzz") },
    { name: "new-task", section: "project", path: "/projects/prj_demo/board", full: false, after: (p) => p.getByRole("button", { name: "New task" }).click() },
    { name: "manager", section: "project", path: "/projects/prj_demo/manager", full: false, check: waitsCheck, checkName: "waits" },
    { name: "manager-rich", section: "project", path: "/projects/prj_demo/manager", fixture: "rich" },
    { name: "manager-rich-view", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false },
    { name: "manager-empty", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false },
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
    // The Network page (README.md#network): rules per role, live agents applied, pending and failed; empty; a host refused.
    { name: "network", section: "project", path: "/projects/prj_demo/network" },
    { name: "network-empty", section: "project", path: "/projects/prj_demo/network", fixture: "network-empty" },
    { name: "network-refused", section: "project", path: "/projects/prj_demo/network", full: false, after: async (p) => {
      const role = p.locator("[data-role=manager]");
      await role.getByLabel("Add hosts").first().click();
      await p.getByRole("option", { name: "Custom host" }).click();
      await role.getByLabel("Host", { exact: true }).fill("evil.example.org");
      await role.getByRole("button", { name: "Add" }).click();
      await role.getByRole("alert").waitFor();
      await role.evaluate((el) => el.scrollIntoView({ block: "center" }));
    } },
    // Removing a host by keyboard leaves focus on a Remove button (the next row's), never <body>.
    { name: "network-remove-keyboard", section: "project", path: "/projects/prj_demo/network", full: false, checkName: "network", after: async (p) => {
      await p.locator("[data-role=worker]").getByRole("button", { name: /^Remove / }).first().focus();
      await p.keyboard.press("Enter");
      await p.waitForTimeout(200);
    }, check: async (p) => {
      const at = await p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
      return /^Remove /.test(at ?? "") ? [] : [`after removing a host by keyboard, focus is on ${at}, not the next Remove`];
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
    { name: "settings", section: "project", path: "/projects/prj_demo/settings" },
    { name: "switcher-open", section: "project", path: "/projects/prj_demo/reviews", full: false, widths: DESKTOP, after: async (p) => { await p.getByRole("button", { name: /Switch project/ }).click(); await p.keyboard.type("gad"); } },
    { name: "sidebar-drawer", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: menu },
    { name: "sidebar-drawer-switcher", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: async (p) => { await menu(p); await p.getByRole("button", { name: /Switch project/ }).click(); } },
  ],
};
export default app;

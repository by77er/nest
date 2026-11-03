// The projects app (projects/): its pages and states, the fixtures that serve them, and where its
// layout primitives mark the frame, the measures, the panels and the nav (data-ds attributes).
import { data } from "../fixtures/projects/demo.mjs";

const menu = async (p) => p.getByRole("button", { name: "Open the menu" }).click();
const DESKTOP = [1440, 1280];
/** Waits for an element TanStack Query shows only after its retries (about 7 s for an error). */
const shown = (selector) => (p) => p.locator(selector).first().waitFor({ timeout: 30_000 });
const PHONE = [390];

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

export default {
  dir: "projects",
  ready: "/projects",
  errorText: "This page hit an error",
  selectors: {
    frame: "[data-ds=page]",
    header: "[data-ds=page-header]",
    measure: "[data-measure]",
    containers: ["[data-ds=panel]", "[data-ds=table-frame]"],
    nav: { rows: "[data-ds=nav-row], [data-ds=switcher]", brand: "#sidebar [aria-label='nest projects: all projects']", active: "[aria-current=page]" },
  },
  /** Installs the fixtures for a state before the page loads. */
  async serve(page, state) {
    const { answer, trace, history } = data(state.fixture ?? "demo");
    await page.routeWebSocket(/\/api\/agents\/[^/]+\/trace/, (ws) => {
      for (const e of trace) ws.send(JSON.stringify(e));
      ws.onMessage((m) => m === "ping" && ws.send("pong"));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
      const url = new URL(route.request().url());
      // The trace's history (older pages); a state may hold every page asked for after it sets `holdHistory`.
      if (/^\/api\/agents\/[^/]+\/trace\/history$/.test(url.pathname)) {
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
    { name: "drawer-trace-tab", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, widths: PHONE, after: traceTab, check: traceCheck, checkName: "trace" },
    { name: "drawer-trace-expanded", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); await expandResult(p); } },
    { name: "drawer-trace-loading", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); p.holdHistory = true; await toTop("loading earlier…")(p); } },
    { name: "drawer-trace-beginning", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, check: traceCheck, checkName: "trace", after: async (p) => { await traceTab(p); await toTop("the beginning of the trace")(p); } },
    { name: "drawer-no-worker", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false },
    { name: "new-task", section: "project", path: "/projects/prj_demo/board", full: false, after: (p) => p.getByRole("button", { name: "New task" }).click() },
    { name: "manager", section: "project", path: "/projects/prj_demo/manager", full: false },
    { name: "manager-trace", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, check: traceCheck, checkName: "trace" },
    { name: "manager-trace-beginning", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false, check: traceCheck, checkName: "trace", after: toTop("the beginning of the trace") },
    { name: "reviews", section: "project", path: "/projects/prj_demo/reviews" },
    { name: "reviews-trace", section: "project", path: "/projects/prj_demo/reviews", after: (p) => p.getByRole("button", { name: "Show the trace of #118" }).click(), check: traceCheck, checkName: "trace" },
    { name: "settings", section: "project", path: "/projects/prj_demo/settings" },
    { name: "switcher-open", section: "project", path: "/projects/prj_demo/reviews", full: false, widths: DESKTOP, after: async (p) => { await p.getByRole("button", { name: /Switch project/ }).click(); await p.keyboard.type("gad"); } },
    { name: "sidebar-drawer", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: menu },
    { name: "sidebar-drawer-switcher", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: async (p) => { await menu(p); await p.getByRole("button", { name: /Switch project/ }).click(); } },
  ],
};

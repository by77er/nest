// The projects app (projects/): its pages and states, the fixtures that serve them, and where its
// layout primitives mark the frame, the measures, the panels and the nav (data-ds attributes).
import { data } from "../fixtures/projects/demo.mjs";

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
    const { answer, trace } = data(state.fixture ?? "demo");
    await page.routeWebSocket(/\/api\/agents\/[^/]+\/trace/, (ws) => {
      for (const e of trace) ws.send(JSON.stringify(e));
      ws.onMessage((m) => m === "ping" && ws.send("pong"));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
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
    { name: "drawer", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false },
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
    { name: "attach-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("[data-pr='124']", "Attach PR") },
    { name: "attach-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo7", full: false, after: picker("[data-pr='124']", "Attach PR", "zzz") },
    { name: "task-picker-open", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency") },
    { name: "task-picker-empty", section: "project", path: "/projects/prj_demo/board?task=tsk_demo3", full: false, after: picker("Dependencies", "Add dependency", "zzz") },
    { name: "new-task", section: "project", path: "/projects/prj_demo/board", full: false, after: (p) => p.getByRole("button", { name: "New task" }).click() },
    { name: "manager", section: "project", path: "/projects/prj_demo/manager", full: false },
    { name: "manager-trace", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false },
    { name: "reviews", section: "project", path: "/projects/prj_demo/reviews" },
    { name: "reviews-trace", section: "project", path: "/projects/prj_demo/reviews", after: (p) => p.getByRole("button", { name: "Show the trace of #118" }).click() },
    { name: "settings", section: "project", path: "/projects/prj_demo/settings" },
    { name: "switcher-open", section: "project", path: "/projects/prj_demo/reviews", full: false, widths: DESKTOP, after: async (p) => { await p.getByRole("button", { name: /Switch project/ }).click(); await p.keyboard.type("gad"); } },
    { name: "sidebar-drawer", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: menu },
    { name: "sidebar-drawer-switcher", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: async (p) => { await menu(p); await p.getByRole("button", { name: /Switch project/ }).click(); } },
  ],
};

// The projects app (projects/): its pages and states, the fixtures that serve them, and where its
// layout primitives mark the frame, the measures, the panels and the nav (data-ds attributes).
import { data } from "../fixtures/projects/demo.mjs";

const menu = async (p) => p.getByRole("button", { name: "Open the menu" }).click();
const DESKTOP = [1440, 1280];
/** Waits for an element TanStack Query shows only after its retries (about 7 s for an error). */
const shown = (selector) => (p) => p.locator(selector).first().waitFor({ timeout: 30_000 });
const PHONE = [390];

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
 * Scroll up like a reader, and the first message whose top is in view: its index and top. That's the line
 * the browser anchors on (the first visible in order), so growth above it mustn't move it; growth inside
 * the view moves what's below, as it should.
 */
async function readBack(p, width) {
  await p.mouse.move(width / 2, 300);
  for (let i = 0; i < 6; i++) {
    await p.mouse.wheel(0, -300);
    await p.waitForTimeout(80);
  }
  await p.waitForTimeout(300);
  const tops = await bubbles(p);
  const i = tops.findIndex((t) => t >= 0);
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
    // A manager's message: its headings demoted below the page's (an h4 at most), its figures on a light canvas.
    content: { root: "[data-ds=rich]", minHeading: 4, figures: "[data-ds=figure-canvas]" },
  },
  /** Installs the fixtures for a state before the page loads. */
  async serve(page, state) {
    const { answer, trace } = data(state.fixture ?? "demo");
    await page.routeWebSocket(/\/api\/agents\/[^/]+\/trace/, (ws) => {
      for (const e of trace) ws.send(JSON.stringify(e));
      ws.onMessage((m) => m === "ping" && ws.send("pong"));
    });
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const url = new URL(route.request().url());
      const [status, body] = answer(route.request().method(), url.pathname.replace(/^\/api/, ""));
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
    { name: "new-task", section: "project", path: "/projects/prj_demo/board", full: false, after: (p) => p.getByRole("button", { name: "New task" }).click() },
    { name: "manager", section: "project", path: "/projects/prj_demo/manager", full: false },
    { name: "manager-rich", section: "project", path: "/projects/prj_demo/manager", fixture: "rich" },
    { name: "manager-rich-view", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false },
    { name: "manager-empty", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-empty", full: false },
    { name: "manager-long", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false },
    { name: "manager-long-full", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long" },
    { name: "manager-context-open", section: "project", path: "/projects/prj_demo/manager", widths: PHONE, after: (p) => p.getByRole("button", { name: "About the manager" }).click() },
    { name: "svg-modal", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false, widths: DESKTOP, after: (p) => p.getByRole("button", { name: /Search pipeline: open larger/ }).click() },
    // The chat's scrolling, acted out (checks: `chat-scroll`).
    { name: "chat-readback-growth", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.readbackGrowth("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-readback-new", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.readbackNew("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-send-readback", section: "project", path: "/projects/prj_demo/manager", fixture: "chat-long", full: false, widths: [1440, 390], after: scroll.sendReadback("chat-long"), check: stashed, checkName: "chat-scroll" },
    { name: "chat-follow-growth", section: "project", path: "/projects/prj_demo/manager", fixture: "rich", full: false, widths: [1440, 390], after: scroll.followGrowth("rich"), check: stashed, checkName: "chat-scroll" },
    { name: "manager-trace", section: "project", path: "/projects/prj_demo/manager?view=trace", full: false },
    { name: "reviews", section: "project", path: "/projects/prj_demo/reviews" },
    { name: "reviews-trace", section: "project", path: "/projects/prj_demo/reviews", after: (p) => p.getByRole("button", { name: "Show the trace of #118" }).click() },
    { name: "settings", section: "project", path: "/projects/prj_demo/settings" },
    { name: "switcher-open", section: "project", path: "/projects/prj_demo/reviews", full: false, widths: DESKTOP, after: async (p) => { await p.getByRole("button", { name: /Switch project/ }).click(); await p.keyboard.type("gad"); } },
    { name: "sidebar-drawer", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: menu },
    { name: "sidebar-drawer-switcher", section: "project", path: "/projects/prj_demo/board", full: false, widths: PHONE, after: async (p) => { await menu(p); await p.getByRole("button", { name: /Switch project/ }).click(); } },
  ],
};

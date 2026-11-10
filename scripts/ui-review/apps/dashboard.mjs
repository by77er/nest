// The dashboard (dashboard/): one page, the fleet of a cell, in the states its admin API answers.
// recorded.json is the dashboard's own fixtures (dashboard/fixtures/admin.ts) as the Worker answers
// them; busy.json a busier cell built from them; empty.json a cell with nothing running. Each has
// the `now` its times are relative to, and the page's clock is fixed to it.
import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/dashboard/${name}.json`, import.meta.url), "utf8"));

/**
 * The attention list's rows share one height where none wraps (desktop widths): a row without an action
 * keeps the action's target height (the design review of #179). Each row is held to the most common
 * height, so one tall row can't hide the others; the busy fixture always has a list of several rows, so
 * a missing list or a lone row fails rather than passing unchecked.
 */
async function uniformRows(page, { width }) {
  if (width < 1280) return [];
  const rows = await page.evaluate(() => {
    const list = document.querySelector('ul[aria-label="Needs attention"]');
    return list ? [...list.children].map((li) => ({ text: li.textContent.slice(0, 60), h: Math.round(li.getBoundingClientRect().height) })) : null;
  });
  if (rows === null) return ["no attention list to check"];
  if (rows.length < 2) return [`the attention list has ${rows.length} rows; the busy fixture should give several to compare`];
  const counts = new Map();
  for (const r of rows) counts.set(r.h, (counts.get(r.h) ?? 0) + 1);
  // The most common height; on a tie, the taller (an action's target height).
  const common = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  return rows.filter((r) => Math.abs(r.h - common) > 1).map((r) => `an attention row is ${r.h} px tall, the others ${common} px: "${r.text}"`);
}

export default {
  dir: "dashboard",
  ready: "/",
  errorText: null,
  selectors: {
    frame: "main",
    header: "[class*=pageHeader]",
    measure: null,
    containers: [".mantine-Paper-root"],
    nav: null,
  },
  async serve(page, state) {
    const data = fixture(state.fixture === "error" ? "recorded" : state.fixture);
    await page.clock.setFixedTime(data.now);
    await page.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^\/api\//, "");
      if (state.fixture === "error" && path === "fleet") return route.fulfill({ status: 502, json: { error: "the control plane answered 502 (fixture)" } });
      return data[path] ? route.fulfill({ json: data[path] }) : route.fulfill({ status: 404, json: { error: "unknown route" } });
    });
  },
  states: [
    { name: "fleet", section: "fleet", path: "/", fixture: "recorded" },
    { name: "fleet-busy", section: "fleet", path: "/", fixture: "busy", check: uniformRows, checkName: "attention-rows" },
    { name: "fleet-empty", section: "fleet", path: "/", fixture: "empty" },
    { name: "fleet-error", section: "fleet", path: "/", fixture: "error", httpErrors: true, ready: (p) => p.getByText("Couldn't read the control plane").waitFor({ timeout: 30_000 }) },
  ],
};

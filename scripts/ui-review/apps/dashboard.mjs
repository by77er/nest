// The dashboard (dashboard/): one page, the fleet of a cell, in the states its admin API answers.
// recorded.json is the dashboard's own fixtures (dashboard/fixtures/admin.ts) as the Worker answers
// them; busy.json a busier cell built from them; empty.json a cell with nothing running. Each has
// the `now` its times are relative to, and the page's clock is fixed to it.
import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/dashboard/${name}.json`, import.meta.url), "utf8"));

/**
 * The attention list's rows share one height where none wraps (desktop widths): a row without an action
 * keeps the action's target height (the design review of #179).
 */
async function uniformRows(page, { width }) {
  if (width < 1280) return [];
  const rows = await page.evaluate(() => {
    const list = document.querySelector('[aria-label="Needs attention"] ul, ul[aria-label="Needs attention"]');
    return list ? [...list.children].map((li) => ({ text: li.textContent.slice(0, 60), h: Math.round(li.getBoundingClientRect().height) })) : [];
  });
  if (rows.length < 2) return [];
  const tallest = Math.max(...rows.map((r) => r.h));
  return rows.filter((r) => tallest - r.h > 1).map((r) => `an attention row is ${r.h} px tall, the others ${tallest} px: "${r.text}"`);
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

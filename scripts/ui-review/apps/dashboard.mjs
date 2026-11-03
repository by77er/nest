// The dashboard (dashboard/): one page, the fleet of a cell, in the states its admin API answers.
// recorded.json is the dashboard's own fixtures (dashboard/fixtures/admin.ts) as the Worker answers
// them; busy.json a busier cell built from them; empty.json a cell with nothing running. Each has
// the `now` its times are relative to, and the page's clock is fixed to it.
import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/dashboard/${name}.json`, import.meta.url), "utf8"));

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
    { name: "fleet-busy", section: "fleet", path: "/", fixture: "busy" },
    { name: "fleet-empty", section: "fleet", path: "/", fixture: "empty" },
    { name: "fleet-error", section: "fleet", path: "/", fixture: "error", httpErrors: true, ready: (p) => p.getByText("Couldn't read the control plane").waitFor({ timeout: 30_000 }) },
  ],
};

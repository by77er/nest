// The Network page: each role's hosts, presets that add their hosts, a host outside the grant refused
// with what the operator must do, the save sending both roles, and each live agent's state. And the
// Manager page's pending waits.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const page = () => screen.findByRole("heading", { name: "Network", level: 3 });
const role = (r: "worker" | "manager") => document.querySelector(`[data-role="${r}"]`) as HTMLElement;
/** A role's "Add hosts" picker (Mantine's Select: its visible input). */
const picker = (el: HTMLElement) => within(el).getAllByLabelText("Add hosts").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!;

describe("the Network page", () => {
  it("shows the grant's ceiling, nest's defaults and the operator's rules apart, and each role's hosts", async () => {
    const api = new FakeApi();
    api.network.rules = { worker: [{ host: "registry.npmjs.org" }], manager: [] };
    renderApp("/projects/prj_one/network", api);
    await page();
    expect(screen.getByText(/This app may open registry\.npmjs\.org, nodejs\.org/)).toBeInTheDocument();
    expect(document.querySelector('[data-slot="base"]')).toHaveTextContent(/^github\.com$/);
    // A port shown only where it isn't the web's.
    expect(document.querySelector('[data-slot="operator"]')).toHaveTextContent(/^mirror\.internal\.example:8443$/);
    expect(within(role("worker")).getByText("registry.npmjs.org")).toBeInTheDocument();
    expect(within(role("worker")).getByText("ports 80, 443")).toBeInTheDocument();
    expect(within(role("manager")).getByText(/No hosts beyond the operator/)).toBeInTheDocument();
  });

  it("adds a preset's hosts, refuses a host outside the grant, and saves both roles", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/network", api);
    await page();
    const w = role("worker");
    // A preset: all its hosts.
    await user.click(picker(w));
    await user.click(await screen.findByRole("option", { name: /^PyPI/ }));
    await user.click(within(w).getByRole("button", { name: "Add" }));
    expect(within(w).getByText("pypi.org")).toBeInTheDocument();
    expect(within(w).getByText("files.pythonhosted.org")).toBeInTheDocument();
    // A custom host outside the grant: refused, with what the operator must do; nothing added.
    const m = role("manager");
    await user.click(picker(m));
    await user.click(await screen.findByRole("option", { name: "Custom host" }));
    await user.type(within(m).getByRole("textbox", { name: "Host" }), "evil.example.com");
    await user.click(within(m).getByRole("button", { name: "Add" }));
    expect(within(m).getByRole("alert")).toHaveTextContent(/the operator must widen the grant's egress_hosts/);
    expect(within(m).queryByText("evil.example.com", { selector: "[data-host] *" })).toBeNull();
    // One inside it, on a port of its own.
    await user.clear(within(m).getByRole("textbox", { name: "Host" }));
    await user.type(within(m).getByRole("textbox", { name: "Host" }), "nodejs.org");
    await user.type(within(m).getByRole("textbox", { name: /Ports/ }), "8443, 443");
    await user.click(within(m).getByRole("button", { name: "Add" }));
    expect(within(m).getByText("ports 443, 8443")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes.some((x) => x.method === "PUT")).toBe(true));
    expect(api.writes.find((x) => x.method === "PUT")).toEqual({
      method: "PUT", path: "/api/projects/prj_one/network",
      body: { worker: [{ host: "pypi.org" }, { host: "files.pythonhosted.org" }], manager: [{ host: "nodejs.org", ports: [443, 8443] }] },
    });
  });

  it("removes a host, and shows each live agent's rules as applied, pending or failed", async () => {
    const api = new FakeApi();
    api.network.rules = { worker: [{ host: "registry.npmjs.org" }], manager: [] };
    api.network.agents = [
      { agent: "agt_w1", role: "worker", sandbox: "sbx_1", state: "applied", error: null, rev: 1, at_ms: Date.now() },
      { agent: "agt_w2", role: "worker", sandbox: "sbx_2", state: "failed", error: "nest 403 forbidden: egress host outside the grant", rev: 0, at_ms: null },
      { agent: "agt_manager", role: "manager", sandbox: null, state: "pending", error: null, rev: null, at_ms: null },
    ];
    const { user } = renderApp("/projects/prj_one/network", api);
    await page();
    const table = screen.getByRole("list", { name: "Live agents' network" });
    const stateOf = (a: string) => table.querySelector(`[data-agent="${a}"] [data-slot="state"]`)!.textContent;
    expect([stateOf("agt_w1"), stateOf("agt_w2"), stateOf("agt_manager")]).toEqual(["Applied", "Failed", "Pending"]);
    expect(within(table).getByText(/outside the grant/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(role("worker")).getByRole("button", { name: "Remove registry.npmjs.org" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(within(role("worker")).getByText("registry.npmjs.org")).toBeInTheDocument();
  });
});

describe("the manager's waits", () => {
  it("lists each pending wait with the time it has left, soonest first", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.waits = {
      pending: [
        { id: "aw_2", kind: "task", target: "tsk_a", want: ["in_review"], created_ms: now, deadline_ms: now + 2 * 3600_000 + 60_000, resolved_ms: null, outcome: null, detail: null },
        { id: "aw_1", kind: "pr", target: "12", want: "merged", created_ms: now, deadline_ms: now + 20 * 60_000 + 10_000, resolved_ms: null, outcome: null, detail: null },
      ],
      recent: [],
    };
    renderApp("/projects/prj_one/manager", api);
    const list = await screen.findByRole("list", { name: "The manager's waits" });
    const items = within(list).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Waiting for #12 to merge · 20 min left", "Waiting for tsk_a to be in_review · 2 h left"]);
  });

  it("shows nothing when the manager waits for nothing", async () => {
    renderApp("/projects/prj_one/manager", new FakeApi());
    await screen.findByRole("heading", { name: "Manager" });
    expect(screen.queryByRole("list", { name: "The manager's waits" })).toBeNull();
  });
});

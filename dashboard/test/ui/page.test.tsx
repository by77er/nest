// The page over the recorded responses (fixtures/admin.ts): what is live, what needs attention first,
// and each section's empty, loading and error states. Time is pinned to the lifetimes view's `now_ms`
// (Date only: timers stay real, so the page's polls and the 300 ms loading delay run as they do).
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agent, fleet as recordedFleet, lifetimes as recordedLifetimes } from "../../fixtures/admin";
import { short, span } from "../../src/ui/format";
import { json, pending, recorded, renderPage } from "./render";

const NOW = recordedLifetimes.now_ms;
const [dormant, held] = recordedLifetimes.sandboxes;
const [quiet, lead] = recordedLifetimes.agents;
const host = recordedFleet.hosts[0]!;
const sandbox = recordedFleet.sandboxes[0]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

const section = (name: string) => screen.getByRole("region", { name });
const tile = (label: string) => within(screen.getByLabelText("Summary")).getByText(label).parentElement!;
const attentionList = () => screen.queryByRole("list", { name: "Needs attention" });

describe("the recorded fleet", () => {
  it("counts what is live in the summary row", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Agents" });
    expect(tile("Live agents")).toHaveTextContent("1");
    expect(tile("Sandboxes")).toHaveTextContent(/^Sandboxes1on a host$/);
    expect(tile("Hosts")).toHaveTextContent("1 sandbox · 0 brain");
  });

  it("lists the agent with its detail, the sandbox, the host with its residents, and the templates", async () => {
    renderPage();
    const agents = await screen.findByRole("table", { name: "Agents" });
    const row = within(agents).getByTitle(agent.agent).closest("tr")!;
    for (const text of ["worker", "working", "ready", "live", short(agent.current_turn), short(agent.hands.sandbox)]) expect(row).toHaveTextContent(text);

    const sandboxes = within(section("Sandboxes")).getByRole("table");
    expect(within(sandboxes).getByTitle(sandbox.sandbox).closest("tr")).toHaveTextContent(/nest-base:latest.*running/);

    const card = screen.getByLabelText(`Host ${host.host}`);
    expect(card).toHaveTextContent("16.0 GiB free · 8 vCPU free");
    expect(within(card).getByTitle(sandbox.sandbox)).toBeInTheDocument();
    expect(within(card).getByTitle(agent.agent)).toBeInTheDocument();

    const templates = await within(section("Templates")).findByRole("table");
    expect(within(templates).getByText("nest-base:latest").closest("tr")).toHaveTextContent(/default\s*1$/);
  });

  it("lists what is left lying around, oldest first, with when the TTL takes the dormant one, and no control that acts", async () => {
    renderPage();
    const life = section("Left lying around");
    const sandboxes = await within(life).findByRole("table", { name: "Sandboxes left lying around" });
    const rows = within(sandboxes).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByTitle(/^sbx_/)[0]!.title)).toEqual([held!.sandbox, dormant!.sandbox]);
    expect(rows[1]).toHaveTextContent(`in ${span(dormant!.destroy_at_ms! - NOW)}`);
    expect(rows[0]).toHaveTextContent("never (not dormant)");
    const agents = within(life).getByRole("table", { name: "Agents left lying around" });
    expect(within(agents).getAllByRole("row").slice(1).map((r) => within(r).getAllByTitle(/^agt_/)[0]!.title)).toEqual([lead!.agent, quiet!.agent]);
    // Nothing that acts: no form or field, and the only buttons copy an operator's command.
    expect(life.querySelector("form, input, select, textarea")).toBeNull();
    const buttons = within(life).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label")!.replace(/: .*/, ""))).toEqual(Array(4).fill("Copy command"));
  });

  it("copies an operator's command as the page shows it", async () => {
    const writeText = vi.fn(async () => {});
    const { user } = renderPage();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const sandboxes = await screen.findByRole("table", { name: "Sandboxes left lying around" });
    const row = within(sandboxes).getByTitle(dormant!.sandbox).closest("tr")!;
    const command = `PUT /v1/sandboxes/${dormant!.sandbox}/lifetime (keep) · DELETE /v1/sandboxes/${dormant!.sandbox} (now)`;
    expect(row).toHaveTextContent(command);
    await user.click(within(row).getByRole("button", { name: `Copy command: ${command}` }));
    expect(writeText).toHaveBeenCalledWith(command);
    expect(await within(row).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("what needs attention", () => {
  it("surfaces the held and dormant sandboxes and the quiet agents, each with a way to its row", async () => {
    const { user } = renderPage();
    const list = await waitFor(() => {
      const l = attentionList();
      expect(l).not.toBeNull();
      return l!;
    });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringMatching(new RegExp(`^held.*${short(held!.sandbox)}.*no TTL takes it`)),
      expect.stringMatching(new RegExp(`^dormant.*${short(dormant!.sandbox)}.*destroys it in ${span(dormant!.destroy_at_ms! - NOW)}`)),
      expect.stringMatching(new RegExp(`^quiet.*${short(lead!.agent)}.*never had a turn`)),
      expect.stringMatching(new RegExp(`^quiet.*${short(quiet!.agent)}.*stopped by the operator`)),
    ]);
    expect(tile("Needs attention")).toHaveTextContent(/4.*4 warnings/);

    await user.click(within(items[0]!).getByRole("button", { name: `Show sandbox ${held!.sandbox}` }));
    expect(document.activeElement).toBe(within(screen.getByRole("table", { name: "Sandboxes left lying around" })).getByTitle(held!.sandbox).closest("tr"));
  });

  it("puts errors first: an errored agent, a condemned brain, a wedged host, a failed sandbox", async () => {
    const fleet = recorded.fleet();
    fleet.hosts[0]!.wedged_ms = NOW - 120_000;
    fleet.sandboxes[0]!.lease_state = "failed";
    const agents = recorded.agents();
    agents.agents[0]!.info = { ...agents.agents[0]!.info!, state: "errored", lifecycle: "errored", brain: { host: host.host, phase: "condemned", since_ms: NOW - 60_000 } };
    renderPage({ "/api/fleet": fleet, "/api/agents": agents });
    const list = await waitFor(() => {
      const l = attentionList();
      expect(within(l!).getAllByRole("listitem").length).toBeGreaterThan(4);
      return l!;
    });
    const labels = within(list).getAllByRole("listitem").map((i) => within(i).getAllByText(/./)[0]!.textContent);
    expect(labels.slice(0, 4)).toEqual(["wedged", "errored", "brain condemned", "failed"]);
    expect(labels.slice(4)).toEqual(["held", "dormant", "quiet", "quiet"]);
    expect(tile("Needs attention")).toHaveTextContent(/4 errors.*4 warnings/);
  });

  it("an instance type whose launches are paused is a warning naming the type whole, with no control that acts", async () => {
    const fleet = recorded.fleet();
    fleet.enroll_breakers = [{ role: "sandbox", type: "c8id.large", failures: 3, open_until_ms: Date.now() + 25 * 60_000, open: true }];
    renderPage({ "/api/fleet": fleet });
    const item = await waitFor(() => {
      const l = attentionList();
      const li = within(l!).getAllByRole("listitem").find((i) => i.textContent?.includes("Launches"));
      expect(li).toBeDefined();
      return li!;
    });
    expect(item).toHaveTextContent("paused");
    expect(item).toHaveTextContent("Launches c8id.large");
    expect(item).toHaveTextContent(/3 sandbox host launches in a row never enrolled; next try in 2[45]m/);
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("says all clear only once everything it depends on has been read", async () => {
    const empty = { ...recorded.lifetimes(), sandboxes: [], agents: [] };
    let answer: (v: Response) => void = () => {};
    renderPage({ "/api/lifetimes": () => new Promise<Response>((r) => { answer = r; }) });
    await screen.findByRole("table", { name: "Agents" });
    expect(tile("Needs attention")).toHaveTextContent("checking…");
    answer(json(empty));
    await waitFor(() => expect(tile("Needs attention")).toHaveTextContent("all clear"));
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
  });
});

describe("empty, loading and error states", () => {
  it("a cell at zero: every section says so", async () => {
    const empty = { ...recorded.fleet(), hosts: [], sandboxes: [], launches: [] };
    renderPage({ "/api/fleet": empty, "/api/agents": { agents: [], omitted: 0 }, "/api/lifetimes": { ...recorded.lifetimes(), sandboxes: [], agents: [] } });
    expect(await screen.findByText("No brain is running")).toBeInTheDocument();
    expect(screen.getByText("None on a host")).toBeInTheDocument();
    expect(screen.getByText("None: the cell is at zero")).toBeInTheDocument();
    expect(await screen.findByText("Nothing: every sandbox is in use")).toBeInTheDocument();
    expect(screen.getByText("None quiet, stuck ending or gone")).toBeInTheDocument();
    expect(tile("Hosts")).toHaveTextContent("the cell is at zero");
  });

  it("loading: one spinner per container, and only after 300 ms", async () => {
    renderPage({ "/api/fleet": pending, "/api/images": pending, "/api/lifetimes": pending });
    expect(screen.queryByText("Reading the fleet")).toBeNull();
    expect(await screen.findByText("Reading the fleet")).toBeInTheDocument();
    expect(screen.getByText("Reading the templates")).toBeInTheDocument();
    expect(screen.getByText("Reading the lifetimes view")).toBeInTheDocument();
  });

  it("the fleet view failing: its error, and a retry that reads it again", async () => {
    const { routes, user } = renderPage({ "/api/fleet": json({ error: "FleetDO is down" }, 503) });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't read the control plane");
    expect(alert).toHaveTextContent("503: FleetDO is down");
    routes["/api/fleet"] = recorded.fleet;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Agents" })).toBeInTheDocument();
  });

  it("the agents' detail failing: the rest still shows, its rows say unknown, and attention says it could not check", async () => {
    renderPage({ "/api/agents": json({ error: "upstream" }, 502) });
    expect(await screen.findByText("Couldn't read the agents' detail")).toBeInTheDocument();
    const row = within(screen.getByRole("table", { name: "Agents" })).getByTitle(agent.agent).closest("tr")!;
    expect(row).toHaveTextContent("unknown");
    expect(within(attentionList()!).getAllByRole("listitem")[0]).toHaveTextContent(/^not checked.*agents' detail could not be read: 502: upstream/);
  });

  it("a control plane from before the lifetimes route says so", async () => {
    renderPage({ "/api/lifetimes": json({ error: "unknown route" }, 404) });
    expect(await within(section("Left lying around")).findByText(/does not serve GET \/v1\/admin\/lifetimes yet/)).toBeInTheDocument();
  });

  it("an agent the Worker could not read is a row with its error", async () => {
    renderPage({ "/api/agents": { agents: [{ agent: agent.agent, info: null, error: "404: unknown agent" }], omitted: 0 } });
    const agents = await screen.findByRole("table", { name: "Agents" });
    await waitFor(() => expect(within(agents).getByTitle(agent.agent).closest("tr")).toHaveTextContent("could not read: 404: unknown agent"));
  });
});

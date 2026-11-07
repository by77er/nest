// "Needs you" above the board (README.md#blocked): agents' asks and blocked tasks together, oldest first,
// each answered there. An approval is answered approve (green) or deny (red), words nest reads as such
// (docs/agents/tools/#taint-and-sinks); a question or a block in words.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const panel = () => screen.findByRole("region", { name: "Needs you" });
const gone = () => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();

describe("asks", () => {
  it("an approval: approve is green and sends approve; the ask then leaves", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "github.create_pr", tool: "brokered" }, question: "Open the PR?" });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one/board", api);

    const p = await panel();
    // Calm: the surface with a warning rule, not a warning-tinted fill.
    expect(p.getAttribute("style")).toContain("--mantine-color-warning-filled");
    expect(p.getAttribute("style")).not.toContain("--mantine-color-warning-light");
    expect(p).toHaveTextContent("github.create_pr");
    expect(p).toHaveTextContent("Open the PR?");
    const approve = within(p).getByRole("button", { name: "Approve" });
    expect(approve.getAttribute("style")).toContain("--mantine-color-success-");
    expect(within(p).getByRole("button", { name: "Deny" }).getAttribute("style")).toContain("--mantine-color-danger-");

    await user.click(approve);
    await waitFor(gone);
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "approve" } }]);
  });

  it("an approval denied sends deny", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "email.send", tool: "brokered" } });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one/board", api);
    await user.click(within(await panel()).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "deny" } }]));
  });

  it("a previous manager's ask says so, and its question shows as plain text, not the manager's rich content", async () => {
    const api = new FakeApi();
    api.asks = [
      ask({ question: "Merge **everything**?", role: "manager", agent: "agt_old", previous: true }),
      ask({ question: "Use **main**?", role: "manager", agent: "agt_manager" }),
    ];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const old = await waitFor(() => {
      const el = [...p.querySelectorAll("[data-ask]")].find((e) => e.textContent?.includes("agt_old"));
      if (!el) throw new Error("not yet");
      return el as HTMLElement;
    });
    expect(old).toHaveTextContent("The previous manager");
    expect(old).toHaveTextContent("Merge **everything**?");
    expect(old.querySelector("strong")).toBeNull();
    const current = [...p.querySelectorAll("[data-ask]")].find((e) => e.textContent?.includes("agt_manager")) as HTMLElement;
    expect(current).not.toHaveTextContent("The previous manager");
    expect(current.querySelector("strong")).not.toBeNull();
  });

  it("a question is answered in words; one nest refuses keeps the ask and what was typed", async () => {
    const api = new FakeApi();
    const a = ask({ question: "Which branch should I base on?", role: "manager", agent: "agt_manager" });
    api.asks = [a, ask({ question: "already answered", answered_ms: 5 })];
    api.fail(/\/answer$/, 502, "nest is unavailable");
    const { user } = renderApp("/projects/prj_one/board", api);

    const p = await panel();
    expect(p).not.toHaveTextContent("already answered");
    expect(within(p).queryByRole("button", { name: "Approve" })).toBeNull();
    const send = within(p).getByRole("button", { name: "Answer" });
    expect(send).toBeDisabled();
    await user.type(within(p).getByLabelText("Your answer"), "main");
    await user.click(send);

    expect(await screen.findByText("nest is unavailable")).toBeInTheDocument();
    expect(within(await panel()).getByLabelText("Your answer")).toHaveValue("main");
    await user.click(within(await panel()).getByRole("button", { name: "Answer" }));
    await waitFor(gone);
    expect(api.writes.map((w) => w.body)).toEqual([{ answer: "main" }, { answer: "main" }]);
  });

  it("lists blocked tasks with the asks, oldest first, with who blocked it, why and what they ask", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.asks = [ask({ question: "Newest: which branch?", at_ms: now - 1_000 })];
    api.tasks = [
      task({ title: "Middle", state: "in_progress", blocked: { at_ms: now - 60_000, by: "agt_w1", role: "worker", reason: "No staging credentials", question: "Add STAGING_DB_URL?", tainted: false } }),
      task({ title: "Oldest", state: "ready", blocked: { at_ms: now - 3_600_000, by: "agt_manager", role: "manager", reason: "Needs a product decision", question: null, tainted: false } }),
    ];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(within(p).getByText("3")).toBeInTheDocument();
    const order = [...p.querySelectorAll("[data-ask], [data-blocked]")].map((e) => e.textContent ?? "");
    expect(order.map((t) => (t.includes("Oldest") ? "oldest" : t.includes("Middle") ? "middle" : t.includes("Newest") ? "newest" : "?"))).toEqual(["oldest", "middle", "newest"]);
    const middle = p.querySelector(`[data-blocked="${api.tasks[0]!.id}"]`) as HTMLElement;
    expect(middle).toHaveTextContent("A worker");
    expect(middle).toHaveTextContent("agt_w1");
    expect(middle).toHaveTextContent("No staging credentials");
    expect(middle).toHaveTextContent("Add STAGING_DB_URL?");
    expect(middle).toHaveTextContent("1 minute ago");
    expect(within(middle).getByText("Goes to the worker and the manager")).toBeInTheDocument();
  });

  it("answering a blocked task sends the answer and the block leaves", async () => {
    const api = new FakeApi();
    const t = task({ title: "Stuck", state: "in_progress", blocked: { at_ms: Date.now() - 1000, by: "agt_w1", role: "worker", reason: "r", question: "q?", tainted: false } });
    api.tasks = [t];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    await user.type(within(p).getByLabelText(/Your answer/), "use eu-west-1");
    await user.click(within(p).getByRole("button", { name: "Answer" }));
    await waitFor(gone);
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/answer`, body: { answer: "use eu-west-1" } }]);
  });

  it("marks a blocked task's card, and counts what needs you on the projects list", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Stuck", state: "in_progress", blocked: { at_ms: Date.now(), by: "agt_w1", role: "worker", reason: "r", question: null, tainted: false } })];
    api.asks = [ask({ question: "q" })];
    renderApp("/projects/prj_one/board", api);
    const card = await screen.findByRole("article", { name: "Stuck" });
    expect(within(card).getByText("Blocked").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("--mantine-color-warning-");
    expect(within(card).getByText("Blocked").closest("[data-marker=blocked]")).not.toBeNull();
    cleanup();
    renderApp("/", api);
    const listed = await screen.findByRole("article", { name: "Widgets" });
    expect(within(listed).getByText("2 need you")).toBeInTheDocument();
  });

  it("shows the oldest three, the rest behind \"Show all (n)\", so the board stays in view", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.asks = [5, 4, 3, 2, 1].map((n) => ask({ question: `Ask ${n}`, at_ms: now - n * 60_000 }));
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const shown = () => [...p.querySelectorAll("[data-ask]")].filter((e) => !e.closest("[aria-hidden=true]") && !e.closest('[style*="display: none"]')).map((e) => /Ask \d/.exec(e.textContent ?? "")![0]);
    expect(shown()).toEqual(["Ask 5", "Ask 4", "Ask 3"]);
    const toggle = within(p).getByRole("button", { name: "Show all (5)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    await waitFor(() => expect(shown()).toEqual(["Ask 5", "Ask 4", "Ask 3", "Ask 2", "Ask 1"]));
    expect(within(p).getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  });

  it("has no toggle with three or fewer", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Only one" })];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(within(p).queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

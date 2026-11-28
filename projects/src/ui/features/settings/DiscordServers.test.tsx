// The Discord servers in Settings (README.md#linked-servers-discord): the linked ones listed with Remove
// (confirmed), and a field that links one by its id, checked by the Worker's own rule before it's sent and
// showing the Worker's refusal where it was typed.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { guildProblem } from "./DiscordServers";

async function open(api: FakeApi) {
  const r = renderApp("/projects/prj_one/settings", api);
  const panel = (await screen.findByRole("heading", { level: 4, name: /Discord servers/ })).closest("[data-slot=discord]") as HTMLElement;
  return { ...r, panel };
}

describe("a server's id", () => {
  it("is digits without a leading zero, 1 to 25 of them, as the Worker takes it", () => {
    expect(guildProblem("1093847561234567890")).toBeNull();
    expect(guildProblem("7")).toBeNull();
    expect(guildProblem("9".repeat(25))).toBeNull();
    for (const bad of ["", "0123", "12a", "-1", "1".repeat(26), " 12"]) expect(guildProblem(bad), bad).not.toBeNull();
  });
});

describe("Discord servers in Settings", () => {
  it("lists the linked servers, and removes one only once confirmed", async () => {
    const api = new FakeApi();
    api.links = [{ guild: "1093847561234567890", created_ms: Date.UTC(2026, 10, 1) }, { guild: "2222", created_ms: Date.UTC(2026, 10, 2) }];
    const { user, panel } = await open(api);
    const rows = await within(panel).findAllByRole("listitem");
    expect(rows.map((r) => r.getAttribute("data-link"))).toEqual(["1093847561234567890", "2222"]);
    await user.click(within(panel).getByRole("button", { name: "Remove the Discord server 2222" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove the Discord server 2222?" });
    // The safe choice is the focused one.
    expect(within(confirm).getByRole("button", { name: "Keep it" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(api.writes).toEqual([]);
    await user.click(within(panel).getByRole("button", { name: "Remove the Discord server 2222" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Remove the Discord server 2222?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "DELETE", path: "/api/projects/prj_one/links/2222", body: undefined }]));
    await waitFor(() => expect(within(panel).getAllByRole("listitem")).toHaveLength(1));
  });

  it("links a server by its id; a malformed id is said and nothing is sent; the Worker's refusal shows in the field", async () => {
    const api = new FakeApi();
    const { user, panel } = await open(api);
    expect(await within(panel).findByText("No server linked")).toBeInTheDocument();
    const field = within(panel).getByLabelText("Server ID");
    await user.type(field, "0123");
    await user.click(within(panel).getByRole("button", { name: "Link server" }));
    expect(within(panel).getByText(/digits only, without a leading zero/)).toBeInTheDocument();
    expect(api.writes).toEqual([]);
    await user.clear(field);
    await user.type(field, "1093847561234567890");
    await user.click(within(panel).getByRole("button", { name: "Link server" }));
    await waitFor(() => expect(api.writes.map((w) => `${w.method} ${w.path}`)).toEqual(["PUT /api/projects/prj_one/links/1093847561234567890"]));
    expect(await within(panel).findByRole("listitem")).toHaveAttribute("data-link", "1093847561234567890");
    expect(field).toHaveValue("");
    api.fail(/^PUT .*\/links\//, 409, "a project is linked to at most 20 Discord servers: remove one first");
    await user.type(field, "4444");
    await user.click(within(panel).getByRole("button", { name: "Link server" }));
    expect(await within(panel).findByText("a project is linked to at most 20 Discord servers: remove one first")).toBeInTheDocument();
    expect(field).toHaveValue("4444");
  });

  it("at the cap, says so in a line of its own instead of the field, which comes back once one is removed", async () => {
    const api = new FakeApi();
    api.links = Array.from({ length: 20 }, (_, k) => ({ guild: String(1000 + k), created_ms: Date.UTC(2026, 10, 1) }));
    const { user, panel } = await open(api);
    expect(await within(panel).findByText("This project is linked to 20 servers, the most it can be: remove one to link another.")).toBeInTheDocument();
    expect(within(panel).queryByLabelText("Server ID")).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Link server" })).toBeNull();
    await user.click(within(panel).getByRole("button", { name: "Remove the Discord server 1000" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Remove the Discord server 1000?" })).getByRole("button", { name: "Remove" }));
    expect(await within(panel).findByLabelText("Server ID")).toBeEnabled();
  });
});

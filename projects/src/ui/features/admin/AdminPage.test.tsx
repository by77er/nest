// The admin page runs the catalog sync and shows what it wrote, then the last sync as the Worker recorded it.
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RepoBinding } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
import { rereadText, statusBadges } from "./BindingsSection";
import { renderApp } from "../../test/render";

const binding = (o: Partial<RepoBinding> = {}): RepoBinding => ({
  project: "prj_one", name: "Widgets", repo: "owner/widgets", repo_id: 1, renamed_to: null, installation_id: null, bound: "github", bound_ms: null, error: null, owner: null, refused: null, ...o,
});

describe("the admin page", () => {
  it("says it never synced, then syncs and shows what was written", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/admin", api);
    expect(await screen.findByText("Never synced.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync catalog" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/admin/sync", body: undefined }]));
    const synced = await screen.findByRole("alert", { name: "Synced" });
    expect(within(synced).getByText("templates/projects/manager")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Never synced.")).toBeNull());
  });

  it("lists each project's repo binding: its id and how it was learned, a pending rename or no binding badged, and why it didn't bind", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.bindings = [
      binding({ project: "prj_one", name: "Widgets", repo: "owner/widgets", repo_id: 101, bound: "github", bound_ms: now - 3_600_000, installation_id: 777001, refused: { installation: 888002, count: 14, last_ms: now - 12 * 60_000 } }),
      binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102, bound: "event", bound_ms: now - 86_400_000, renamed_to: "neworg/gadgets" }),
      binding({ project: "prj_three", name: "Old", repo: "owner/old", repo_id: null, bound: null, error: "Didn't bind: GitHub's repo owner/old (7) is already project prj_one's" }),
    ];
    renderApp("/admin", api);
    const table = await screen.findByRole("table", { name: "Repository bindings" });
    const row = (p: string) => table.querySelector(`[data-binding=${p}]`) as HTMLElement;
    await waitFor(() => expect(row("prj_one")).toBeTruthy());
    expect(row("prj_one")).toHaveTextContent("owner/widgets");
    expect(row("prj_one")).toHaveTextContent("101");
    expect(row("prj_one")).toHaveTextContent("Read from GitHub 1 hour ago");
    expect(row("prj_one").querySelector("[data-slot=installation]")).toHaveTextContent("App installation 777001");
    // Events from another installation (a reinstalled App), refused: said, with what to do.
    expect(within(row("prj_one")).getByText("Events refused")).toBeInTheDocument();
    expect(row("prj_one").querySelector("[data-slot=refused]")).toHaveTextContent(
      "14 events refused, from App installation 888002, not the project's (777001); the last 12 minutes ago. If the App was reinstalled, Re-read to take its new installation. If it wasn't, nothing reached the project: no action needed.",
    );
    expect(row("prj_two").querySelector("[data-slot=installation]")).toHaveTextContent("App installation not known yet: events from any installation are accepted");
    expect(within(row("prj_one")).queryByText(/Rename pending|Not bound/)).toBeNull();
    expect(row("prj_two").querySelector("[data-slot=refused]")).toBeNull();
    expect(row("prj_two")).toHaveTextContent("From its first event yesterday, not read from GitHub yet");
    expect(within(row("prj_two")).getByText("Rename pending")).toBeInTheDocument();
    expect(row("prj_two").querySelector('[data-tone="warning"]')).toHaveTextContent("Renamed on GitHub to neworg/gadgets: applied once nest's grant names it");
    expect(row("prj_three")).toHaveTextContent("None");
    expect(within(row("prj_three")).getByText("Not bound")).toBeInTheDocument();
    expect(row("prj_three")).toHaveTextContent("Found by its name until it's read from GitHub");
    expect(row("prj_three").querySelector("[data-slot=bind-error]")).toHaveTextContent("Didn't bind: GitHub's repo owner/old (7) is already project prj_one's");
  });

  it("a re-read that binds says so in a toast; one that fails says why in its row, which offers Retry", async () => {
    const api = new FakeApi();
    const b = binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: null, bound: null, error: "Didn't bind: an old reason" });
    api.bindings = [b];
    api.reread = () => ({ error: "GitHub couldn't be read: GitHub 502: injected", binding: b });
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    const row = document.querySelector("[data-binding=prj_two]") as HTMLElement;
    const failed = await within(row).findByRole("alert");
    expect(failed).toHaveTextContent("Re-read failed: GitHub couldn't be read: GitHub 502: injected");
    // Under the binding's own error, in its row; not a toast.
    expect(row.querySelector("[data-slot=bind-error]")!.compareDocumentPosition(failed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/GitHub couldn.t be read/, { selector: ".mantine-Notification-description" })).toBeNull();
    api.reread = () => ({ binding: { ...b, repo_id: 202, bound: "github", error: null }, changed: true, previous_id: null, rename: null });
    await user.click(within(row).getByRole("button", { name: "Retry reading Gadgets's repo from GitHub" }));
    await waitFor(() => expect(api.writes.filter((w) => w.path === "/api/admin/bindings/prj_two")).toHaveLength(2));
    expect(await screen.findByText("Gadgets is bound to GitHub's repo 202.")).toBeInTheDocument();
    await waitFor(() => expect(within(row).queryByRole("alert")).toBeNull());
    expect(within(row).getByRole("button", { name: "Re-read Gadgets's repo from GitHub" })).toBeInTheDocument();
  });

  it("when GitHub's repo for the name isn't the bound one, a re-read changes nothing and shows both; only a confirmed choice binds, with the id shown", async () => {
    const api = new FakeApi();
    const b = binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102, owner: { id: 9, login: "owner" } });
    api.bindings = [b];
    api.reread = () => ({
      binding: b,
      mismatch: { bound: { full_name: "owner/gadgets", id: 102, owner: { id: 9, login: "owner" } }, github: { full_name: "owner/gadgets", id: 777, owner: { id: 31337, login: "owner" }, same_owner: false } },
    });
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    const row = document.querySelector("[data-binding=prj_two]") as HTMLElement;
    const m = await waitFor(() => row.querySelector("[data-slot=mismatch]") as HTMLElement);
    expect(m).toHaveTextContent("Nothing changed: events still go to the bound repo");
    expect(m.querySelector("[data-slot=bound-repo]")).toHaveTextContent("repo 102");
    expect(m.querySelector("[data-slot=bound-repo]")).toHaveTextContent("owner owner (9)");
    expect(m.querySelector("[data-slot=github-repo]")).toHaveTextContent("repo 777");
    expect(m.querySelector("[data-slot=github-repo]")).toHaveTextContent("owner owner (31337)");
    expect(m.querySelector('[data-tone="danger"]')).toHaveTextContent("Another owner than the bound repo's");
    expect(within(row).getByText("Mismatch")).toBeInTheDocument();
    // Side by side in the table; the choice quiet (light), not the page's loudest button.
    expect((m.querySelector("[data-slot=bound-repo]")!.parentElement as HTMLElement).getAttribute("style")).toContain("--group-wrap: nowrap");
    expect(within(m).getByRole("button", { name: "Bind Gadgets to owner/gadgets (repo 777)" })).toHaveAttribute("data-variant", "light");
    // Nothing was bound, and no toast claims it was.
    expect(api.writes).toEqual([{ method: "POST", path: "/api/admin/bindings/prj_two", body: undefined }]);
    expect(screen.queryByText(/Gadgets is bound to GitHub's repo 777/)).toBeNull();
    // Kept: nothing sent.
    await user.click(within(m).getByRole("button", { name: "Bind Gadgets to owner/gadgets (repo 777)" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Bind Gadgets to owner/gadgets?" })).getByRole("button", { name: "Keep the bound one" }));
    expect(api.writes).toHaveLength(1);
    // Chosen: the id shown, and nothing else.
    await user.click(within(m).getByRole("button", { name: "Bind Gadgets to owner/gadgets (repo 777)" }));
    const dialog = await screen.findByRole("dialog", { name: "Bind Gadgets to owner/gadgets?" });
    expect(dialog).toHaveTextContent("GitHub's events for repo 777 (owner/gadgets, owner owner (31337)) will reach this project");
    await user.click(within(dialog).getByRole("button", { name: "Bind to this repo" }));
    await waitFor(() => expect(api.writes.at(-1)).toEqual({ method: "POST", path: "/api/admin/bindings/prj_two/bind", body: { repo_id: 777 } }));
    expect(await screen.findByText("Gadgets is bound to GitHub's repo 777 (was 102).")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-binding=prj_two] [data-slot=mismatch]")).toBeNull());
  });

  it("on a phone, a card per binding, top to bottom: its project and repo, id, how it was bound and Re-read", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 48em)", media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    const api = new FakeApi();
    api.bindings = [binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: null, bound: null, error: "Didn't bind: why" })];
    renderApp("/admin", api);
    const list = await screen.findByRole("list", { name: "Repository bindings" });
    expect(screen.queryByRole("table", { name: "Repository bindings" })).toBeNull();
    const card = within(list).getByRole("listitem");
    expect(card).toHaveTextContent("Gadgets");
    expect(card).toHaveTextContent("owner/gadgets");
    expect(card).toHaveTextContent("GitHub id none");
    expect(card.querySelector("[data-slot=installation]")).toHaveTextContent("App installation not known yet: events from any installation are accepted");
    expect(within(card).getByText("Not bound")).toBeInTheDocument();
    expect(card).toHaveTextContent("Didn't bind: why");
    expect(within(card).getByRole("button", { name: "Re-read Gadgets's repo from GitHub" })).toBeInTheDocument();
  });

  it("what a re-read showed outlives the table and the cards swapping (a resize across sm)", async () => {
    let phone = false;
    const listeners = new Set<(e: { matches: boolean }) => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() { return query === "(max-width: 48em)" && phone; }, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.add(f), removeEventListener: (_: string, f: (e: { matches: boolean }) => void) => listeners.delete(f), dispatchEvent: () => false,
    }));
    const api = new FakeApi();
    const b = binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102 });
    api.bindings = [b];
    api.reread = () => ({ binding: b, mismatch: { bound: { full_name: "owner/gadgets", id: 102, owner: null }, github: { full_name: "owner/gadgets", id: 777, owner: null, same_owner: null } } });
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    await waitFor(() => expect(document.querySelector("tr[data-binding=prj_two] [data-slot=mismatch]")).toBeTruthy());
    phone = true;
    act(() => listeners.forEach((f) => f({ matches: true })));
    const list = await screen.findByRole("list", { name: "Repository bindings" });
    expect(list.querySelector("[data-binding=prj_two] [data-slot=mismatch]")).toBeTruthy();
  });

  it("on a phone, a mismatch's card puts Re-read first and Bind last, set apart", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 48em)", media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    const api = new FakeApi();
    const b = binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102 });
    api.bindings = [b];
    api.reread = () => ({ binding: b, mismatch: { bound: { full_name: "owner/gadgets", id: 102, owner: null }, github: { full_name: "owner/gadgets", id: 777, owner: null, same_owner: null } } });
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    const card = await screen.findByRole("listitem");
    const bindButton = await within(card).findByRole("button", { name: "Bind Gadgets to owner/gadgets (repo 777)" });
    const reread = within(card).getByRole("button", { name: "Re-read Gadgets's repo from GitHub" });
    expect(reread.compareDocumentPosition(bindButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.querySelector(".mantine-Divider-root")!.compareDocumentPosition(bindButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getAllByRole("button", { name: /^Bind / })).toHaveLength(1);
    expect(bindButton).toHaveAttribute("data-variant", "light");
  });

  it("a row shows every badge that applies, the most urgent first", async () => {
    const b = binding({ repo_id: null, renamed_to: "a/b", refused: { installation: 2, count: 1, last_ms: 1 } });
    expect(statusBadges(b, true).map((s) => s.label)).toEqual(["Mismatch", "Events refused", "Not bound", "Rename pending"]);
    expect(statusBadges(binding({ repo_id: 5 }), false)).toEqual([]);
    const api = new FakeApi();
    api.bindings = [binding({ project: "prj_two", name: "Gadgets", repo_id: 5, renamed_to: "a/b", refused: { installation: 2, count: 3, last_ms: Date.now() } })];
    renderApp("/admin", api);
    const table = await screen.findByRole("table", { name: "Repository bindings" });
    const row = table.querySelector("[data-binding=prj_two]") as HTMLElement;
    const badges = [...row.querySelectorAll(".mantine-Badge-root")].map((x) => x.textContent);
    expect(badges).toEqual(["Events refused", "Rename pending"]);
  });

  it("says a re-read's outcome in words", () => {
    const b = binding({ repo_id: 5, renamed_to: null });
    expect(rereadText("W", { binding: b, changed: false, previous_id: 5, rename: null })).toEqual({ tone: "success", message: "W's binding is as GitHub says." });
    expect(rereadText("W", { binding: b, changed: true, previous_id: null, rename: { applied: "a/b" } })).toEqual({ tone: "success", message: "W is bound to GitHub's repo 5. It's called a/b now." });
  });

  it("shows a failed sync's reason", async () => {
    const api = new FakeApi();
    api.fail(/^POST \/api\/admin\/sync$/, 503, "NEST_CLIENT_TOKEN is not set");
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Sync catalog" }));
    expect(await screen.findByRole("alert", { name: "The sync failed" })).toHaveTextContent("NEST_CLIENT_TOKEN is not set");
  });
});

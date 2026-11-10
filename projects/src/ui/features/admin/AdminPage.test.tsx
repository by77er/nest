// The admin page runs the catalog sync and shows what it wrote, then the last sync as the Worker recorded it.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RepoBinding } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
import { rereadText } from "./BindingsSection";
import { renderApp } from "../../test/render";

const binding = (o: Partial<RepoBinding> = {}): RepoBinding => ({
  project: "prj_one", name: "Widgets", repo: "owner/widgets", repo_id: 1, renamed_to: null, installation_id: null, bound: "github", bound_ms: null, error: null, ...o,
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

  it("lists each project's repo binding: its id and how it was learned, a rename not applied yet, and why it didn't bind", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.bindings = [
      binding({ project: "prj_one", name: "Widgets", repo: "owner/widgets", repo_id: 101, bound: "github", bound_ms: now - 3_600_000 }),
      binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102, bound: "event", bound_ms: now - 86_400_000, renamed_to: "neworg/gadgets" }),
      binding({ project: "prj_three", name: "Old", repo: "owner/old", repo_id: null, bound: null, error: "GitHub's repo owner/old (7) is project prj_one's" }),
    ];
    renderApp("/admin", api);
    const table = await screen.findByRole("table", { name: "Repository bindings" });
    const row = (p: string) => table.querySelector(`[data-binding=${p}]`) as HTMLElement;
    await waitFor(() => expect(row("prj_one")).toBeTruthy());
    expect(row("prj_one")).toHaveTextContent("owner/widgets");
    expect(row("prj_one")).toHaveTextContent("101");
    expect(row("prj_one")).toHaveTextContent("Read from GitHub 1 hour ago");
    expect(row("prj_two")).toHaveTextContent("From its first event yesterday, not read from GitHub yet");
    expect(row("prj_two").querySelector('[data-tone="warning"]')).toHaveTextContent("Renamed on GitHub to neworg/gadgets: applied once nest's grant names it");
    expect(row("prj_three")).toHaveTextContent("None");
    expect(row("prj_three")).toHaveTextContent("Not bound yet: found by its name");
    expect(row("prj_three").querySelector('[data-tone="danger"]')).toHaveTextContent("is project prj_one's");
  });

  it("re-read posts for that project and says what it did; a refusal says why", async () => {
    const api = new FakeApi();
    const b = binding({ project: "prj_two", name: "Gadgets", repo: "owner/gadgets", repo_id: 102, bound: "event", renamed_to: "neworg/gadgets" });
    api.bindings = [b];
    api.reread = () => ({ binding: { ...b, repo_id: 202, bound: "github" }, changed: true, previous_id: 102, rename: { blocked: "nest's grant for the app doesn't name neworg/gadgets yet: add it, then re-read" } });
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/admin/bindings/prj_two", body: undefined }]));
    expect(await screen.findByText(/Gadgets is bound to GitHub's repo 202 \(was 102\)\. Renamed on GitHub to neworg\/gadgets, not applied: nest's grant/)).toBeInTheDocument();
    api.reread = () => ({ error: "GitHub's repo neworg/gadgets (202) is project prj_one's", binding: b });
    await user.click(screen.getByRole("button", { name: "Re-read Gadgets's repo from GitHub" }));
    expect(await screen.findByText("GitHub's repo neworg/gadgets (202) is project prj_one's")).toBeInTheDocument();
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

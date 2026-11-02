// The admin page runs the catalog sync and shows what it wrote, then the last sync as the Worker recorded it.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

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

  it("shows a failed sync's reason", async () => {
    const api = new FakeApi();
    api.fail(/^POST \/api\/admin\/sync$/, 503, "NEST_CLIENT_TOKEN is not set");
    const { user } = renderApp("/admin", api);
    await user.click(await screen.findByRole("button", { name: "Sync catalog" }));
    expect(await screen.findByRole("alert", { name: "The sync failed" })).toHaveTextContent("NEST_CLIENT_TOKEN is not set");
  });
});

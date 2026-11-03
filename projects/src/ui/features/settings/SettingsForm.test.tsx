// Auto-merge in the project's settings (README.md#auto-merge): the toggle and the merge method are sent
// as the Worker's settings body, and the repo's setting shows its state, with a retry where GitHub
// refused it or someone changed it by hand.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

/** The Settings page (it was a modal): its form, as `dialog` for the tests below. */
async function openSettings(api: FakeApi) {
  const r = renderApp("/projects/prj_one/settings", api);
  await screen.findByRole("heading", { level: 1, name: "Settings" });
  return { ...r, dialog: await screen.findByRole("main") };
}

describe("auto-merge in the settings", () => {
  it("turns on with a merge method, sending both", async () => {
    const api = new FakeApi();
    const { user, dialog } = await openSettings(api);
    // Mantine's Select labels both its input and its hidden value field: the input is the one shown.
    const method = within(dialog).getAllByLabelText("Merge method").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!;
    expect(method).toBeDisabled();
    await user.click(within(dialog).getByRole("switch", { name: /Auto-merge when review passes/ }));
    expect(method).toBeEnabled();
    await user.click(method);
    await user.click(await screen.findByRole("option", { name: "Rebase and merge" }));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toMatchObject({ method: "PATCH", path: "/api/projects/prj_one/settings", body: { auto_merge: true, merge_method: "rebase" } });
  });

  it("shows GitHub's refusal of the repo setting, and retries it", async () => {
    const api = new FakeApi();
    Object.assign(api.projects[0]!.settings, {
      auto_merge: true, repo_auto_merge: { state: "error", want: true, repo: false, error: "GitHub 403: Resource not accessible by integration", at_ms: null },
    });
    const { user, dialog } = await openSettings(api);
    expect(within(dialog).getByText("Error")).toBeInTheDocument();
    expect(within(dialog).getByText("GitHub 403: Resource not accessible by integration")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/auto-merge/retry", body: undefined }]));
  });

  it("shows a change made by hand on GitHub, offering to write the setting back", async () => {
    const api = new FakeApi();
    Object.assign(api.projects[0]!.settings, {
      auto_merge: true, repo_auto_merge: { state: "drifted", want: true, repo: false, error: null, at_ms: Date.now() - 60_000 },
    });
    const { dialog } = await openSettings(api);
    expect(within(dialog).getAllByText("Changed on GitHub").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/The repo doesn't allow auto-merge/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Allow it again" })).toBeInTheDocument();
  });
});

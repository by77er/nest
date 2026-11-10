// Auto-merge in the project's settings (README.md#auto-merge): the toggle and the merge method are sent
// as the Worker's settings body, and the repo's setting shows its state, with a retry where GitHub
// refused it or someone changed it by hand.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { switchText } from "./SettingsForm";

/** The Settings page (it was a modal): its form, as `dialog` for the tests below. */
async function openSettings(api: FakeApi) {
  const r = renderApp("/projects/prj_one/settings", api);
  await screen.findByRole("heading", { level: 3, name: "Settings" });
  return { ...r, dialog: await screen.findByRole("main") };
}

describe("PR comments in the settings", () => {
  it("says whose comments count, warns, and sends a new login only when changed, saying so before it's saved", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings.repo_owner = { id: 7, login: "repo-owner" };
    const { user, dialog } = await openSettings(api);
    const status = dialog.querySelector("[data-slot=comments-status]")!;
    expect(status).toHaveTextContent("Comments from owner (user id 1001) reach a task's worker.");
    expect(within(status as HTMLElement).getByRole("link", { name: "owner" })).toHaveAttribute("href", "https://github.com/owner");
    expect(dialog).toHaveTextContent("Their credentials can comment as them");
    const field = within(dialog).getByLabelText("GitHub user");
    expect(field).toHaveValue("owner");
    expect(dialog.querySelector("[data-slot=comments-draft]")).toBeNull();
    await user.clear(field);
    await user.type(field, "the-maintainer");
    // The draft is said; the status still says what's saved.
    expect(dialog.querySelector("[data-slot=comments-draft]")).toHaveTextContent("Not saved yet: comments from the-maintainer");
    expect(status).toHaveTextContent("Comments from owner (user id 1001)");
    await user.click(within(dialog).getByRole("button", { name: "Use the repo owner (repo-owner)" }));
    expect(field).toHaveValue("repo-owner");
    expect(dialog.querySelector("[data-slot=comments-draft]")).toHaveTextContent("comments from the repo's owner, as GitHub names it when you save");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    // The repo's owner, by id on the server: never its login.
    expect(api.writes[0]!.body).toMatchObject({ comments_from_repo_owner: true });
    expect(api.writes[0]!.body).not.toHaveProperty("comments_from_login");
  });

  it("set by id only: the status and the field's placeholder name the id, and an empty field isn't nobody", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings.comments_from = { id: 5839471, login: null };
    const { dialog } = await openSettings(api);
    expect(dialog.querySelector("[data-slot=comments-status]")).toHaveTextContent("Comments from user id 5839471 (login not seen yet) reach a task's worker.");
    const field = within(dialog).getByLabelText("GitHub user");
    expect(field).toHaveValue("");
    expect(field).toHaveAttribute("placeholder", "User id 5839471 (login not seen yet)");
    expect(dialog).not.toHaveTextContent("Empty: nobody");
    expect(dialog.querySelector("[data-slot=comments-draft]")).toBeNull();
  });

  it("unset: says no one's comments reach workers, and why it can be unset; an untouched field sends nothing", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings.comments_from = null;
    const { user, dialog } = await openSettings(api);
    expect(dialog.querySelector("[data-slot=comments-status]")).toHaveTextContent("No one's PR comments reach workers yet.");
    expect(dialog).toHaveTextContent("It's unset on an organization's repo, and until you set it.");
    expect(dialog).not.toHaveTextContent("Their credentials can comment as them");
    await user.click(within(dialog).getByRole("switch", { name: /Assign ready tasks automatically/ }));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]!.body).not.toHaveProperty("comments_from_login");
  });
});

describe("whose issues come into triage", () => {
  it("is you only by default; choosing anyone sends it", async () => {
    const api = new FakeApi();
    const { user, dialog } = await openSettings(api);
    const from = within(dialog).getAllByLabelText("Issues from").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")! as HTMLInputElement;
    // Who "you" is, by name: the PR comments user and the repo's owner (here the same account).
    expect(from.value).toBe("You only (owner)");
    expect(dialog.querySelector("[data-slot=issues-no-one]")).toBeNull();
    expect(dialog).toHaveTextContent("Issues already waiting stay until you accept or decline them. At most 200 wait at once.");
    await user.click(from);
    await user.click(await screen.findByRole("option", { name: "Anyone" }));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]).toMatchObject({ method: "PATCH", path: "/api/projects/prj_one/settings", body: { issues_from: "anyone" } });
  });
});

describe("who 'you' is for issues", () => {
  it("names both when they differ, and says no one yet (with what to do) when neither is a person", async () => {
    const two = new FakeApi();
    two.projects[0]!.settings = { ...two.projects[0]!.settings!, comments_from: { id: 2, login: "alice" } };
    const a = await openSettings(two);
    expect((within(a.dialog).getAllByLabelText("Issues from").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden") as HTMLInputElement).value).toBe("You only (alice and owner)");
    a.unmount();
    const none = new FakeApi();
    none.projects[0]!.settings = { ...none.projects[0]!.settings!, comments_from: null, repo_owner: null };
    const b = await openSettings(none);
    expect((within(b.dialog).getAllByLabelText("Issues from").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden") as HTMLInputElement).value).toBe("You only (no one yet)");
    expect(b.dialog.querySelector("[data-slot=issues-no-one]")).toHaveTextContent("No one yet: set the PR comments user, or choose Anyone.");
    // The Triage page's Notice links to this panel.
    expect(b.dialog.querySelector("#triage")).toHaveTextContent("Issues from");
  });

  it("arriving by the Triage page's link (#triage), focus lands on the panel's heading", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings = { ...api.projects[0]!.settings!, comments_from: null, repo_owner: null };
    renderApp("/projects/prj_one/settings#triage", api);
    const heading = await screen.findByRole("heading", { name: "Triage" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading.closest("#triage")).not.toBeNull();
  });

  it("focus moves there once per arrival: a Save after it (which remounts the form) leaves focus on Save", async () => {
    const api = new FakeApi();
    const { user, router } = renderApp("/projects/prj_one/settings#triage", api);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Triage" })).toHaveFocus());
    // The hash is gone from the URL.
    await waitFor(() => expect(router.state.location.hash).toBe(""));
    const workers = screen.getByRole("textbox", { name: /Max workers/ });
    await user.clear(workers);
    await user.type(workers, "3");
    const save = screen.getByRole("button", { name: "Save settings" });
    await user.click(save);
    await waitFor(() => expect(api.writes).toHaveLength(1));
    await screen.findByText("Settings saved");
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("heading", { name: "Triage" })).not.toHaveFocus();
  });
});

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

  it("holds untrusted PRs' reviews by default; turning it off warns what that means, and only a change is sent", async () => {
    const api = new FakeApi();
    const { user, dialog } = await openSettings(api);
    const gate = within(dialog).getByRole("switch", { name: /Hold reviews of PRs from forks and authors the project doesn't know/ });
    expect(gate).toBeChecked();
    expect(dialog).not.toHaveTextContent("A reviewer agent will run on anyone's code");
    await user.click(gate);
    expect(dialog).toHaveTextContent("A reviewer agent will run on anyone's code");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]!.body).toMatchObject({ untrusted_reviews: "review" });
    // Saved as off: the switch says so the next time, and an untouched one sends nothing about it.
    const again = new FakeApi();
    again.projects[0]!.settings.untrusted_reviews = "review";
    cleanup();
    const next = await openSettings(again);
    expect(within(next.dialog).getByRole("switch", { name: /Hold reviews of PRs/ })).not.toBeChecked();
    await next.user.click(within(next.dialog).getByRole("switch", { name: /Auto-merge when review passes/ }));
    await next.user.click(within(next.dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(again.writes).toHaveLength(1));
    expect(again.writes[0]!.body).not.toHaveProperty("untrusted_reviews");
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

describe("the manager's model, switched now", () => {
  it("a pending switch says when: after this turn, or now", async () => {
    const turn = new FakeApi();
    turn.projects[0]!.settings = { ...turn.projects[0]!.settings!, manager_model: "claude-sonnet-5-5", manager_switch: { from: "claude-fable-5-2", to: "claude-sonnet-5-5", after_turn: true } };
    const b = await openSettings(turn);
    expect(b.dialog.querySelector("[data-slot=manager-switch]")).toHaveTextContent("Running Fable 5.2; switches to Sonnet 5.5 after this turn.");
    b.unmount();
    const now = new FakeApi();
    now.projects[0]!.settings = { ...now.projects[0]!.settings!, manager_model: "claude-sonnet-5-5", manager_switch: { from: "claude-fable-5-2", to: "claude-sonnet-5-5", after_turn: false } };
    const c = await openSettings(now);
    expect(c.dialog.querySelector("[data-slot=manager-switch]")).toHaveTextContent("Running Fable 5.2; switching to Sonnet 5.5…");
    // A manager from before the switch (its model not recorded): just where it's going.
    expect(switchText({ from: null, to: "claude-sonnet-5-5", after_turn: true })).toBe("Switches to Sonnet 5.5 after this turn.");
    expect(switchText({ from: null, to: "claude-sonnet-5-5", after_turn: false })).toBe("Switching to Sonnet 5.5…");
  });
});

describe("the models in the settings", () => {
  const select = (dialog: HTMLElement, label: string) => within(dialog).getAllByLabelText(label).find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden") as HTMLInputElement;

  it("shows each role's model by name, says when a change applies, and sends a listed choice", async () => {
    const api = new FakeApi();
    const { user, dialog } = await openSettings(api);
    expect(select(dialog, "Manager's model")).toHaveValue("Fable 5.2");
    expect(select(dialog, "Workers' model")).toHaveValue("Opus 5.5");
    expect(dialog).toHaveTextContent("A change applies now: the running manager switches between turns, keeping its conversation.");
    expect(dialog).not.toHaveTextContent("cut and redone");
    expect(dialog.querySelector("[data-slot=manager-switch]")).toBeNull();
    expect(dialog).toHaveTextContent("workers started from now on; running ones keep theirs");
    expect(dialog).toHaveTextContent("Reviewers and routine runs keep nest's default model.");
    await user.click(select(dialog, "Workers' model"));
    await user.click(await screen.findByRole("option", { name: "Sonnet 5.5" }));
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]!.body).toMatchObject({ worker_model: "claude-sonnet-5-5", manager_model: "claude-fable-5-2" });
  });

  it("Custom takes a model id, refusing one that isn't, and sends it as typed", async () => {
    const api = new FakeApi();
    const { user, dialog } = await openSettings(api);
    await user.click(select(dialog, "Manager's model"));
    await user.click(await screen.findByRole("option", { name: "Custom…" }));
    const id = within(dialog).getByLabelText("Manager's model: model id");
    await user.clear(id);
    await user.type(id, "--bad");
    expect(dialog).toHaveTextContent("A model id is letters, digits");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    expect(api.writes).toHaveLength(0);
    await user.clear(id);
    await user.type(id, "claude-opus-5-5[[1m]");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    expect(api.writes[0]!.body).toMatchObject({ manager_model: "claude-opus-5-5[1m]" });
  });

  it("a model that isn't listed shows as Custom with its id", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings.worker_model = "my-org-model-v2";
    const { dialog } = await openSettings(api);
    expect(select(dialog, "Workers' model")).toHaveValue("Custom…");
    expect(within(dialog).getByLabelText("Workers' model: model id")).toHaveValue("my-org-model-v2");
    expect(within(dialog).queryByLabelText("Manager's model: model id")).toBeNull();
  });
});

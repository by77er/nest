// A task's description in its drawer (README.md#descriptions): what an agent wrote renders through the
// chat's safe Markdown path; "Edit" opens the rich editor on the same text; saving sends only what changed,
// as Markdown, so an untouched description is never rewritten.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sameMeaning } from "../../rich/editor-markdown";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
/** The task drawer (titled with its task's title). */
const SHEET = { name: (_: string, el: Element) => el.classList.contains("mantine-Drawer-content") };

const drawer = () => screen.getByRole("dialog", SHEET);

const AGENT = `## Plan

1. Pin the driver
   - staging first
2. Swap the import

- [x] spec agreed
- [ ] tests pass

\`\`\`ts
createClient({ tls: true });
\`\`\`

See [the runbook](https://example.com/runbook).

| env | driver |
|---|---|
| staging | 2.1 |

<script>alert(1)</script> <img src=x onerror=alert(1)>`;

async function open(over: Parameters<typeof task>[0] = {}) {
  const api = new FakeApi();
  const t = task({ title: "Migrate auth", state: "ready", body: AGENT, ...over });
  api.tasks = [t];
  const r = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
  const d = await waitFor(drawer);
  await within(d).findByText("Migrate auth");
  return { ...r, api, t, d };
}

describe("a task's description", () => {
  it("renders what an agent wrote as the chat does: lists, checkboxes, code, links, tables; HTML as text", async () => {
    const { d } = await open();
    const view = d.querySelector('[data-slot="description"]') as HTMLElement;
    // The heading is demoted below the drawer's own (as in the chat).
    expect(within(view).getByRole("heading", { name: "Plan" }).tagName).toMatch(/^H[4-6]$/);
    expect(within(view).getByText("Pin the driver").closest("ol")).not.toBeNull();
    expect(within(view).getByText("staging first").closest("ul")).not.toBeNull();
    expect(view.querySelectorAll("[data-task-check]")).toHaveLength(2);
    // Highlighted (its tokens are spans), as in the chat.
    expect(view.querySelector("pre code")).toHaveTextContent("createClient({ tls: true });");
    const link = within(view).getByRole("link", { name: "the runbook" });
    expect(link).toHaveAttribute("href", "https://example.com/runbook");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(view).getByRole("table")).toBeInTheDocument();
    // Raw HTML is shown as text, never run or loaded.
    expect(view.querySelector("script, img")).toBeNull();
    expect(view).toHaveTextContent("<script>alert(1)</script>");
  });

  it("opens the editor on the same text, every block its own node or kept as written, and an untouched save sends nothing", async () => {
    const { d, user, api } = await open();
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const box = await within(d).findByRole("textbox", { name: "Details" });
    expect(within(d).getByLabelText(/Title/)).toHaveFocus();
    expect(within(box).getByText("Pin the driver").closest("ol")).not.toBeNull();
    expect(box.querySelectorAll('ul[data-type="taskList"] li')).toHaveLength(2);
    expect(within(box).getByText("createClient({ tls: true });").closest("pre")).not.toBeNull();
    // The table and the HTML have no node in the editor: shown as their source, labelled, not dropped.
    const kept = [...box.querySelectorAll("[data-markdown-block]")].map((k) => k.querySelector("pre")!.textContent);
    expect(kept).toEqual(["| env | driver |\n|---|---|\n| staging | 2.1 |", "<script>alert(1)</script> <img src=x onerror=alert(1)>"]);
    // Each says why, and that its Markdown is edited there.
    expect(within(box).getAllByRole("group", { name: /Markdown the editor can't show/ })).toHaveLength(2);
    expect([...box.querySelectorAll("[data-markdown-block-label]")].map((l) => l.textContent)).toEqual([
      "The editor can't show this (a table); edit its Markdown here",
      "The editor can't show this (HTML); edit its Markdown here",
    ]);
    expect(within(d).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(d).getByRole("button", { name: "Cancel" }));
    expect(api.writes).toEqual([]);
    expect(within(d).queryByRole("textbox", { name: "Details" })).toBeNull();
    // Focus went to the title as the form opened, and back to Edit as it closed.
    expect(within(d).getByRole("button", { name: "Edit the title and description" })).toHaveFocus();
  });

  it("saves an edit as Markdown, sending the description only, the rest of it meaning the same", async () => {
    const { d, user, api, t } = await open();
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const box = await within(d).findByRole("textbox", { name: "Details" });
    // The caret at the start of the paragraph with the link, as a click there puts it (jsdom lays nothing
    // out, so the selection is set as the browser would, and ProseMirror reads it), then typing.
    const see = within(box).getByText(/^See/);
    await user.click(box);
    const at = document.createRange();
    at.setStart(see.firstChild!, 0);
    at.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(at);
    document.dispatchEvent(new Event("selectionchange"));
    await user.keyboard("Read it twice. ");
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes).toHaveLength(1));
    const w = api.writes[0]!;
    expect(w).toMatchObject({ method: "PATCH", path: `/api/projects/prj_one/tasks/${t.id}` });
    expect(Object.keys(w.body as object)).toEqual(["body"]);
    const body = (w.body as { body: string }).body;
    expect(body).toContain("Read it twice. See [the runbook](https://example.com/runbook).");
    expect(sameMeaning(body, AGENT.replace("See [the runbook]", "Read it twice. See [the runbook]")), body).toBe(true);
    // Back to the rendered view, with the new text.
    expect(await within(d).findByText(/Read it twice\./)).toBeInTheDocument();
  });

  it("a renamed task sends its title only: its description isn't rewritten", async () => {
    const { d, user, api, t } = await open();
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const title = await within(d).findByLabelText(/Title/);
    await user.clear(title);
    await user.type(title, "Migrate the auth library");
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "PATCH", path: `/api/projects/prj_one/tasks/${t.id}`, body: { title: "Migrate the auth library" } }]));
  });

  it("the toolbar's controls are labelled buttons, and act on the text", async () => {
    const { d, user, api } = await open({ body: "" });
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const bar = await within(d).findByRole("group", { name: "Details: formatting" });
    // The common marks first; one Heading (a description's headings are one size).
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Bold", "Italic", "Code", "Bullet list", "Ordered list", "Task list", "Link", "Remove link", "Heading", "Code block", "Blockquote", "Strikethrough"]);
    for (const name of ["Bold", "Heading", "Code", "Code block"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    const box = within(d).getByRole("textbox", { name: "Details" });
    await user.type(box, "first");
    await user.click(within(bar).getByRole("button", { name: "Bullet list" }));
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes.at(-1)?.body).toEqual({ body: "- first" }));
  });

  it("the drawer's heading is the task's title; Cancel and Save are the section's, at its top right", async () => {
    const { d, user } = await open();
    expect(within(d).getByRole("heading", { name: "Migrate auth", level: 2 })).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    await within(d).findByRole("textbox", { name: "Details" });
    const head = within(d).getByRole("heading", { name: "Description" }).closest('[data-slot="head"]') as HTMLElement;
    expect(within(head).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel", "Save"]);
  });

  it("Escape leaves a clean form, the drawer staying open; with changes it asks first, Keep editing the default", async () => {
    const { d, user, api } = await open();
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const title = await within(d).findByLabelText(/Title/);
    await user.keyboard("{Escape}");
    expect(within(d).queryByRole("textbox", { name: "Details" })).toBeNull();
    expect(drawer()).toBeInTheDocument();
    // And from the description's text, when clean.
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    await user.click(await within(d).findByRole("textbox", { name: "Details" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(d).queryByRole("textbox", { name: "Details" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();

    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    await user.type(await within(d).findByLabelText(/Title/), " now");
    await user.keyboard("{Escape}");
    const ask = await screen.findByRole("dialog", { name: "Discard changes?" });
    expect(within(ask).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    await user.click(within(ask).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull());
    expect(within(d).getByLabelText(/Title/)).toHaveValue("Migrate auth now");
    void title;

    // Escape in the description's text does the same as in the title (the editor would take it).
    await user.click(within(d).getByRole("textbox", { name: "Details" }));
    await user.keyboard("{Escape}");
    const fromBody = await screen.findByRole("dialog", { name: "Discard changes?" });
    await user.click(within(fromBody).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull());

    // Closing the drawer with changes asks too; Discard drops them and closes it.
    await user.click(within(d).getByRole("button", { name: "Close" }));
    const again = await screen.findByRole("dialog", { name: "Discard changes?" });
    await user.click(within(again).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog", SHEET)).toBeNull());
    expect(api.writes).toEqual([]);
  });

  it("a kept block's Markdown is edited in place, and saved as edited", async () => {
    const { d, user, api } = await open({ body: "Intro.\n\n| a |\n|---|\n| 1 |" });
    await user.click(within(d).getByRole("button", { name: "Edit the title and description" }));
    const box = await within(d).findByRole("textbox", { name: "Details" });
    const pre = box.querySelector("[data-markdown-block] pre")!;
    await user.click(box);
    const at = document.createRange();
    at.setStart(pre.firstChild!, pre.textContent!.length);
    at.collapse(true);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(at);
    document.dispatchEvent(new Event("selectionchange"));
    await user.keyboard("{Enter}| 2 |");
    await user.click(within(d).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes.at(-1)?.body).toEqual({ body: "Intro.\n\n| a |\n|---|\n| 1 |\n| 2 |" }));
  });

  it("a finished task's description is read only: no Edit", async () => {
    const { d } = await open({ state: "done" });
    expect(within(d).queryByRole("button", { name: "Edit the title and description" })).toBeNull();
    expect(d.querySelector('[data-slot="description"]')).toHaveTextContent("Pin the driver");
  });
});

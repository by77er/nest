// A manager's message rendered (README.md#rich-messages): Markdown, math, SVG and task references, and
// everything it must never do: render raw HTML, follow a script or data: link, load a remote image, put
// an SVG in the DOM, or show a task from the message's own text.
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { keys } from "../../api/queries";
import { createQueryClient } from "../../api/queryClient";
import type { Ask } from "../../api/types";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { cssVariablesResolver, theme } from "../../theme";
import { sanitizeSvg, SVG_MAX_BYTES } from "../../rich/svg";
import { HIGHLIGHT_MAX } from "../../rich/highlight";
import { RichMessage } from "./RichMessage";
/** The task drawer (titled with its task's title). */
const SHEET = { name: (_: string, el: Element) => el.classList.contains("mantine-Drawer-content") };

/** The message alone, over a board of `tasks`. */
async function show(text: string, tasks = [task({ title: "Live title", state: "in_review", pr: 9 })], asks: Ask[] = []) {
  const api = new FakeApi();
  api.tasks = tasks;
  api.asks = asks;
  vi.stubGlobal("fetch", api.fetch);
  const qc = createQueryClient();
  qc.setQueryData(keys.tasks("prj_one"), tasks);
  // A router of its own, so the task links resolve (to the app's board path) without the whole app.
  const root = createRootRoute({ component: () => <RichMessage text={text} projectId="prj_one" /> });
  const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/projects/$projectId/board" })]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  const view = render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  const el = await waitFor(() => {
    const r = view.container.querySelector("[data-ds=rich]");
    if (!r) throw new Error("not rendered yet");
    return r as HTMLElement;
  });
  return { ...view, tasks, qc, root: el };
}

describe("Markdown", () => {
  it("renders headings, lists, task lists, tables, quotes, code and links", async () => {
    const { root } = await show(
      [
        "## Plan",
        "- one\n- two",
        "- [x] done\n- [ ] not yet",
        "| a | b |\n|---|---|\n| 1 | 2 |",
        "> quoted",
        "Some `inline` code.",
        "```ts\nconst x = 1;\n```",
        "[docs](https://example.com/docs)",
      ].join("\n\n"),
    );
    // Demoted by three: a message's headings sit under the page's own.
    expect(within(root).getByRole("heading", { level: 5, name: "Plan" })).toBeInTheDocument();
    expect(within(root).getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
    const boxes = within(root).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    for (const b of boxes) expect(b).not.toHaveAttribute("tabindex");
    expect(within(root).getByRole("table").closest("[data-ds=rich-table]")).not.toBeNull();
    expect(root.querySelector("blockquote")).toHaveTextContent("quoted");
    expect(root.querySelector("pre code")).toHaveTextContent("const x = 1;");
    const link = within(root).getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("highlights a fence in a language it knows, under its language and a Copy that copies the code itself", async () => {
    // user-event's clipboard stands in for the browser's (set up per test, restored after it).
    const user = userEvent.setup();
    const { root } = await show(["```ts\nconst x = \"a\"; // why\n```", "```klingon\nqapla'\n```", "```\nplain <b>\n```"].join("\n\n"));
    const [ts, unknown, bare] = [...root.querySelectorAll<HTMLElement>("[data-ds=code-block]")];
    // Tokens as elements (never markup from a string), coloured by the theme through their classes.
    const code = ts!.querySelector("code")!;
    expect(code).toHaveAttribute("data-highlighted");
    expect(code.querySelector(".hljs-keyword")).toHaveTextContent("const");
    expect(code.querySelector(".hljs-string")).toHaveTextContent('"a"');
    expect(code.querySelector(".hljs-comment")).toHaveTextContent("// why");
    expect(ts).toHaveTextContent(/^ts/);
    // A language it doesn't know, or none, stays plain text: nothing guessed.
    expect(unknown!.querySelector("code")).not.toHaveAttribute("data-highlighted");
    expect(unknown!.querySelector("[class^=hljs]")).toBeNull();
    expect(bare!.querySelector("code")!.innerHTML).toBe('<span data-line="">plain &lt;b&gt;\n</span>');
    // Copy takes the code's text, not its token spans.
    await user.click(within(ts!).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe('const x = "a"; // why');
    expect(await within(ts!).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("shows a long fence's first 20 lines, then all of it on asking; Copy copies all of it either way", async () => {
    const user = userEvent.setup();
    // A comment spanning lines 1-3: cut into a token per line, each still a comment.
    const lines = ["/* one", "   two", "   three */", ...Array.from({ length: 27 }, (_, i) => `const v${i + 4} = ${i + 4};`)];
    const { root } = await show("```ts\n" + lines.join("\n") + "\n```");
    const block = root.querySelector<HTMLElement>("[data-ds=code-block]")!;
    const shown = () => [...block.querySelectorAll("code [data-line]")].map((l) => l.textContent!.replace(/\n$/, ""));
    expect(shown()).toEqual(lines.slice(0, 20));
    expect([...block.querySelectorAll("code [data-line]")].slice(0, 3).map((l) => l.querySelector(".hljs-comment")?.textContent)).toEqual(["/* one", "   two", "   three */"]);
    await user.click(within(block).getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe(lines.join("\n"));
    const more = within(block).getByRole("button", { name: "Show all 30 lines" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(shown()).toEqual(lines);
    await user.click(within(block).getByRole("button", { name: "Show fewer lines" }));
    expect(shown()).toHaveLength(20);
  });

  it("shows a fence of 25 lines whole, with no Show all", async () => {
    const { root } = await show("```\n" + Array.from({ length: 25 }, (_, i) => `line ${i}`).join("\n") + "\n```");
    expect(root.querySelectorAll("code [data-line]")).toHaveLength(25);
    expect(within(root).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("leaves a fence longer than the cap plain, and highlights console sessions as sessions, scripts as scripts", async () => {
    const big = "const x = 1;\n".repeat(Math.ceil(HIGHLIGHT_MAX / 13) + 1);
    const { root } = await show(["```ts\n" + big + "```", "```console\n$ npm test\nok\n```"].join("\n\n"));
    const [long, session] = [...root.querySelectorAll<HTMLElement>("[data-ds=code-block] code")];
    expect(long).not.toHaveAttribute("data-highlighted");
    expect(session).toHaveAttribute("data-highlighted");
    expect(session!.querySelector(".hljs-meta")).toHaveTextContent("$");
  });

  it("escapes raw HTML: it shows as text, never as markup", async () => {
    const { root } = await show('Hello <b>bold</b> <img src="https://x.test/p.gif" onerror="alert(1)"> <script>alert(1)</script>');
    expect(root.querySelector("b, img, script")).toBeNull();
    expect(root).toHaveTextContent("<b>bold</b>");
    expect(root).toHaveTextContent("<script>alert(1)</script>");
  });

  it("links only http, https and mailto: javascript: and data: links are plain text", async () => {
    const { root } = await show("[a](javascript:alert(1)) [b](data:text/html;base64,PHNjcmlwdD4=) [c](mailto:x@example.com) [d](vbscript:x)");
    const links = within(root).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["mailto:x@example.com"]);
    expect(root).toHaveTextContent("a b c d");
  });

  it("shows no remote image: a link labelled with its alt text; a data: raster inline", async () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const { root } = await show(`![a pixel](https://tracker.test/p.gif) ![chart](${png})`);
    const imgs = root.querySelectorAll("img");
    expect([...imgs].map((i) => i.getAttribute("src"))).toEqual([png]);
    expect(within(root).getByRole("link", { name: "a pixel" })).toHaveAttribute("href", "https://tracker.test/p.gif");
  });
});

describe("math", () => {
  it("renders inline and display math, with MathML for readers", async () => {
    const { root } = await show("Inline $\\frac{a}{b}$ and:\n\n$$\n\\sum_{i=1}^{n} i\n$$\n\n```math\n\\begin{pmatrix}1 & 0\\\\0 & 1\\end{pmatrix}\n```");
    expect(root.querySelectorAll(".katex math").length).toBe(3);
    expect(root.querySelectorAll(".katex-display").length).toBe(2);
  });

  it("makes no link of \\href, and shows a bad formula as its source", async () => {
    // Even an ordinary https link: trust is off, so KaTeX makes no link at all (not only of javascript:).
    const { root } = await show("$\\href{javascript:alert(1)}{x}$ $\\href{https://example.com}{y}$ $\\url{https://example.com}$ and $\\frac{1}{$");
    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector(".katex-error")).not.toBeNull();
    expect(root).toHaveTextContent("\\frac{1}{");
  });

  it("still escapes raw HTML with math in the pipeline", async () => {
    const { root } = await show("$x$ <i onclick=x>i</i>");
    expect(root.querySelector("i[onclick]")).toBeNull();
    expect(root).toHaveTextContent("<i onclick=x>i</i>");
  });
});

describe("SVG", () => {
  const evil = [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></div></foreignObject><rect width="1" height="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="https://evil.test/s.svg#x"/><rect width="1" height="1"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(https://evil.test/x.css);</style><rect width="1" height="1"/></svg>',
  ];

  it.each(evil)("a malicious SVG becomes an <img> with a clean source: %s", async (svg) => {
    const { root } = await show(`Look:\n\n\`\`\`svg\n${svg}\n\`\`\``);
    expect(root.querySelector("svg:not(.tabler-icon)")).toBeNull();
    const img = root.querySelector("[data-ds=svg-figure] img")!;
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
    const clean = new TextDecoder().decode(Uint8Array.from(atob(img.getAttribute("src")!.split(",")[1]!), (c) => c.charCodeAt(0)));
    expect(clean).not.toMatch(/<script|onload|onerror|foreignObject|javascript:|@import|https:\/\/evil/i);
  });

  it("finds an inline <svg> in the text, before Markdown, and shows it as an image too", async () => {
    const { root } = await show('Here: <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5" onclick="x()"/></svg> done');
    expect(root.querySelector("svg:not(.tabler-icon)")).toBeNull();
    expect(root.querySelectorAll("[data-ds=svg-figure] img")).toHaveLength(1);
    expect(root).toHaveTextContent("Here:");
    expect(root).toHaveTextContent("done");
  });

  it("refuses one over the size cap, with a notice", async () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(SVG_MAX_BYTES / 7 + 10)}</svg>`;
    expect(sanitizeSvg(big).ok).toBe(false);
    const { root } = await show(`\`\`\`svg\n${big}\n\`\`\``);
    expect(root.querySelector("img")).toBeNull();
    expect(root).toHaveTextContent("Diagram not shown");
  });
});

describe("task references", () => {
  it("a link and a bare reference render as chips with the live title and state, not the message's", async () => {
    const t = task({ title: "Live title", state: "in_review" });
    const { root } = await show(`See [an old name](task:${t.id}) and task:${t.id}.`, [t]);
    const chips = root.querySelectorAll("[data-ds=task-chip]");
    expect(chips).toHaveLength(2);
    for (const c of chips) {
      expect(c).toHaveTextContent("Live title");
      expect(c).not.toHaveTextContent("an old name");
      expect(c.querySelector("[data-state=in_review]")).not.toBeNull();
      expect(c).toHaveAttribute("href", `/projects/prj_one/board?task=${t.id}`);
      // The title reads first, then the state; the chip is phrasing content inside the paragraph.
      expect(c.firstElementChild).toHaveTextContent("Live title");
      expect(c.querySelector("div, p")).toBeNull();
      expect(c.closest("p")).not.toBeNull();
    }
  });

  it("while the board loads, a reference is a chip-sized placeholder, then the chip", async () => {
    const t = task({ title: "Arrives later", state: "ready" });
    const api = new FakeApi();
    api.chat = [{ seq: 1, at_ms: Date.now(), sender: "manager", text: `See task:${t.id}.`, delivered: true, error: null }];
    let release!: () => void;
    api.holds.push({ match: /^GET .*\/tasks$/, until: new Promise<void>((r) => (release = r)) });
    api.tasks = [t];
    renderApp("/projects/prj_one/manager", api);
    const pending = await screen.findByText(`task:${t.id}`);
    const chip = pending.closest("[data-ds=task-chip]")!;
    expect(chip).toHaveAttribute("data-pending");
    expect(chip.querySelector("a")).toBeNull();
    release();
    expect(await screen.findByRole("link", { name: "Task Arrives later" })).toBeInTheDocument();
  });

  it("an id the board doesn't have is plain text: no chip, no card, no link", async () => {
    const t = task({ title: "Ours" });
    const { root } = await show("[theirs](task:tsk_notours) task:tsk_gone\n\n```tasks\ntsk_notours a note\n```", [t]);
    expect(root.querySelectorAll("[data-ds=task-chip], [data-ds=task-card], a")).toHaveLength(0);
    expect(root).toHaveTextContent("theirs");
    expect(root).toHaveTextContent("task:tsk_gone");
    expect([...root.querySelectorAll("code[data-task-ref=unresolved]")].map((c) => c.textContent)).toEqual(["theirs", "task:tsk_gone"]);
    expect(root).toHaveTextContent("tsk_notours a note");
  });

  it("a tasks block renders a card per task as the Board does: state, assignee, PR, Blocked, Needs input and the note", async () => {
    const a = task({ title: "First", state: "in_progress", assignee: "agt_w1", pr: 42 });
    const b = task({ title: "Second", state: "stalled", blocked: { at_ms: 1, by: "agt_w2", role: "worker", reason: "needs a key", question: null, tainted: false } });
    const fence = "```";
    const asks = [ask({ task: b.id, question: "Which key?" }), ask({ task: a.id, question: "Done already", answered_ms: 5 })];
    const { root } = await show(`Status:\n\n${fence}tasks\n${a.id} — PR is up\n${b.id}\n${fence}`, [a, b], asks);
    const cards = [...root.querySelectorAll("[data-ds=task-card]")] as HTMLElement[];
    expect(cards.map((c) => c.getAttribute("data-task-ref"))).toEqual([a.id, b.id]);
    expect(cards[0]).toHaveTextContent("First");
    expect(cards[0]).toHaveTextContent("agt_w1");
    expect(cards[0]).toHaveTextContent("#42");
    expect(cards[0]).toHaveTextContent("PR is up");
    expect(cards[0]!.querySelector("[data-state=in_progress]")).not.toBeNull();
    expect(cards[0]!.querySelector("[data-marker=blocked], [data-marker=ask]")).toBeNull();
    expect(cards[1]!.querySelector("[data-marker=blocked]")).not.toBeNull();
    // An open ask from its worker, as on the Board; an answered one is not.
    await waitFor(() => expect(cards[1]!.querySelector("[data-marker=ask]")).not.toBeNull());
    expect(cards[0]!.querySelector("[data-marker=ask]")).toBeNull();
    expect(within(cards[1]!).getByRole("link", { name: "Second" })).toHaveAttribute("href", `/projects/prj_one/board?task=${b.id}`);
  });

  it("follows the board: a change to the task shows in the chip", async () => {
    const t = task({ title: "Before", state: "ready" });
    const { root, qc } = await show(`task:${t.id}`, [t]);
    expect(root).toHaveTextContent("Before");
    // The board's cache is the one source: a poll bringing a new title re-renders the chip.
    act(() => qc.setQueryData(keys.tasks("prj_one"), [{ ...t, title: "After", state: "in_progress" }]));
    await waitFor(() => expect(root).toHaveTextContent("After"));
    expect(root.querySelector("[data-state=in_progress]")).not.toBeNull();
  });

  it("a chip survives the chat re-rendering around it: the same node, not a remount", async () => {
    const api = new FakeApi();
    const t = task({ title: "Stay put", state: "ready" });
    api.tasks = [t];
    api.chat = [{ seq: 1, at_ms: Date.now(), sender: "manager", text: `See task:${t.id}.`, delivered: true, error: null }];
    const { user } = renderApp("/projects/prj_one/manager", api);
    const chip = await screen.findByRole("link", { name: "Task Stay put" });
    // Typing re-renders the chat (its state), and so every message in it.
    await user.type(screen.getByLabelText("Message to the manager"), "abc");
    expect(chip.isConnected).toBe(true);
    expect(screen.getByRole("link", { name: "Task Stay put" })).toBe(chip);
  });

  it("clicking a chip in the chat opens the task in the board's drawer", async () => {
    const api = new FakeApi();
    const t = task({ title: "Click me", state: "ready" });
    api.tasks = [t];
    api.chat = [{ seq: 1, at_ms: Date.now(), sender: "manager", text: `Created task:${t.id}.`, delivered: true, error: null }];
    const { user, router } = renderApp("/projects/prj_one/manager", api);
    const chip = await screen.findByRole("link", { name: "Task Click me" });
    await user.click(chip);
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/prj_one/board"));
    expect(router.state.location.search).toEqual({ task: t.id });
    expect(await screen.findByRole("dialog", SHEET)).toBeInTheDocument();
  });
});

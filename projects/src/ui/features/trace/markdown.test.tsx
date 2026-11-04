// An assistant's text in a trace as Markdown, the way Claude Code prints it (README.md#the-live-trace): each
// element, the chat's safe path (raw HTML inert, no image loaded, no math or SVG), half-written Markdown
// mid-stream showing all its text, only the assistant's text parsed, and history and live alike.
import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "../../test/fakeSocket";
import { cssVariablesResolver, theme } from "../../theme";
import { ManagerTrace } from "./AgentTraces";
import { TraceMarkdown } from "./TraceMarkdown";

function renderAlone(node: ReactNode) {
  return render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      {node}
    </MantineProvider>,
  );
}
const md = (text: string) => renderAlone(<TraceMarkdown text={text} />).container.querySelector('[data-ds="term-prose"]') as HTMLElement;

describe("an assistant's Markdown", () => {
  it("headings are bold lines, not the page's headings", () => {
    const el = md("# Plan\n\n### Then");
    expect(screen.queryByRole("heading")).toBeNull();
    expect([...el.querySelectorAll('[data-md="heading"]')].map((h) => h.textContent)).toEqual(["Plan", "Then"]);
  });

  it("bold, italic and inline code", () => {
    const el = md("Run **all** the *slow* tests with `npm test`.");
    expect(el.querySelector("strong")).toHaveTextContent("all");
    expect(el.querySelector("em")).toHaveTextContent("slow");
    expect(el.querySelector("p > code")).toHaveTextContent("npm test");
  });

  it("a fenced block verbatim: its spacing kept, nothing parsed inside it", () => {
    const code = "if (a) {\n    return **b**;   // <b>c</b>\n}";
    const el = md(`Here:\n\n\`\`\`ts\n${code}\n\`\`\``);
    const pre = el.querySelector("pre")!;
    expect(pre.textContent).toBe(`${code}\n`);
    expect(pre.querySelector("strong, b")).toBeNull();
  });

  it("bullet and numbered lists, nested", () => {
    const el = md("1. first\n   - a\n   - b\n2. second");
    expect(el.querySelector("ol > li > ul > li")).toHaveTextContent("a");
    expect(el.querySelectorAll("ol > li")).toHaveLength(2);
  });

  it("a task list's boxes as text", () => {
    const el = md("- [x] done\n- [ ] todo");
    expect([...el.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["[x] done", "[ ] todo"]);
    expect(el.querySelector("input")).toBeNull();
  });

  it("a quote, a rule, and a link that opens in a new tab", () => {
    const el = md("> careful\n\n---\n\nSee [the docs](https://example.com/docs).");
    expect(el.querySelector("blockquote")).toHaveTextContent("careful");
    expect(el.querySelector("hr")).not.toBeNull();
    const a = el.querySelector("a")!;
    expect(a).toHaveAttribute("href", "https://example.com/docs");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("a table as a grid in its own scrolling frame", () => {
    const el = md("| file | lines |\n|---|---:|\n| a.ts | 12 |");
    const frame = el.querySelector('[data-md="table"]')!;
    expect(frame.querySelector("table th")).toHaveTextContent("file");
    expect([...frame.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["a.ts", "12"]);
  });

  it("raw HTML is text, never run or loaded; no image is fetched; an unsafe link is text", () => {
    const el = md('<script>alert(1)</script> <img src=x onerror="alert(1)">\n\n![a chart](https://example.com/c.png)\n\n[click](javascript:alert(1))');
    expect(el.querySelector("script, img, iframe")).toBeNull();
    expect(el).toHaveTextContent('<script>alert(1)</script> <img src=x onerror="alert(1)">');
    expect(el.querySelector('[data-md="image"]')).toHaveTextContent("[image: a chart]");
    expect(el.querySelector("a")).toBeNull();
    expect(el).toHaveTextContent("click");
  });

  it("no math and no SVG figure: they stay text and code", () => {
    const el = md("$$\nx^2\n$$\n\n```svg\n<svg><circle r=\"4\"/></svg>\n```");
    expect(el.querySelector(".katex, img, svg")).toBeNull();
    expect(el).toHaveTextContent("$$ x^2 $$");
    expect(el.querySelector("pre")).toHaveTextContent('<svg><circle r="4"/></svg>');
  });
});

describe("half-written Markdown, mid-stream", () => {
  const FULL = "## Plan\n\nRun **every** test, then `npm run build`:\n\n```sh\nnpm test --  --runInBand\n```\n\n- one *item*\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.";
  // The words a reader sees: what's left once the Markdown's own marks are gone.
  const words = (s: string) => s.replace(/[#*`|\-:]/g, " ").split(/\s+/).filter(Boolean);

  it("shows every word written so far, at every point: an open fence or `**` swallows nothing", () => {
    for (let n = 1; n <= FULL.length; n++) {
      const prefix = FULL.slice(0, n);
      const { container, unmount } = renderAlone(<TraceMarkdown text={prefix} />);
      const shown = words(container.textContent ?? "").join(" ");
      for (const w of words(prefix)) expect(shown, `at ${n}: ${JSON.stringify(prefix)}`).toContain(w);
      unmount();
    }
  });

  it("an open fence is already the code block it will be: closing it changes nothing above", () => {
    const open = md("Now:\n\n```sh\nnpm test");
    expect(open.querySelector("pre")).toHaveTextContent("npm test");
    const shut = md("Now:\n\n```sh\nnpm test\n```");
    expect(shut.querySelector("p")!.outerHTML).toBe(open.querySelector("p")!.outerHTML);
    expect(shut.querySelector("pre")!.outerHTML).toBe(open.querySelector("pre")!.outerHTML);
  });
});

// --- In the trace ---------------------------------------------------------------------------------------

beforeEach(() => FakeSocket.reset());
afterEach(() => vi.unstubAllGlobals());

const TEXT = "## Found it\n\nThe **retry** loop in `upload.ts`:\n\n```ts\nfor (;;) {}\n```\n\n- fix it\n- test it";

async function trace(msgs: unknown[]) {
  vi.stubGlobal("WebSocket", FakeSocket);
  renderAlone(<ManagerTrace settings={{ manager: "agt_manager" }} />);
  const sock = await waitFor(() => FakeSocket.latest("/api/agents/agt_manager/trace")!);
  act(() => {
    sock.open();
    for (const m of msgs) sock.message(m);
  });
  return screen.getByRole("heading", { name: "Manager's trace" }).closest('[data-ds="section"]') as HTMLElement;
}

describe("in the trace", () => {
  it("only the assistant's text is Markdown: tool calls, results and errors stay raw text", async () => {
    const panel = await trace([
      { seq: 1, ts_ms: 1, type: "turn_started", turn: "t", input_kind: "user" },
      { seq: 2, ts_ms: 2, type: "assistant_text", turn: "t", text: "**bold**" },
      { seq: 3, ts_ms: 3, type: "tool_call", turn: "t", call_id: "c1", name: "Bash", input: '{"command":"echo **x**"}' },
      { seq: 4, ts_ms: 4, type: "tool_result", turn: "t", call_id: "c1", is_error: false, summary: "# not a heading\n**not bold**" },
      { seq: 5, ts_ms: 5, type: "error", turn: "t", code: "boom", message: "`not code`" },
      { type: "live" },
    ]);
    expect(panel.querySelector('[data-kind="text"] strong')).toHaveTextContent("bold");
    const raw = [...panel.querySelectorAll('[data-kind="tool"], [data-kind="error"]')];
    for (const r of raw) expect(r.querySelector('strong, em, code, [data-md], [data-ds="term-prose"]')).toBeNull();
    expect(panel.querySelector('[data-kind="tool_result"]')).toHaveTextContent("# not a heading **not bold**");
    expect(panel.querySelector('[data-kind="error"]')).toHaveTextContent("boom: `not code`");
  });

  it("history and live render the same text the same way", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ events: [{ ts_ms: 1, entry: 1, type: "turn_started", input_kind: "unknown" }, { ts_ms: 2, entry: 2, type: "assistant_text", text: TEXT }], next_before: null }), { headers: { "content-type": "application/json" } }));
    const panel = await trace([
      { type: "history", before: "c1" },
      { seq: 10, ts_ms: 10, type: "turn_started", turn: "t", input_kind: "user" },
      { seq: 11, ts_ms: 11, type: "assistant_text", turn: "t", text: TEXT },
      { type: "live" },
    ]);
    await waitFor(() => expect(panel.querySelectorAll('[data-kind="text"]')).toHaveLength(2));
    const [older, live] = [...panel.querySelectorAll('[data-kind="text"] [data-ds="term-prose"]')].map((p) => p.innerHTML);
    expect(older).toBe(live);
    expect(live).toContain("<strong>retry</strong>");
  });
});

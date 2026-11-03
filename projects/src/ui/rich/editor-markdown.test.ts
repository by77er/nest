// A description's round trip through the editor (README.md#descriptions): what an agent writes comes
// into the editor and back out meaning the same to the renderer; what the editor has no node for is kept
// as written, never dropped; an edit changes only what was edited; a paste keeps only the editor's nodes.

import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { EDITOR_EXTENSIONS, fromMarkdown, normalized, sameMeaning, toMarkdown } from "./editor-markdown";

/** What an agent might write: every block the editor has a node for. */
const AGENT = `# Migrate the auth library

Move from \`old-auth\` to **new-auth**, keeping *every* session. See [the plan](https://example.com/plan) and task:tsk_ab12cd.

## Steps

1. Pin the driver
   - in \`staging\` first
   - then prod
     1. canary
     2. the rest
2. Swap the import

- [ ] tests pass
- [x] spec agreed
  - [ ] nested check

\`\`\`ts
const client = createClient({ tls: true });
\`\`\`

> The staging database rejects the new driver's TLS settings.

---

A line
broken, and ~~struck~~ text with snake_case_names and 2 * 3 * 4.`;

const kinds = (doc: JSONContent) => (doc.content ?? []).map((n) => n.type);
const kept = (doc: JSONContent) => (doc.content ?? []).filter((n) => n.type === "markdownBlock").map((n) => n.attrs?.source);

describe("what an agent writes", () => {
  it("comes into the editor as its own nodes, and back out meaning the same", () => {
    const doc = fromMarkdown(AGENT);
    expect(kept(doc)).toEqual([]);
    expect(kinds(doc)).toEqual(["heading", "paragraph", "heading", "orderedList", "taskList", "codeBlock", "blockquote", "horizontalRule", "paragraph"]);
    const out = toMarkdown(doc);
    expect(sameMeaning(AGENT, out)).toBe(true);
    // Saved again untouched, it's the same text: no drift from one save to the next.
    expect(normalized(out)).toBe(out);
  });

  it("keeps the details the renderer sees: heading levels, nesting, a fence's language, a link's target, each checkbox", () => {
    const out = normalized(AGENT);
    expect(out).toContain("# Migrate the auth library");
    expect(out).toContain("## Steps");
    expect(out).toMatch(/^ {5}1\. canary$/m);
    expect(out).toContain("```ts\nconst client = createClient({ tls: true });\n```");
    expect(out).toContain("[the plan](https://example.com/plan)");
    expect(out).toMatch(/^- \[ \] tests pass$/m);
    expect(out).toMatch(/^- \[x\] spec agreed$/m);
    expect(out).toMatch(/^ {2}- \[ \] nested check$/m);
  });

  it("an empty description is empty both ways", () => {
    expect(kinds(fromMarkdown(""))).toEqual(["paragraph"]);
    expect(toMarkdown(fromMarkdown(""))).toBe("");
    expect(normalized("  \n\n ")).toBe("");
  });
});

describe("what the editor has no node for", () => {
  const cases: [string, string][] = [
    ["a table", "| a | b |\n|---|---|\n| 1 | 2 |"],
    ["raw HTML, shown as text by the renderer", "<b>bold</b> and <script>alert(1)</script>"],
    ["an image", "![a diagram](https://example.com/d.png)"],
    ["display math", "$$\nx^2\n$$"],
    ["inline math with underscores", "Where $a_b_c$ holds."],
    ["a footnote", "Text[^1]\n\n[^1]: The note."],
    ["a reference link", "See [the doc][d].\n\n[d]: https://example.com/doc"],
    ["a link the renderer won't follow", "[click](javascript:alert(1))"],
    ["a fence holding a fence", "````md\n```\ninner\n```\n````"],
    ["a fence's info string beyond its language", "```ts title=\"a.ts\"\nx\n```"],
  ];
  for (const [what, md] of cases) {
    it(`keeps ${what} as written`, () => {
      const doc = fromMarkdown(`Before.\n\n${md}\n\nAfter.`);
      expect(kept(doc).join("\n\n")).toBe(md);
      const out = toMarkdown(doc);
      expect(out).toContain(md);
      expect(out).toBe(`Before.\n\n${md}\n\nAfter.`);
    });
  }

  it("keeps a definition with the reference that uses it, so the link still resolves", () => {
    const md = "See [the doc][d].\n\n[d]: https://example.com/doc";
    const out = normalized(md);
    expect(out).toBe(md);
    expect(sameMeaning(md, out)).toBe(true);
  });

  it("keeps a list holding something it can't edit whole, rather than lose the part", () => {
    const md = "- item\n- with a table:\n\n  | a |\n  |---|\n  | 1 |";
    expect(kept(fromMarkdown(md))).toEqual([md]);
  });
});

describe("lists in a row", () => {
  it("stay two lists: the second takes another marker", () => {
    for (const md of ["- a\n- b\n\n* c\n* d", "1. a\n2. b\n\n1) c\n2) d", "- a\n\n<!-- -->\n\n- b", "* one\n\n- [ ] two"]) {
      const out = normalized(md);
      expect(sameMeaning(md, out), `${md}\n→\n${out}`).toBe(true);
    }
  });

  it("next to a list kept as written", () => {
    const md = "- a\n\n* b\n* ![i](https://x.y/i.png)";
    const out = normalized(md);
    expect(sameMeaning(md, out), out).toBe(true);
  });
});

describe("editing", () => {
  let editor: Editor | null = null;
  afterEach(() => editor?.destroy());
  const open = (md: string) => (editor = new Editor({ extensions: EDITOR_EXTENSIONS, content: fromMarkdown(md) }));

  it("changes only what was edited: an untouched block, kept or not, is saved meaning the same", () => {
    const md = `${AGENT}\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
    const e = open(md);
    e.chain().insertContentAt(e.state.doc.content.size, { type: "paragraph", content: [{ type: "text", text: "A new line." }] }).run();
    const out = toMarkdown(e.getJSON());
    expect(sameMeaning(`${md}\n\nA new line.`, out), out).toBe(true);
  });

  it("writes what the toolbar makes as Markdown", () => {
    const e = open("");
    e.chain().focus().setHeading({ level: 2 }).insertContent("Plan").run();
    e.chain().focus("end").insertContent({ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] }] }).run();
    e.chain().focus("end").insertContent({ type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "npm test" }] }).run();
    expect(toMarkdown(e.getJSON())).toBe("## Plan\n\n- [x] done\n\n```sh\nnpm test\n```");
  });

  it("a kept block can be deleted, and then it's gone", () => {
    const e = open("Keep.\n\n| a |\n|---|\n| 1 |");
    let pos = -1;
    e.state.doc.descendants((n, p) => {
      if (n.type.name === "markdownBlock") pos = p;
    });
    e.chain().setNodeSelection(pos).deleteSelection().run();
    expect(toMarkdown(e.getJSON())).toBe("Keep.");
  });
});

describe("a paste", () => {
  let editor: Editor | null = null;
  afterEach(() => editor?.destroy());

  it("keeps only the editor's nodes: no script, no image, no unsafe link, a table as its text", () => {
    editor = new Editor({ extensions: EDITOR_EXTENSIONS, content: fromMarkdown("") });
    editor.view.pasteHTML(
      `<h1 style="color:red">Title</h1><p onclick="x()">Text <script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">bad</a> <a href="https://ok.example">ok</a></p>` +
        `<table><tr><td>cell</td></tr></table><ul><li><p>item</p></li></ul><pre><code>code</code></pre>`,
    );
    const out = toMarkdown(editor.getJSON());
    expect(out).not.toMatch(/script|alert|onerror|onclick|style|<img|javascript:/i);
    expect(out).toContain("# Title");
    expect(out).toContain("[ok](https://ok.example)");
    expect(out).toContain("bad");
    expect(out).toContain("cell");
    expect(out).toMatch(/^- item$/m);
    expect(out).toContain("```\ncode\n```");
  });
});

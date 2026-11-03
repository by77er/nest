// A description's round trip through the editor (README.md#descriptions): what an agent writes comes
// into the editor and back out meaning the same to the renderer; what the editor has no node for is kept
// as written, never dropped; an edit changes only what was edited; a paste keeps only the editor's nodes.

import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { editorExtensions, fromMarkdown, normalized, sameMeaning, toMarkdown } from "./editor-markdown";

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
/** The renderer's block types for some Markdown. */
const tree = (md: string) => (fromMarkdown(md).content ?? []).map((n) => n.type);

/** A document as the editor holds it after a round trip: adjacent text with the same marks joined, marks in order. */
function norm(n: JSONContent): JSONContent {
  // An attribute at its default (null) is no attribute.
  if (n.attrs) n = { ...n, attrs: Object.fromEntries(Object.entries(n.attrs).filter(([, v]) => v !== null)) };
  if (n.marks) n = { ...n, marks: n.marks.map((m) => (m.attrs ? { ...m, attrs: Object.fromEntries(Object.entries(m.attrs).filter(([, v]) => v !== null)) } : m)) };
  if (!n.content) return n;
  const out: JSONContent[] = [];
  for (const c of n.content.map(norm)) {
    const last = out.at(-1);
    const key = (t: JSONContent) => JSON.stringify((t.marks ?? []).map((m) => [m.type, m.attrs ?? null]).sort());
    if (c.type === "text" && last?.type === "text" && key(c) === key(last)) out[out.length - 1] = { ...last, text: `${last.text}${c.text}` };
    else out.push(c.type === "text" && c.marks ? { ...c, marks: [...c.marks].sort((a, b) => a.type.localeCompare(b.type)) } : c);
  }
  return { ...n, content: out };
}

/** A seeded PRNG (mulberry32), so a failing document can be found again. */
function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random document the editor can hold: paragraphs of words and Markdown's own characters (block markers
 * at a line's start, `*`, `_`, `` ` ``, `[`, `<`, `&`, `|`, `\\`), marks on words,
 * hard breaks, headings, bullet, ordered and task lists nested, quotes, rules and code blocks (fences in
 * them). Not what Markdown has no way to write: empty paragraphs, spaces at a line's ends, a hard break
 * at a paragraph's ends, a code block's final newline, two lists in a row inside one item or quote; nor
 * a bare URL or address that isn't a link (GFM, the chat, links them; so does the editor as it's typed).
 */
function randomDoc(r: () => number): JSONContent {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const WORDS = ["alpha", "beta", "x", "42", "snake_case", "2*3", "a_b_c", "[x]", "<b>", "&amp;", "a|b", "\\", "`tick`", "~~no~~", "1.", "2)", "-", "+", "*", "#", "##", "---", "===", ">", ":--", "|", "!", "#tag", "end #"];
  const MARKS = [[], [], [], [{ type: "bold" }], [{ type: "italic" }], [{ type: "strike" }], [{ type: "code" }], [{ type: "bold" }, { type: "italic" }], [{ type: "link", attrs: { href: "https://example.com/l", title: null } }]] as const;
  const line = (): JSONContent[] => {
    const n = 1 + Math.floor(r() * 5);
    const out: JSONContent[] = [];
    for (let k = 0; k < n; k++) {
      const marks = pick(MARKS);
      const word = marks.length ? pick(["alpha", "beta", "x42", "word"]) : pick(WORDS);
      if (k > 0) out.push({ type: "text", text: " " });
      out.push({ type: "text", text: word, ...(marks.length ? { marks: [...marks] } : {}) });
    }
    return out;
  };
  const inlines = (): JSONContent[] => {
    const out = line();
    if (r() < 0.2) out.push({ type: "hardBreak" }, ...line());
    return out;
  };
  const paragraph = (): JSONContent => ({ type: "paragraph", content: inlines() });
  const list = (depth: number): JSONContent => {
    const kind = pick(["bulletList", "orderedList", "taskList"] as const);
    const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const content: JSONContent[] = [paragraph()];
      if (depth < 2 && r() < 0.3) content.push(list(depth + 1));
      return kind === "taskList" ? { type: "taskItem", attrs: { checked: r() < 0.5 }, content } : { type: "listItem", content };
    });
    return kind === "orderedList" ? { type: kind, attrs: { start: pick([1, 3]) }, content: items } : { type: kind, content: items };
  };
  const code = (): JSONContent => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(["const a = 1;", "```", "  indented", "~~~", "`x`", "- not a list", "#!/bin/sh"]));
    return { type: "codeBlock", attrs: { language: pick([null, "ts", "sh"]) }, content: [{ type: "text", text: lines.join("\n") }] };
  };
  const blockOf = (): JSONContent => {
    const k = r();
    if (k < 0.4) return paragraph();
    if (k < 0.55) return { type: "heading", attrs: { level: pick([1, 2, 3]) }, content: line() };
    if (k < 0.75) return list(0);
    if (k < 0.85) return code();
    if (k < 0.93) return { type: "blockquote", content: [paragraph(), ...(r() < 0.3 ? [paragraph()] : [])] };
    return { type: "horizontalRule" };
  };
  return { type: "doc", content: Array.from({ length: 1 + Math.floor(r() * 5) }, blockOf) };
}

const kept = (doc: JSONContent) => (doc.content ?? []).filter((n) => n.type === "markdownBlock").map((n) => (n.content ?? []).map((t) => t.text).join(""));

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

describe("what the editor shows is what's saved", () => {
  let editor: Editor | null = null;
  afterEach(() => editor?.destroy());
  const open = (doc: JSONContent = fromMarkdown("")) => (editor = new Editor({ extensions: editorExtensions(), content: doc }));
  const para = (...texts: string[]): JSONContent => ({ type: "doc", content: texts.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });
  /** Typed into the editor a character at a time, as a keyboard does: its input rules run. */
  const type = (e: Editor, text: string) => {
    for (const ch of text) {
      const { from, to } = e.state.selection;
      const handled = e.view.someProp("handleTextInput", (f) => f(e.view, from, to, ch, () => e.state.tr.insertText(ch, from, to)));
      if (!handled) e.view.dispatch(e.state.tr.insertText(ch, from, to));
    }
  };

  it("a paragraph that starts like a list, a heading or a rule is saved as that paragraph", () => {
    for (const text of ["1. not typed as list", "3) not either", "- a", "+ b", "* c", "# not a heading", "---", "===", "> quoted?"]) {
      const out = toMarkdown(para(text));
      expect(tree(out), `${text} → ${out}`).toEqual(["paragraph"]);
      expect(norm(fromMarkdown(out)), out).toEqual(para(text));
    }
  });

  it("two paragraphs `- a` and `- b` stay two paragraphs, not two lists", () => {
    const out = toMarkdown(para("- a", "- b"));
    expect(out).toBe("\\- a\n\n\\- b");
    expect(norm(fromMarkdown(out))).toEqual(para("- a", "- b"));
  });

  it("`2 * 3 * 4` typed stays text; `*x*` and `**x**` typed become italic and bold", () => {
    const e = open();
    e.commands.focus("end");
    type(e, "2 * 3 * 4 and *x* and **y** ");
    const marks = (e.getJSON().content![0]!.content ?? []).map((t: JSONContent) => [t.text, (t.marks ?? []).map((m) => m.type).join()]);
    expect(marks).toEqual([["2 * 3 * 4 and ", ""], ["x", "italic"], [" and ", ""], ["y", "bold"], [" ", ""]]);
    const out = toMarkdown(e.getJSON());
    expect(fromMarkdown(out)).toEqual(fromMarkdown("2 \\* 3 \\* 4 and *x* and **y**"));
  });

  it("plain text pasted is read as Markdown, as an agent's is: it shows as it's saved", () => {
    const e = open();
    e.commands.focus("end");
    // jsdom has no DataTransfer: the clipboard as ProseMirror reads it.
    const text = "Line one\n\nLine *two* with `code`\n- a\n- b\n\n1. not typed as list";
    const data = { getData: (type: string) => (type === "text/plain" ? text : "") };
    e.view.someProp("handlePaste", (f) => f(e.view, Object.assign(new Event("paste"), { clipboardData: data }) as ClipboardEvent, null as never));
    // (Less the empty line the editor keeps after a list at the end, for the cursor: Markdown has no empty paragraph.)
    const shown = { ...e.getJSON(), content: e.getJSON().content!.filter((n) => n.type !== "paragraph" || n.content?.length) };
    expect(kinds(shown)).toEqual(["paragraph", "paragraph", "bulletList", "orderedList"]);
    expect(norm(fromMarkdown(toMarkdown(e.getJSON())))).toEqual(norm(shown));
  });

  it("a pasted web table keeps its cells apart, as a Markdown table kept as written", () => {
    const e = open();
    e.view.pasteHTML("<p>Before</p><table><tr><th>env</th><th>p95</th></tr><tr><td>staging</td><td>840 | ms</td></tr></table>");
    const doc = e.getJSON();
    expect(kept(doc)).toEqual(["| env | p95 |\n| --- | --- |\n| staging | 840 \\| ms |"]);
    expect(doc.content!.find((n) => n.type === "markdownBlock")!.attrs!.kind).toBe("a table");
  });

  it("Word's list paragraphs come in as a list", () => {
    const e = open();
    e.view.pasteHTML(`<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><span>·<span>&nbsp;&nbsp;</span></span>Bullet from Word</p><p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><span>·<span>&nbsp;</span></span>Another</p>`);
    expect(toMarkdown(e.getJSON())).toBe("- Bullet from Word\n- Another");
  });

  it("property: any document the editor can hold is saved as Markdown that reads back as the same document", () => {
    const rand = seeded(20261103);
    for (let i = 0; i < 400; i++) {
      const doc = randomDoc(rand);
      const out = toMarkdown(doc);
      expect(norm(fromMarkdown(out)), `#${i}:\n${out}`).toEqual(norm(doc));
    }
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
  const open = (md: string) => (editor = new Editor({ extensions: editorExtensions(), content: fromMarkdown(md) }));

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
    editor = new Editor({ extensions: editorExtensions(), content: fromMarkdown("") });
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

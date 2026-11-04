// A task's description in the editor (README.md#descriptions): Markdown on the wire and in storage, a
// Tiptap document while it's edited. The way in and the way out, pure, so they're tested without a page.
//
// No block is changed silently. Each top-level block is read from the renderer's own tree (the remark
// plugins the chat renders with) into Tiptap's nodes, and goes into the editor only if, written back out
// by Tiptap, it means the same to the renderer: the same Markdown tree. Any other block (a table, raw
// HTML, an image, math, a footnote, a reference link) is kept as written, in a `markdownBlock` node: its
// Markdown source, edited as text, written back unchanged.
//
// And what the editor shows is what's saved: text typed or pasted literally is escaped where Markdown
// would read it as something else (a paragraph starting `1. ` or `- `, a `#`, a `---` line), `*` and `_`
// become bold or italic as you type only as CommonMark would read them, and a plain-text paste is read as
// Markdown, the same way an agent's description is.

import { type AnyExtension, Extension, type JSONContent, markInputRule, Node } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Italic from "@tiptap/extension-italic";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { MarkdownManager } from "@tiptap/markdown";
import { Fragment, Slice } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { LINK } from "./links";

/**
 * A block the editor has no node for, kept as written: its Markdown source as text, edited in place like
 * code, written back unchanged. `kind` says what it is ("a table"), for its caption.
 */
export const MarkdownBlock = Node.create({
  name: "markdownBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return { kind: { default: "Markdown" } };
  },
  parseHTML() {
    return [{ tag: "div[data-markdown-block]", contentElement: "pre", preserveWhitespace: "full", getAttrs: (el) => ({ kind: (el as HTMLElement).getAttribute("data-kind") ?? "Markdown" }) }];
  },
  renderHTML({ node }) {
    const kind = String(node.attrs.kind);
    return [
      "div",
      { "data-markdown-block": "", "data-kind": kind, role: "group", "aria-label": `Markdown the editor can't show (${kind})` },
      ["div", { "data-markdown-block-label": "", contenteditable: "false" }, `The editor can't show this (${kind}); edit its Markdown here`],
      ["pre", {}, 0],
    ];
  },
  renderMarkdown: (node: JSONContent) => (node.content ?? []).map((t) => t.text ?? "").join(""),
});

/** The links a description may hold, as the chat renders them: http:, https:, mailto: (README.md#rich-messages). */
export const allowedLink = (url: string) => LINK.test(url.trim());

/**
 * The editor's nodes and marks, the same for the editor and for reading and writing Markdown: paragraphs,
 * headings, bold, italic, strikethrough, inline code, links, bullet, ordered and task lists, code blocks,
 * quotes, rules and line breaks. No underline: Markdown has none.
 */
/**
 * Bold and italic as you type, only where CommonMark would read the delimiters so: `*x*` and `**x**`
 * (and `_`), never around a space (so `2 * 3 * 4` stays text). No paste rules: a paste's marks come from
 * its HTML, or its Markdown when it's plain text.
 */
const STRICT = {
  italicStar: /(?:^|\s)(\*(?!\s)([^*]*?[^*\s])\*)$/,
  italicUnderscore: /(?:^|\s)(_(?!\s)([^_]*?[^_\s])_)$/,
  boldStar: /(?:^|\s)(\*\*(?!\s)([^*]*?[^*\s])\*\*)$/,
  boldUnderscore: /(?:^|\s)(__(?!\s)([^_]*?[^_\s])__)$/,
};
const StrictBold = Bold.extend({
  addInputRules() {
    return [markInputRule({ find: STRICT.boldStar, type: this.type }), markInputRule({ find: STRICT.boldUnderscore, type: this.type })];
  },
  addPasteRules() {
    return [];
  },
});
const StrictItalic = Italic.extend({
  addInputRules() {
    return [markInputRule({ find: STRICT.italicStar, type: this.type }), markInputRule({ find: STRICT.italicUnderscore, type: this.type })];
  },
  addPasteRules() {
    return [];
  },
});

export const EDITOR_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({
    underline: false,
    bold: false,
    italic: false,
    link: {
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: ["http", "https", "mailto"],
      isAllowedUri: (url) => allowedLink(url),
      HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
    },
  }),
  StrictBold,
  StrictItalic,
  TaskList,
  TaskItem.configure({ nested: true }),
  MarkdownBlock,
];

/** The extensions the editor runs with: the document's, and how a paste comes in (`pasteAsMarkdown`). */
export const editorExtensions = (): AnyExtension[] => [...EDITOR_EXTENSIONS, MarkdownPaste];

const manager = new MarkdownManager({ extensions: EDITOR_EXTENSIONS, indentation: { style: "space", size: 2 } });
const remark = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

type Mdast = { type: string; children?: Mdast[]; position?: { start: { offset?: number }; end: { offset?: number } }; [k: string]: unknown };

/** The renderer's tree of some Markdown. */
const tree = (md: string) => remark.runSync(remark.parse(md)) as unknown as Mdast;

/**
 * What a tree means to the renderer, without how it was written: no positions, no list looseness
 * (`spread`, which only spaces items), adjacent text joined, and no empty text.
 */
function meaning(n: Mdast): unknown {
  const { position: _p, spread: _s, children, ...rest } = n;
  if (!children) return rest;
  const kids: Mdast[] = [];
  for (const c of children) {
    const last = kids.at(-1);
    if (c.type === "text" && last?.type === "text") kids[kids.length - 1] = { ...last, value: String(last.value) + String(c.value) };
    else if (!(c.type === "text" && c.value === "")) kids.push(c);
  }
  return { ...rest, children: kids.map(meaning) };
}

/** Whether two pieces of Markdown render the same (README.md#descriptions). */
export function sameMeaning(a: string, b: string): boolean {
  return JSON.stringify(meaning(tree(a))) === JSON.stringify(meaning(tree(b)));
}

type Mark = { type: string; attrs?: Record<string, unknown> };
const MARKS: Record<string, (n: Mdast) => Mark> = {
  emphasis: () => ({ type: "italic" }),
  strong: () => ({ type: "bold" }),
  delete: () => ({ type: "strike" }),
  link: (n) => ({ type: "link", attrs: { href: String(n.url), title: (n.title as string | null) ?? null } }),
};

/** An inline run as Tiptap's: text with its marks, and hard breaks. Null for anything else (an image, math, HTML, a reference). */
function inline(nodes: Mdast[], marks: Mark[]): JSONContent[] | null {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    if (n.type === "text" || n.type === "inlineCode") {
      const m = n.type === "inlineCode" ? [...marks, { type: "code" }] : marks;
      if (String(n.value) !== "") out.push({ type: "text", text: String(n.value), ...(m.length ? { marks: m } : {}) });
    } else if (n.type === "break") {
      out.push({ type: "hardBreak" });
    } else if (MARKS[n.type]) {
      if (n.type === "link" && !allowedLink(String(n.url))) return null;
      const kids = inline(n.children ?? [], [...marks, MARKS[n.type]!(n)]);
      if (!kids) return null;
      out.push(...kids);
    } else {
      return null;
    }
  }
  return out;
}

/** A list item's content as Tiptap's: a paragraph first, then blocks. */
function item(n: Mdast, task: boolean): JSONContent | null {
  const kids = n.children ?? [];
  const content = kids.length === 0 ? [{ type: "paragraph" }] : blocks(kids);
  if (!content || content[0]?.type !== "paragraph") return null;
  return task ? { type: "taskItem", attrs: { checked: n.checked === true }, content } : { type: "listItem", content };
}

/** Blocks as Tiptap's nodes, or null when any is one the editor has no node for. */
function blocks(nodes: Mdast[]): JSONContent[] | null {
  const out: JSONContent[] = [];
  for (const n of nodes) {
    const one = block(n);
    if (!one) return null;
    out.push(one);
  }
  return out;
}

function block(n: Mdast): JSONContent | null {
  const kids = n.children ?? [];
  switch (n.type) {
    case "paragraph": {
      const c = inline(kids, []);
      return c ? { type: "paragraph", ...(c.length ? { content: c } : {}) } : null;
    }
    case "heading": {
      const c = inline(kids, []);
      return c ? { type: "heading", attrs: { level: n.depth }, ...(c.length ? { content: c } : {}) } : null;
    }
    case "code":
      // A fence's info string beyond its language has nowhere to go.
      if (n.meta) return null;
      return { type: "codeBlock", attrs: { language: (n.lang as string | null) ?? null }, ...(n.value ? { content: [{ type: "text", text: String(n.value) }] } : {}) };
    case "blockquote": {
      const c = blocks(kids);
      return c && c.length ? { type: "blockquote", content: c } : null;
    }
    case "thematicBreak":
      return { type: "horizontalRule" };
    case "list": {
      // A task list is every item a checkbox: GFM may mix them, the editor can't.
      const checks = kids.map((k) => k.checked !== null && k.checked !== undefined);
      const task = checks.every(Boolean);
      if (!task && checks.some(Boolean)) return null;
      if (task && n.ordered) return null;
      const items = kids.map((k) => item(k, task));
      if (items.some((i) => i === null)) return null;
      const content = items as JSONContent[];
      if (task) return { type: "taskList", content };
      return n.ordered ? { type: "orderedList", attrs: { start: (n.start as number | null) ?? 1 }, content } : { type: "bulletList", content };
    }
    default:
      return null;
  }
}

/**
 * Tiptap's nodes for one top-level block, or null when it doesn't come back meaning the same: read from
 * the renderer's own tree, so the editor sees what the chat would show, then checked by writing it back.
 * A block that means something else on its own (a reference to a definition elsewhere) is kept too.
 */
function editable(source: string, node: Mdast): JSONContent[] | null {
  if (JSON.stringify(meaning({ type: "root", children: [node] })) !== JSON.stringify(meaning(tree(source)))) return null;
  const one = block(node);
  if (!one) return null;
  return sameMeaning(source, toMarkdown({ type: "doc", content: [one] })) ? [one] : null;
}

/** What a kept block holds that the editor can't show, for its caption: its first such node. */
const KINDS: Record<string, string> = {
  table: "a table", html: "HTML", image: "an image", imageReference: "an image", math: "math", inlineMath: "math",
  footnoteReference: "a footnote", footnoteDefinition: "a footnote", linkReference: "a reference link", definition: "a link's definition",
  link: "a link the chat won't follow", code: "a code fence",
};
function keptKind(n: Mdast): string {
  const walk = (m: Mdast): string | null => {
    if (m.type === "link") return allowedLink(String(m.url)) ? null : KINDS.link!;
    if (m.type === "code") return m.meta ? KINDS.code! : null;
    if (KINDS[m.type]) return KINDS[m.type]!;
    for (const c of m.children ?? []) {
      const k = walk(c);
      if (k) return k;
    }
    return null;
  };
  return walk(n) ?? (n.type === "list" ? "a mixed task list" : "Markdown");
}

const kept = (source: string, kind: string): JSONContent => ({ type: "markdownBlock", attrs: { kind }, content: [{ type: "text", text: source }] });

/** A description's Markdown as the editor's document: each block Tiptap's own where it can be, else kept as written. */
export function fromMarkdown(md: string): JSONContent {
  const content: JSONContent[] = [];
  for (const block of tree(md).children ?? []) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const source = md.slice(start, end);
    content.push(...(editable(source, block) ?? [kept(source, keptKind(block))]));
  }
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

type Marker = "-" | "*" | "+" | "." | ")";

/** The marker a list block's first item starts with, if it's a list. */
function markerOf(md: string): Marker | null {
  const m = /^(?:([-*+])|\d{1,9}([.)]))[ \t]/.exec(md);
  return m ? ((m[1] ?? m[2]) as Marker) : null;
}

/** Its top-level items' markers changed to `to` (an item's own lines are indented, so only those at the margin). */
function remark_(md: string, to: Marker): string {
  return to === "." || to === ")" ? md.replace(/^(\d{1,9})[.)](?=[ \t])/gm, `$1${to}`) : md.replace(/^[-*+](?=[ \t])/gm, to);
}

/** A backslash to come: Tiptap escapes a backslash in text, so the escapes below go in as this and are swapped after. */
const ESC = "\uE000";

/**
 * Where a line of literal text starts with what Markdown would read as a block (a list item `- ` or
 * `1. `, a heading `#`, a rule or setext underline `---`/`===`, a table's delimiter row), an escape
 * before it. Tiptap escapes the rest itself (`*`, `_`, `` ` ``, `[`, `\\`, `~`, `<`, `>`, `&`), so
 * `* ` is already `\\* `.
 */
function escapeLine(line: string, multiline: boolean): string {
  return line
    .replace(/^(\s{0,3})([-+])(?=\s|$)/, `$1${ESC}$2`)
    .replace(/^(\s{0,3}\d{1,9})([.)])(?=\s|$)/, `$1${ESC}$2`)
    .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, `$1${ESC}$2`)
    .replace(/^(\s{0,3})(-)(?=[-\s]*$)/, `$1${ESC}$2`)
    .replace(/^(\s{0,3})(=)(?==*\s*$)/, `$1${ESC}$2`)
    .replace(multiline ? /^(\s{0,3})([|:-])(?=[\s|:-]*-[\s|:-]*$)/ : /^$/, (m, a, b) => (b === undefined ? m : `${a}${ESC}${b}`));
}

/** The document with its literal text escaped where it starts a line, and each code block's fence long enough for its code. */
function escaped(n: JSONContent): JSONContent {
  if (n.type === "codeBlock") {
    const code = (n.content ?? []).map((t) => t.text ?? "").join("");
    const run = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(Math.max(3, run + 1));
    return { type: "markdownBlock", content: [{ type: "text", text: `${fence}${n.attrs?.language ?? ""}\n${code}${code.endsWith("\n") || code === "" ? "" : "\n"}${fence}` }] };
  }
  if (n.type === "paragraph" || n.type === "heading") {
    // Adjacent text with the same marks is one run (as ProseMirror keeps it), so a line is seen whole.
    const inl: JSONContent[] = [];
    for (const t of n.content ?? []) {
      const last = inl.at(-1);
      if (t.type === "text" && last?.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(t.marks ?? [])) inl[inl.length - 1] = { ...last, text: `${last.text}${t.text}` };
      else inl.push(t);
    }
    const multiline = inl.some((t) => t.type === "hardBreak" || (t.text ?? "").includes("\n"));
    let atStart = true;
    const content = inl.map((t, idx) => {
      if (t.type === "hardBreak") {
        atStart = true;
        return t;
      }
      if (t.type !== "text") {
        atStart = false;
        return t;
      }
      let text = t.text ?? "";
      if (!t.marks?.length && n.type === "paragraph") {
        text = text.split("\n").map((line, k) => (k > 0 || atStart ? escapeLine(line, multiline) : line)).join("\n");
      }
      // A heading's trailing `#`s would be read as its closing sequence.
      if (n.type === "heading" && idx === inl.length - 1 && !t.marks?.length) text = text.replace(/(#+\s*)$/, `${ESC}$1`);
      atStart = false;
      return { ...t, text };
    });
    return { ...n, content };
  }
  if (!n.content) return n;
  // An ordered list not starting at 1 can't interrupt a paragraph: a blank line before it (an empty kept
  // block, which writes nothing but its line) keeps it a list.
  const content: JSONContent[] = [];
  n.content.forEach((c, k) => {
    const prev = n.content![k - 1];
    if (c.type === "orderedList" && (c.attrs?.start ?? 1) !== 1 && prev?.type === "paragraph") content.push({ type: "markdownBlock", content: [] });
    content.push(escaped(c));
  });
  return { ...n, content };
}

/** One block as Markdown: Tiptap's, from the escaped document; a kept block as written. */
function serialize(n: JSONContent): string {
  if (n.type === "markdownBlock") return (n.content ?? []).map((t) => t.text ?? "").join("");
  return manager.serialize({ type: "doc", content: [escaped(n)] }).replaceAll(ESC, "\\");
}

/**
 * The editor's document as Markdown: each block as Tiptap writes it, a kept block as it was written, a
 * blank line between. Two lists in a row with the same marker would read as one list, so the second
 * takes another (`-`, `*`, `+`; `.`, `)`).
 */
export function toMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? []).map((n) => ({ kept: n.type === "markdownBlock", md: serialize(n).replace(/\s+$/, "") }));
  const out: string[] = [];
  blocks.forEach((b, i) => {
    let md = b.md;
    const mine = markerOf(md);
    if (!b.kept && mine) {
      const before = out.length ? markerOf(out.at(-1)!) : null;
      const next = blocks[i + 1];
      const after = next?.kept ? markerOf(next.md) : null;
      const family: Marker[] = mine === "." || mine === ")" ? [".", ")"] : ["-", "*", "+"];
      if (mine === before || mine === after) {
        const pick = family.find((m) => m !== before && m !== after);
        if (pick) md = remark_(md, pick);
      }
    }
    if (md !== "") out.push(md);
  });
  return out.join("\n\n");
}

// --- a paste ------------------------------------------------------------------------------------------

/** A pasted table's cells as a Markdown table, kept as written (the editor has no table): its cells stay apart. */
function tableMarkdown(table: HTMLTableElement): string {
  const rows = [...table.rows].map((r) => [...r.cells].map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? "").join(" | ")} |`;
  return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
}

/**
 * Pasted HTML, readied for the editor's schema: each table a kept block of its Markdown table (else its
 * cells would run together), and Word's list paragraphs (a `·` or a number, then the text) a real list.
 */
export function readyPastedHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const t of [...doc.querySelectorAll("table")]) {
    const div = doc.createElement("div");
    div.setAttribute("data-markdown-block", "");
    div.setAttribute("data-kind", KINDS.table!);
    const pre = doc.createElement("pre");
    pre.textContent = tableMarkdown(t as HTMLTableElement);
    div.appendChild(pre);
    t.replaceWith(div);
  }
  let list: HTMLElement | null = null;
  for (const p of [...doc.querySelectorAll("p")]) {
    const isItem = /mso-list/i.test(p.getAttribute("style") ?? "") || /^MsoListParagraph/.test(p.className);
    const m = isItem ? /^\s*(?:([·•o§▪-])|(\d+[.)]))[\s\u00a0]+/.exec(p.textContent ?? "") : null;
    if (!m) {
      list = null;
      continue;
    }
    const tag = m[2] ? "OL" : "UL";
    if (!list || list.tagName !== tag || list.nextElementSibling !== p) {
      list = doc.createElement(tag.toLowerCase());
      p.parentNode?.insertBefore(list, p);
    }
    const li = doc.createElement("li");
    li.textContent = (p.textContent ?? "").slice(m[0].length);
    list.appendChild(li);
    p.remove();
  }
  return doc.body.innerHTML;
}

/**
 * How a paste comes in: HTML readied for the schema (`readyPastedHtml`), the schema then keeping only its
 * nodes; plain text read as Markdown, as an agent's description is, so it shows as it will be saved.
 */
export const MarkdownPaste = Extension.create({
  name: "markdownPaste",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformPastedHTML: readyPastedHtml,
          handlePaste: (view, event) => {
            const data = event.clipboardData;
            const text = data?.getData("text/plain") ?? "";
            if (!data || data.getData("text/html") || !text) return false;
            if (view.state.selection.$from.parent.type.spec.code) return false;
            const fragment = Fragment.fromJSON(view.state.schema, fromMarkdown(text).content ?? []);
            view.dispatch(view.state.tr.replaceSelection(Slice.maxOpen(fragment)).scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

/** What the editor would save for a description no one has touched: the baseline a change is measured from. */
export const normalized = (md: string) => toMarkdown(fromMarkdown(md));

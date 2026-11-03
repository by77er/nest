// A task's description in the editor (README.md#descriptions): Markdown on the wire and in storage, a
// Tiptap document while it's edited. The way in and the way out, pure, so they're tested without a page.
//
// No block is changed silently. Each top-level block is read from the renderer's own tree (the remark
// plugins the chat renders with) into Tiptap's nodes, and goes into the editor only if, written back out
// by Tiptap, it means the same to the renderer: the same Markdown tree. Any other block (a table, raw HTML, an image, math, a
// footnote, a reference link) is kept as written, in a `markdownBlock` node that the editor shows as its
// source and writes back unchanged.

import { type AnyExtension, type JSONContent, Node } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { LINK } from "./links";

/** A block the editor has no node for, kept as written: shown as its source, written back unchanged. */
export const MarkdownBlock = Node.create({
  name: "markdownBlock",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { source: { default: "" } };
  },
  parseHTML() {
    return [{ tag: "div[data-markdown-block]", getAttrs: (el) => ({ source: (el as HTMLElement).querySelector("pre")?.textContent ?? "" }) }];
  },
  renderHTML({ node }) {
    return [
      "div",
      { "data-markdown-block": "", role: "group", "aria-label": "Kept as written: the editor has no block for this Markdown" },
      ["div", { "data-markdown-block-label": "" }, "Kept as written"],
      ["pre", {}, String(node.attrs.source)],
    ];
  },
  renderMarkdown: (node: JSONContent) => String(node.attrs?.source ?? ""),
});

/** The links a description may hold, as the chat renders them: http:, https:, mailto: (README.md#rich-messages). */
export const allowedLink = (url: string) => LINK.test(url.trim());

/**
 * The editor's nodes and marks, the same for the editor and for reading and writing Markdown: paragraphs,
 * headings, bold, italic, strikethrough, inline code, links, bullet, ordered and task lists, code blocks,
 * quotes, rules and line breaks. No underline: Markdown has none.
 */
export const EDITOR_EXTENSIONS: AnyExtension[] = [
  StarterKit.configure({
    underline: false,
    link: {
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: ["http", "https", "mailto"],
      isAllowedUri: (url) => allowedLink(url),
      HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
    },
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  MarkdownBlock,
];

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

/** A description's Markdown as the editor's document: each block Tiptap's own where it can be, else kept as written. */
export function fromMarkdown(md: string): JSONContent {
  const content: JSONContent[] = [];
  for (const block of tree(md).children ?? []) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const source = md.slice(start, end);
    content.push(...(editable(source, block) ?? [{ type: "markdownBlock", attrs: { source } }]));
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

/**
 * The editor's document as Markdown: each block as Tiptap writes it, a kept block as it was written, a
 * blank line between. Two lists in a row with the same marker would read as one list, so the second
 * takes another (`-`, `*`, `+`; `.`, `)`).
 */
export function toMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? []).map((n) => ({ kept: n.type === "markdownBlock", md: (n.type === "markdownBlock" ? String(n.attrs?.source ?? "") : manager.serialize({ type: "doc", content: [n] })).replace(/\s+$/, "") }));
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

/** What the editor would save for a description no one has touched: the baseline a change is measured from. */
export const normalized = (md: string) => toMarkdown(fromMarkdown(md));

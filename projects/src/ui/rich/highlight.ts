// Syntax highlighting for a message's code blocks: a rehype step that gives a fence whose language it
// knows highlight.js's token classes (`hljs-keyword`, `hljs-string`, …), which Rich.module.css colours
// from the theme's roles. A short list of languages, registered by hand (lowlight's `common` would ship
// thirty-odd grammars), with the aliases their grammars carry (`ts`, `sh`, `toml`, `console`…); a fence
// in any other language, or with none, stays plain text, as does one over `HIGHLIGHT_MAX` (the grammars
// run on the main thread over untrusted text). Nothing is guessed. The tokens are hast nodes, so React
// renders them like any other element (no innerHTML).
//
// Every fence, highlighted or not, is then split into lines (`span[data-line]`, each ending in its
// newline, a token spanning lines cut into one per line), so a long one can show its first lines and
// the rest on asking.

import type { Element, ElementContent, Root, RootContent } from "hast";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

// `shell` is a session (a `$ ` prompt and its output: `console`, `shell`); `bash` a script (`sh`, `zsh`).
const lowlight = createLowlight({ bash, css, diff, dockerfile, go, ini, javascript, json, python, rust, shell, sql, typescript, xml, yaml });

/** The most code one fence highlights (characters); a longer one stays plain. */
export const HIGHLIGHT_MAX = 20_000;

/** The fence's language, from react-markdown's `language-<name>` class on its <code>. */
const languageOf = (code: Element): string | null => {
  const cls: unknown = code.properties?.className;
  const list = Array.isArray(cls) ? cls : typeof cls === "string" ? cls.split(" ") : [];
  for (const c of list) if (typeof c === "string" && c.startsWith("language-")) return c.slice("language-".length);
  return null;
};

const textOf = (n: ElementContent): string => (n.type === "text" ? n.value : n.type === "element" ? n.children.map(textOf).join("") : "");

/** `nodes` as lines: text split at its newlines, an element cut into a copy per line it spans. */
function linesOf(nodes: ElementContent[]): ElementContent[][] {
  const out: ElementContent[][] = [[]];
  for (const n of nodes) {
    const parts: ElementContent[][] =
      n.type === "text" ? n.value.split("\n").map((v) => (v ? [{ type: "text", value: v }] : [])) : n.type === "element" ? linesOf(n.children).map((l) => (l.length ? [{ ...n, children: l }] : [])) : [[n]];
    parts.forEach((p, i) => {
      if (i > 0) out.push([]);
      out[out.length - 1]!.push(...p);
    });
  }
  return out;
}

/** A fence's content as one `span[data-line]` per line, each ending in its newline (as the fence's text does). */
function splitLines(code: Element) {
  const lines = linesOf(code.children);
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop();
  code.children = lines.map((l): Element => ({ type: "element", tagName: "span", properties: { dataLine: "" }, children: [...l, { type: "text", value: "\n" }] }));
}

function visit(node: Root | Element) {
  for (const child of node.children as RootContent[]) {
    if (child.type !== "element") continue;
    const code = child.tagName === "pre" ? child.children.find((c): c is Element => c.type === "element" && c.tagName === "code") : undefined;
    if (!code) {
      visit(child);
      continue;
    }
    const lang = languageOf(code);
    const source = code.children.map(textOf).join("");
    if (lang && lowlight.registered(lang) && source.length <= HIGHLIGHT_MAX) {
      const tree = lowlight.highlight(lang, source);
      code.children = tree.children as ElementContent[];
      code.properties = { ...code.properties, dataHighlighted: "" };
    }
    splitLines(code);
  }
}

/** The rehype step: highlights every fence in a language it knows, in place. */
export function rehypeHighlightCode() {
  return (tree: Root) => visit(tree);
}

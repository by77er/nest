// An assistant's text in a trace, as Markdown, the way Claude Code prints it in a terminal
// (README.md#the-live-trace): mono at one size, headings and bold by weight, code verbatim, lists with hanging
// indents, tables as mono grids. Only the assistant's text: prompts, tool calls, results and errors stay
// raw text.
//
// The chat's safe path, with the terminal's own component map: react-markdown with GFM, raw HTML turned
// into literal text first (remarkEscapeHtml) and no rehype-raw; links only http, https and mailto, opening
// in a new tab; no image is loaded (its alt text instead), no SVG figure and no math. Half-written
// Markdown (a fence or `**` still open, mid-stream) parses as what it is so far: its text is all shown.

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { TermProse } from "../../layout";
import { LINK } from "../../rich/links";
import { remarkEscapeHtml } from "../../rich/tasks";

/** react-markdown's `urlTransform`: a followable link, else "" (its text shown, not a link). No image source at all. */
const urlTransform = (url: string, key: string) => (key === "href" && LINK.test(url.trim()) ? url.trim() : "");

const heading: Components["h1"] = ({ children }) => <p data-md="heading">{children}</p>;

const COMPONENTS: Components = {
  // Headings are bold lines, not the page's headings: a trace's text never enters the page's outline.
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  a: ({ href, children }) =>
    href ? (
      // In a sentence: the inline exception on touch (data-inline), on its 24 px line (Terminal.module.css).
      <a href={href} target="_blank" rel="noopener noreferrer" data-inline>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // No image is loaded from a trace (no tracking pixel): its alt text, marked as an image.
  img: ({ alt }) => <span data-md="image">[image{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div data-md="table">
      <table>{children}</table>
    </div>
  ),
  input: ({ type, checked }) => (type === "checkbox" ? <span data-md="check">{checked ? "[x]" : "[ ]"}</span> : null),
};

/** An assistant's text, parsed again only when it changes (a live line's neighbours re-render often). */
export const TraceMarkdown = memo(function TraceMarkdown({ text }: { text: string }) {
  return (
    <TermProse>
      <ReactMarkdown remarkPlugins={[remarkEscapeHtml, remarkGfm]} urlTransform={urlTransform} skipHtml={false} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </TermProse>
  );
});

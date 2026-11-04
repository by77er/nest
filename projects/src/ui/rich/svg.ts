// SVG in the manager's messages (README.md#rich-messages), defense in depth:
// 1. found before Markdown parsing (a fenced ```svg block, or an inline <svg>…</svg>), since Markdown
//    passes no raw HTML;
// 2. sanitized with DOMPurify's SVG profile, then stricter rules of our own: no foreignObject or
//    script, no on* attribute, no href or xlink:href but a fragment (#id), no <use> of anything outside
//    the document, no <style> that imports or fetches; and checked again after;
// 3. shown only as an <img> from a data: URL (svgDataUrl), never inline in the DOM: an SVG loaded as an
//    image runs no script and loads nothing, so even a sanitizer bug can't execute.

import createDOMPurify from "dompurify";

/** The largest SVG shown; a larger one is refused with a notice. */
export const SVG_MAX_BYTES = 200 * 1024;

export type Segment = { kind: "markdown"; text: string } | { kind: "svg"; source: string } | { kind: "tasks"; lines: string[] };

/**
 * The message split into Markdown, SVG and `tasks` blocks, in order. Fenced code of other languages stays Markdown
 * untouched (an <svg> shown as code in a ```xml block is code, not a picture).
 */
export function splitSvg(text: string): Segment[] {
  const out: Segment[] = [];
  let md = "";
  const flush = () => {
    if (md) out.push({ kind: "markdown", text: md });
    md = "";
  };
  const fence = /^(```+|~~~+)[ \t]*([^\n`]*)\n([\s\S]*?)\n\1[ \t]*$/gm;
  let at = 0;
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    md += inlineSvg(text.slice(at, m.index), out, flush);
    const lang = m[2]!.trim().toLowerCase();
    if (lang === "svg") {
      flush();
      out.push({ kind: "svg", source: m[3]! });
    } else if (lang === "math") {
      // A ```math block is display math, as remark-math reads $$…$$.
      md += `$$\n${m[3]}\n$$`;
    } else if (lang === "tasks") {
      flush();
      out.push({ kind: "tasks", lines: m[3]!.split("\n").map((l) => l.trim()).filter(Boolean) });
    } else {
      md += m[0];
    }
    at = m.index + m[0].length;
  }
  md += inlineSvg(text.slice(at), out, flush);
  flush();
  return out;
}

/** Pull inline <svg>…</svg> out of a stretch of Markdown (outside fences); answer the Markdown left. */
function inlineSvg(text: string, out: Segment[], flush: () => void): string {
  const re = /<svg[\s>][\s\S]*?<\/svg\s*>/gi;
  let rest = "";
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    rest += text.slice(at, m.index);
    // Everything before it is Markdown in its own segment, so the order holds.
    if (rest) {
      out.push({ kind: "markdown", text: rest });
      rest = "";
    }
    flush();
    out.push({ kind: "svg", source: m[0] });
    at = m.index + m[0].length;
  }
  return rest + text.slice(at);
}

export type Sanitized = { ok: true; svg: string } | { ok: false; reason: string };

const FORBID_TAGS = ["foreignObject", "script", "iframe", "embed", "object", "image", "audio", "video", "animate", "set", "animateMotion", "animateTransform"];
const isLocal = (v: string) => v.trim().startsWith("#");
/** CSS that reaches outside the image: an import, or a url() that isn't a fragment. */
const fetchesInCss = (css: string) => /@import/i.test(css) || /url\(\s*['"]?(?!#)/i.test(css);

let purifier: ReturnType<typeof createDOMPurify> | null = null;

/** A DOMPurify of our own (its hooks don't touch anyone else's), with the stricter rules as hooks. */
function getPurifier() {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    if (name.startsWith("on")) data.keepAttr = false;
    if ((name === "href" || name === "xlink:href") && !isLocal(data.attrValue)) data.keepAttr = false;
    if (name === "style" && fetchesInCss(data.attrValue)) data.keepAttr = false;
  });
  p.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && fetchesInCss(node.textContent ?? "")) node.parentNode?.removeChild(node);
  });
  purifier = p;
  return p;
}

/** The SVG made safe to show as an image, or why it isn't shown. */
export function sanitizeSvg(source: string): Sanitized {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > SVG_MAX_BYTES) return { ok: false, reason: `This SVG is ${Math.round(bytes / 1024)} KB; the most shown is ${SVG_MAX_BYTES / 1024} KB.` };
  const clean = getPurifier().sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR: ["srcdoc"],
  }) as unknown as string;
  const svg = clean.trim();
  if (!/^<svg[\s>]/i.test(svg)) return { ok: false, reason: "This isn't an SVG image that can be shown." };
  const left = unsafeLeft(svg);
  if (left) return { ok: false, reason: `This SVG still had ${left} after cleaning, so it isn't shown.` };
  return { ok: true, svg: withNamespace(svg) };
}

/** What a sanitized SVG must not still have: checked on the parsed result, not trusted from the hooks. */
export function unsafeLeft(svg: string): string | null {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.localName.toLowerCase();
    if (tag === "script" || tag === "foreignobject") return `a <${el.localName}>`;
    if (tag === "style" && fetchesInCss(el.textContent ?? "")) return "a <style> that fetches";
    for (const a of el.attributes) {
      const n = a.name.toLowerCase();
      if (n.startsWith("on")) return `an ${a.name} handler`;
      if ((n === "href" || n.endsWith(":href")) && !isLocal(a.value)) return "a link outside the image";
    }
  }
  return null;
}

/** An image needs the SVG namespace to render; DOMPurify keeps it when given, adds nothing. */
function withNamespace(svg: string): string {
  return /^<svg[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
}

/** The sanitized SVG as a data: URL, for an <img>. */
export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

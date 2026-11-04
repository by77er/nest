// The trace's Markdown check (README.md "The live trace", in projects/): an assistant's Markdown on the
// terminal is mono at the terminal's one size throughout; only a fence (`pre`) or a table's frame
// (`[data-md=table]`) may be wider than the trace, and then it scrolls sideways inside itself; nothing
// else spills past the prose's line. Evaluated in the page (`page.evaluate(proseProblems)`).

export function proseProblems() {
  const out = [];
  for (const prose of document.querySelectorAll("[data-ds=terminal] [data-ds=term-prose]")) {
    const term = prose.closest("[data-ds=terminal]");
    const size = getComputedStyle(term).fontSize;
    const right = prose.getBoundingClientRect().right + 1;
    for (const el of prose.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      const tag = el.tagName.toLowerCase();
      if (!/JetBrains Mono/.test(cs.fontFamily)) out.push(`trace Markdown <${tag}> isn't mono (${cs.fontFamily})`);
      if (cs.fontSize !== size) out.push(`trace Markdown <${tag}> is ${cs.fontSize}, not the terminal's ${size}`);
      const frame = el.closest("pre, [data-md=table]");
      if (frame && frame !== el) continue;
      const box = el.getBoundingClientRect();
      // Past the prose's edge, or its own content wider than its box (a line that won't wrap).
      const spills = (box.width > 0 && box.right > right) || (!el.matches("pre, [data-md=table]") && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1);
      if (spills) out.push(`trace Markdown <${tag}> spills past the trace's line`);
      if (el.matches("pre, [data-md=table]") && el.scrollWidth > el.clientWidth + 1 && !/auto|scroll/.test(cs.overflowX)) out.push(`a wide trace ${tag === "pre" ? "fence" : "table"} doesn't scroll in itself`);
    }
  }
  return out;
}

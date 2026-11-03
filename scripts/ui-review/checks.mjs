// The automated checks that run inside the page (README.md#checks). `measure` is passed to
// page.evaluate, so it must not close over anything: everything it uses is defined inside it.
// It returns the problems it found, by check, and the frame's geometry for the cross-view check.

/**
 * @param {{
 *   frame: string, header: string, measure: string | null, containers: string[],
 *   nav: { rows: string, brand: string, active: string } | null, viewportOnly: boolean,
 *   content?: { root: string, minHeading: number, figures: string } | null,
 * }} sel
 */
export function measure(sel) {
  // `sel.touch`: a touch screen's width, where hit areas must not overlap (hit-overlap).
  const problems = { overflow: [], clipping: [], contrast: [], nav: [], measure: [], frame: [], content: [], "hit-overlap": [] };
  const doc = document.documentElement;
  const W = doc.clientWidth;
  const H = window.innerHeight;
  const short = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 50);
  const visible = (el) => {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const scrolls = (cs) => cs === "auto" || cs === "scroll";
  /** Inside a scroller of its own between el and stop (a table or board that scrolls sideways). */
  const inScroller = (el, stop) => {
    for (let e = el.parentElement; e && e !== stop; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (scrolls(cs.overflowX) || e.classList.contains("mantine-ScrollArea-viewport")) return true;
    }
    return false;
  };
  const isControl = (el) => el.matches("input, textarea, select, option");

  // --- overflow: no horizontal page scroll, nothing partly outside the viewport ---
  if (doc.scrollWidth > W + 1) problems.overflow.push(`the page scrolls sideways: ${doc.scrollWidth} > ${W} px`);
  // --- clipping: nothing past its container's edge, nothing cut off by its own overflow ---
  for (const el of document.body.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // Fully off screen is a closed drawer, not clipped content; partly off screen is clipped.
    const partlyOut = (r.left < -0.5 && r.right > 0) || (r.right > W + 0.5 && r.left < W);
    if (partlyOut && !inScroller(el, null)) problems.overflow.push(`<${el.tagName.toLowerCase()}> "${short(el.textContent)}" runs past the viewport (${Math.round(r.left)}..${Math.round(r.right)} of ${W})`);
    if (isControl(el) || !el.textContent?.trim()) continue;
    const cs = getComputedStyle(el);
    const cutsX = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis";
    const cutsY = cs.overflowY === "hidden" || cs.overflowY === "clip" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none");
    if (cutsX && el.scrollWidth > el.clientWidth + 1) problems.clipping.push(`"${short(el.textContent)}" is cut off sideways (${el.scrollWidth} > ${el.clientWidth} px)`);
    else if (cutsY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2) problems.clipping.push(`"${short(el.textContent)}" is cut off below (${el.scrollHeight} > ${el.clientHeight} px)`);
  }
  for (const card of document.querySelectorAll(sel.containers.join(", "))) {
    if (!visible(card)) continue;
    const box = card.getBoundingClientRect();
    const name = card.getAttribute("aria-label") ?? card.getAttribute("data-ds") ?? card.tagName.toLowerCase();
    for (const el of card.querySelectorAll("*")) {
      if (!visible(el) || inScroller(el, card)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > box.right + 0.5 || r.left < box.left - 0.5) problems.clipping.push(`${name}: "${short(el.textContent)}" runs past its edge`);
    }
  }

  // --- contrast: WCAG AA for every visible text, against what is painted behind it ---
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  /** Any CSS color, as [r, g, b, a] in sRGB 0..255 and alpha 0..1 (the canvas resolves the syntax). */
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bottom) => {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1);
  };
  const lum = (c) => {
    const [r, g, b] = c.slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (c) => "#" + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  /** The opaque color behind el: its and its ancestors' backgrounds, composited; null if an image is. */
  const ground = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      const c = rgba(cs.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    let out = [255, 255, 255, 1];
    for (const c of layers.reverse()) out = over(c, out);
    return out;
  };
  const opacity = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    if (!visible(el) || el.closest("script, style, noscript, :disabled, [aria-disabled=true], [data-disabled]")) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const inView = r.bottom > 0 && r.top < H && r.right > 0 && r.left < W;
    if (sel.viewportOnly && !inView) continue;
    if (inView) {
      // Under an overlay (a modal's backdrop, a drawer): not what the reader sees.
      const x = Math.min(Math.max(r.left + r.width / 2, 0), W - 1);
      const y = Math.min(Math.max(r.top + r.height / 2, 0), H - 1);
      const top = document.elementFromPoint(x, y);
      if (top && !el.contains(top) && !top.contains(el)) continue;
    }
    const cs = getComputedStyle(el);
    const bg = ground(el);
    if (!bg) continue;
    const fg0 = rgba(cs.color);
    // Transparent text isn't read: a character kept for copy whose look is drawn (the trace's ⎿ corner).
    if (fg0[3] === 0) continue;
    const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * opacity(el)], bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got < need) problems.contrast.push(`"${short(n.textContent)}" ${got.toFixed(2)}:1 < ${need} (${hex(fg)} on ${hex(bg)})`);
  }

  // --- the frame: one h1, its position, its header's width, the content's left edge ---
  const h1s = [...document.querySelectorAll("h1")].filter(visible);
  if (h1s.length !== 1) problems.frame.push(`${h1s.length} visible h1s, not one`);
  const frameEl = [...document.querySelectorAll(sel.frame)].find(visible);
  let frame = null;
  if (frameEl) {
    const fr = frameEl.getBoundingClientRect();
    const contentLeft = fr.left + parseFloat(getComputedStyle(frameEl).paddingLeft);
    const h1 = h1s[0];
    const header = h1?.closest(sel.header);
    frame = {
      contentLeft: Math.round(contentLeft * 10) / 10,
      h1Left: h1 ? Math.round(h1.getBoundingClientRect().left * 10) / 10 : null,
      headerWidth: header ? Math.round(header.getBoundingClientRect().width * 10) / 10 : null,
    };
    // --- measures: a capped column stays on the frame's left edge ---
    if (sel.measure) {
      for (const m of document.querySelectorAll(sel.measure)) {
        if (!visible(m)) continue;
        const left = m.getBoundingClientRect().left;
        if (Math.abs(left - contentLeft) > 1) problems.measure.push(`a ${m.getAttribute("data-measure") ?? "measured"} column starts ${Math.round(left - contentLeft)} px right of the frame's left edge`);
      }
    }
  } else {
    problems.frame.push(`no frame (${sel.frame}) on the page`);
  }

  // --- navigation: one left edge, the brand on it, a quiet active row ---
  if (sel.nav) {
    const inViewX = (e) => {
      const r = e.getBoundingClientRect();
      return r.right > 0 && r.left < W;
    };
    const rows = [...document.querySelectorAll(sel.nav.rows)].filter((e) => visible(e) && inViewX(e));
    if (rows.length) {
      const edge = (e, i) => (e.children[i] ?? e).getBoundingClientRect().left;
      const iconLefts = [...new Set(rows.map((e) => Math.round(edge(e, 0))))];
      const labelLefts = [...new Set(rows.map((e) => Math.round(edge(e, 1))))];
      if (iconLefts.length !== 1) problems.nav.push(`rows' icons on ${iconLefts.length} left edges (${iconLefts.join(", ")})`);
      if (labelLefts.length !== 1) problems.nav.push(`rows' labels on ${labelLefts.length} left edges (${labelLefts.join(", ")})`);
      const brand = [...document.querySelectorAll(sel.nav.brand)].find((e) => visible(e) && inViewX(e));
      if (brand && Math.abs(brand.getBoundingClientRect().left - iconLefts[0]) > 1) problems.nav.push(`the product's name is ${Math.round(brand.getBoundingClientRect().left - iconLefts[0])} px off the rows' edge`);
      // A role color is chromatic; the neutrals (page, surface, subtle, border, text, muted) are not.
      const chroma = (c) => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
      for (const a of rows.filter((e) => e.matches(sel.nav.active))) {
        const cs = getComputedStyle(a);
        for (const [what, css] of [["ground", cs.backgroundColor], ["rule", cs.borderLeftColor], ["text", cs.color]]) {
          const c = rgba(css);
          if (c[3] > 0.1 && chroma(c) > 0.12) problems.nav.push(`the active row's ${what} is a role color (${hex(c)})`);
        }
      }
    }
  }

  // --- hit-overlap (touch widths): no control's hit area takes a tap meant for a neighbouring one ---
  if (sel.touch) {
    const CONTROL = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
    // Behind an open modal (a drawer, a dialog) nothing takes taps: only the topmost one's controls count.
    const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter(visible);
    const layer = modals.at(-1) ?? document.body;
    const controls = [...layer.querySelectorAll(CONTROL)].filter((el) =>
      visible(el) && !el.closest('[aria-hidden="true"], [inert]') && el.getAttribute("tabindex") !== "-1" && !el.matches(":disabled"));
    const controlAt = (x, y) => document.elementFromPoint(x, y)?.closest(CONTROL) ?? null;
    const label = (el) => `<${el.tagName.toLowerCase()}> "${short(el.getAttribute("aria-label") ?? el.textContent)}"`;
    /** A control's hit box: its own box, grown by any absolutely positioned ::before or ::after. */
    const hitBox = (el) => {
      const r = el.getBoundingClientRect();
      const box = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      for (const pe of ["::before", "::after"]) {
        const cs = getComputedStyle(el, pe);
        if (cs.content === "none" || cs.content === "normal" || cs.position !== "absolute") continue;
        const [top, left, w, h] = [cs.top, cs.left, cs.width, cs.height].map(parseFloat);
        if (![top, left, w, h].every(Number.isFinite)) continue;
        box.l = Math.min(box.l, r.left + left);
        box.t = Math.min(box.t, r.top + top);
        box.r = Math.max(box.r, r.left + left + w);
        box.b = Math.max(box.b, r.top + top + h);
      }
      return box;
    };
    const boxes = controls.map(hitBox);
    for (let i = 0; i < controls.length; i++) {
      const a = controls[i];
      const ha = boxes[i];
      // Only a hit area past the control's own box can reach a neighbour unseen (an open list or drawer
      // over the page is the page's layout, and other checks' business).
      const own = a.getBoundingClientRect();
      if (ha.l >= own.left - 0.5 && ha.t >= own.top - 0.5 && ha.r <= own.right + 0.5 && ha.b <= own.bottom + 0.5) continue;
      const inOwn = (x, y) => x >= own.left && x <= own.right && y >= own.top && y <= own.bottom;
      for (const b of controls) {
        if (a === b || a.contains(b) || b.contains(a)) continue;
        const rb = b.getBoundingClientRect();
        const l = Math.max(ha.l, rb.left), t = Math.max(ha.t, rb.top), r = Math.min(ha.r, rb.right), btm = Math.min(ha.b, rb.bottom);
        if (r - l < 1 || btm - t < 1) continue;

        // Taps across where a's hit area meets b's box: one landing on a was meant for b.
        let found = null;
        for (const fx of [0.2, 0.5, 0.8]) {
          for (const fy of [0.2, 0.5, 0.8]) {
            const x = l + (r - l) * fx, y = t + (btm - t) * fy;
            if (x < 0 || y < 0 || x >= W || y >= H || inOwn(x, y)) continue;
            if (controlAt(x, y) === a) found ??= [Math.round(x), Math.round(y)];
          }
        }
        if (found) problems["hit-overlap"].push(`a tap on ${label(b)} at ${found[0]},${found[1]} lands on ${label(a)}`);
      }
    }
  }

  // --- user content (Markdown, SVG) can't change the page's outline, hierarchy or ground ---
  if (sel.content) {
    for (const root of document.querySelectorAll(sel.content.root)) {
      if (!visible(root)) continue;
      const body = parseFloat(getComputedStyle(root).fontSize);
      for (const h of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
        if (!visible(h)) continue;
        const level = Number(h.tagName[1]);
        if (level < sel.content.minHeading) problems.content.push(`a heading in user content is an h${level}, above the h${sel.content.minHeading} it's demoted to: "${short(h.textContent)}"`);
        const size = parseFloat(getComputedStyle(h).fontSize);
        if (size < body - 0.5) problems.content.push(`a heading in user content is smaller than its text (${size} < ${body} px): "${short(h.textContent)}"`);
      }
    }
    for (const fig of document.querySelectorAll(sel.content.figures)) {
      if (!visible(fig)) continue;
      const bg = ground(fig);
      if (bg && lum(bg) < 0.85) problems.content.push(`a figure sits on a dark ground (${hex(bg)}), not a fixed light canvas`);
      for (let e = fig.querySelector("img, svg") ?? fig; e; e = e.parentElement) {
        if (/invert/.test(getComputedStyle(e).filter)) {
          problems.content.push("a figure is inverted (filter: invert)");
          break;
        }
      }
    }
  }

  for (const k of Object.keys(problems)) problems[k] = [...new Set(problems[k])];
  return { problems, frame };
}

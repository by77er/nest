// KaTeX's own CSS and fonts, from the package (no CDN): the math in a manager's message (RichMessage).
// Imported by RichMessage itself, not through the layout index, so the stylesheet is in the chunk that
// renders math: Vite loads a chunk's CSS before it runs the chunk, so math never shows unstyled, and pages
// without messages don't load it.
import "katex/dist/katex.min.css";

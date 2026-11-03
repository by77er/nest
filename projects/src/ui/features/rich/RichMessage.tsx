// A manager's message, rendered (README.md#rich-messages): Markdown with GFM (tables, task lists),
// LaTeX math (KaTeX, untrusted), SVG figures (sanitized, shown only as images) and task references
// resolved live from the board. Raw HTML in the text is never rendered: remarkEscapeHtml turns it into
// literal text first, and no rehype-raw is in the pipeline.

import { Anchor } from "@mantine/core";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { RichImage, RichProse, RichTableFrame, Stack } from "../../layout";
import { INLINE_IMAGE, LINK, urlTransform } from "../../rich/links";
import { splitSvg } from "../../rich/svg";
import { remarkEscapeHtml, remarkTaskRefs, TASK_HREF } from "../../rich/tasks";
import { SvgBlock } from "./SvgBlock";
import { TaskBlock, TaskChip } from "./TaskRefs";

/**
 * KaTeX, untrusted: no \href, \url, \includegraphics or \htmlClass/\htmlId (trust: false); a bad
 * formula shows as its source in the error shade; sizes and macro expansion capped.
 */
export const KATEX_OPTIONS = {
  trust: false,
  strict: "warn",
  throwOnError: false,
  errorColor: "var(--mantine-color-danger-text)",
  maxSize: 20,
  maxExpand: 500,
  output: "htmlAndMathml",
} as const;

function components(projectId: string): Components {
  return {
    a: ({ href, children }) => {
      const task = href ? TASK_HREF.exec(href) : null;
      if (task) return <TaskChip projectId={projectId} id={task[1]!} fallback={children} />;
      if (!href || !LINK.test(href)) return <span>{children}</span>;
      return (
        <Anchor href={href} target="_blank" rel="noopener noreferrer" inherit>
          {children}
        </Anchor>
      );
    },
    img: ({ src, alt }) => {
      const s = typeof src === "string" ? src : "";
      if (INLINE_IMAGE.test(s)) return <RichImage src={s} alt={alt ?? ""} />;
      // No remote image (no tracking pixel): a link labelled with its alt text instead.
      if (LINK.test(s)) {
        return (
          <Anchor href={s} target="_blank" rel="noopener noreferrer" inherit data-image-link>
            {alt || s}
          </Anchor>
        );
      }
      return <span>{alt}</span>;
    },
    table: ({ children }) => (
      <RichTableFrame>
        <table>{children}</table>
      </RichTableFrame>
    ),
    input: ({ type, checked }) => (type === "checkbox" ? <input type="checkbox" checked={!!checked} disabled readOnly aria-label={checked ? "done" : "not done"} /> : null),
  };
}

export function Markdown({ text, projectId }: { text: string; projectId: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkEscapeHtml, remarkGfm, remarkMath, remarkTaskRefs]}
      rehypePlugins={[[rehypeKatex, KATEX_OPTIONS]]}
      urlTransform={urlTransform}
      skipHtml={false}
      components={components(projectId)}
    >
      {text}
    </ReactMarkdown>
  );
}

export function RichMessage({ text, projectId }: { text: string; projectId: string }) {
  const segments = splitSvg(text);
  return (
    <RichProse>
      {segments.map((s, i) =>
        s.kind === "svg" ? (
          <SvgBlock key={i} source={s.source} />
        ) : s.kind === "tasks" ? (
          <TaskBlock key={i} projectId={projectId} lines={s.lines} />
        ) : (
          <Stack key={i} gap="sm">
            <Markdown text={s.text} projectId={projectId} />
          </Stack>
        ),
      )}
    </RichProse>
  );
}


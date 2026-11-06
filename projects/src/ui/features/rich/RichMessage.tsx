// A manager's message, rendered (README.md#rich-messages): Markdown with GFM (tables, task lists),
// LaTeX math (KaTeX, untrusted), SVG figures (sanitized, shown only as images) and task references
// resolved live from the board, code blocks highlighted (a short list of languages) with their language
// and a copy button. Raw HTML in the text is never rendered: remarkEscapeHtml turns it into
// literal text first, and no rehype-raw is in the pipeline.

import { Anchor, Button, CopyButton } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronUp, IconCopy, IconPhoto } from "@tabler/icons-react";
import { Children, cloneElement, isValidElement, memo, type ReactElement, type ReactNode, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CodeFrame, icon, RichImage, RichProse, RichTableFrame, Stack, TaskCheck } from "../../layout";
import { rehypeHighlightCode } from "../../rich/highlight";
import { INLINE_IMAGE, LINK, urlTransform } from "../../rich/links";
import { splitSvg } from "../../rich/svg";
import { remarkDemoteHeadings, remarkEscapeHtml, remarkTaskRefs, TASK_HREF } from "../../rich/tasks";
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

/** The text of rendered children (a highlighted fence is spans of tokens): what Copy copies. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** A fence longer than this many lines shows its first `CODE_SHOWN` until asked for the rest. */
export const CODE_MAX_LINES = 25;
export const CODE_SHOWN = 20;

/**
 * A code block: its language and Copy (all of it) above; past `CODE_MAX_LINES`, its first lines and
 * "Show all N lines" under them, opening in place. Its lines are the rehype step's `span[data-line]`s.
 */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [all, setAll] = useState(false);
  const code = isValidElement(children) ? (children as ReactElement<{ className?: string; children?: ReactNode }>) : null;
  const lang = /language-([\w+-]+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  const source = textOf(code?.props.children).replace(/\n$/, "");
  const lines = Children.toArray(code?.props.children);
  const long = !!code && lines.length > CODE_MAX_LINES;
  return (
    <CodeFrame
      lang={lang}
      copy={
        <CopyButton value={source}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={copy} leftSection={copied ? <IconCheck size={icon.sm} /> : <IconCopy size={icon.sm} />}>
              {copied ? "Copied" : "Copy"}
            </Button>
          )}
        </CopyButton>
      }
      footer={
        long && (
          <Button size="compact-sm" variant="subtle" color="gray" onClick={() => setAll(!all)} leftSection={all ? <IconChevronUp size={icon.sm} /> : <IconChevronDown size={icon.sm} />} aria-expanded={all}>
            {all ? "Show fewer lines" : `Show all ${lines.length} lines`}
          </Button>
        )
      }
    >
      <pre data-lines={lines.length}>{long && !all ? cloneElement(code!, {}, lines.slice(0, CODE_SHOWN)) : children}</pre>
    </CodeFrame>
  );
}

function components(projectId: string): Components {
  return {
    a: ({ href, children }) => {
      const task = href ? TASK_HREF.exec(href) : null;
      if (task) return <TaskChip projectId={projectId} id={task[1]!} fallback={children} />;
      if (!href || !LINK.test(href)) return <span>{children}</span>;
      return (
        <Anchor href={href} target="_blank" rel="noopener noreferrer" inherit data-inline>
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
          <Anchor href={s} target="_blank" rel="noopener noreferrer" inherit data-image-link data-inline>
            <IconPhoto size={icon.sm} aria-hidden /> {alt || s}
          </Anchor>
        );
      }
      return <span>{alt}</span>;
    },
    // A code block: its language and a copy button above it (math and SVG never reach here).
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    table: ({ children }) => (
      <RichTableFrame>
        <table>{children}</table>
      </RichTableFrame>
    ),
    input: ({ type, checked }) => (type === "checkbox" ? <TaskCheck checked={!!checked} /> : null),
  };
}

// One set of overrides per project, built once: they are component types to React, so a new set on every
// render would remount every chip, card and figure (losing focus, a click in flight, an open modal).
const byProject = new Map<string, Components>();
const componentsFor = (projectId: string) => {
  let c = byProject.get(projectId);
  if (!c) byProject.set(projectId, (c = components(projectId)));
  return c;
};

/** The Markdown of a message, parsed again only when its text changes. */
export const Markdown = memo(function Markdown({ text, projectId }: { text: string; projectId: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkEscapeHtml, remarkGfm, remarkMath, remarkTaskRefs, remarkDemoteHeadings]}
      rehypePlugins={[[rehypeKatex, KATEX_OPTIONS], rehypeHighlightCode]}
      urlTransform={urlTransform}
      skipHtml={false}
      components={componentsFor(projectId)}
    >
      {text}
    </ReactMarkdown>
  );
});

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


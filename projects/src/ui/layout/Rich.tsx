// The pieces a rich message is drawn with (README.md#rich-messages): its Markdown's frame, a table's
// scroll frame, an inline raster image, an SVG figure (always an <img>: never inline SVG in the DOM),
// and a task's chip and card. Styles in Rich.module.css, from the skill's tokens.

import { Button, Code, Modal, Stack } from "@mantine/core";
import { IconSquare, IconSquareCheck } from "@tabler/icons-react";
import { icon } from "../theme";
import { useDisclosure } from "@mantine/hooks";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import classes from "./Rich.module.css";

/** A rendered message: body-lg, the skill's spacing between its blocks. */
export function RichProse({ children }: { children: ReactNode }) {
  return (
    <div className={classes.prose} data-ds="rich">
      {children}
    </div>
  );
}

export function RichTableFrame({ children }: { children: ReactNode }) {
  return (
    <div className={classes.tableFrame} data-ds="rich-table">
      {children}
    </div>
  );
}

/** A data: raster image, within the size cap. */
export function RichImage({ src, alt }: { src: string; alt: string }) {
  return <img className={classes.image} src={src} alt={alt} loading="lazy" decoding="async" />;
}

/**
 * An SVG, as an image from its data: URL: a click (or Enter) opens it larger in a modal, still an image,
 * and "View source" shows the sanitized SVG as code.
 */
export function SvgFigure({ url, source, label }: { url: string; source: string; label: string }) {
  const [opened, modal] = useDisclosure(false);
  const [showSource, source_] = useDisclosure(false);
  return (
    <Stack gap="xs" align="flex-start" data-ds="svg-figure">
      <button type="button" className={classes.figure} onClick={modal.open} data-ds="figure-canvas" aria-label={`${label}: open larger`}>
        <img className={classes.image} src={url} alt={label} />
      </button>
      <Button variant="subtle" color="gray" size="compact-xs" onClick={source_.toggle} aria-expanded={showSource}>
        {showSource ? "Hide source" : "View source"}
      </Button>
      {showSource && (
        <Code block fz="xs" data-ds="svg-source">
          {source}
        </Code>
      )}
      <Modal opened={opened} onClose={modal.close} title={label} size="min(94vw, 68rem)" centered>
        <div className={classes.canvas} data-ds="figure-canvas">
          <img className={classes.large} src={url} alt={label} />
        </div>
      </Modal>
    </Stack>
  );
}

/** A task, inline: the router makes it a link (common/links). */
export const TaskChipAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function TaskChipAnchor({ className: _c, ...rest }, ref) {
  // In a sentence: the inline exception keeps its line on touch (data-inline).
  return <a ref={ref} className={classes.chip} data-ds="task-chip" data-inline {...rest} />;
});

/** A card's title, a link covering the whole card. */
/** A task chip while the board loads: the chip's box, the reference's text muted, room for the badge. */
export function TaskChipPending({ children }: { children: ReactNode }) {
  return (
    <span className={classes.chip} data-ds="task-chip" data-pending aria-busy>
      <span className={classes.chipPendingText}>{children}</span>
      <span className={classes.chipPendingBadge} aria-hidden />
    </span>
  );
}

export const TaskCardTitleAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function TaskCardTitleAnchor({ className: _c, ...rest }, ref) {
  // The whole card's link (its ::after covers the card): never a positioned box of its own.
  return <a ref={ref} className={classes.cardTitle} data-ds="card-title" {...rest} />;
});

export function TaskCards({ children }: { children: ReactNode }) {
  return (
    <div className={classes.cards} data-ds="task-cards">
      {children}
    </div>
  );
}

/** A task's compact card in a message: a hairline, the surface, no second Panel. */
export function TaskRefCard({ children, ...data }: { children: ReactNode; [k: `data-${string}`]: string | undefined }) {
  return (
    <article className={classes.card} data-ds="task-card" {...data}>
      <div className={classes.cardBody}>{children}</div>
    </article>
  );
}

/** A task list's box, read-only: a check-square when done, an empty square when not. */
export function TaskCheck({ checked }: { checked: boolean }) {
  return (
    <span className={classes.check} role="checkbox" aria-checked={checked} aria-disabled aria-label={checked ? "done" : "not done"} data-task-check>
      {checked ? <IconSquareCheck size={icon.md} aria-hidden /> : <IconSquare size={icon.md} aria-hidden />}
    </span>
  );
}

/** A chat message's bubble: `end` the owner's, `start` the manager's, `note` the app's. */
export function Bubble({ side, children, ...data }: { side: "start" | "end" | "note"; children: ReactNode; [k: `data-${string}`]: string | undefined }) {
  return (
    <div className={classes.bubble} data-side={side} data-ds="bubble" {...data}>
      {children}
    </div>
  );
}

/**
 * A chat's column: its messages, then the end sentinel, then the composer, `xl` apart. While `following`
 * (the reader is at the end), nothing in it but the sentinel can anchor the scroll, so content growing
 * above keeps the end in place; otherwise the browser's own anchoring holds the reader's line.
 */
export function ChatColumn({ following, children }: { following: boolean; children: ReactNode }) {
  return (
    <div className={classes.chatColumn} data-following={following || undefined} data-ds="chat-column">
      {children}
    </div>
  );
}

/**
 * The end of a scrolling log: scrolled into view with room for what docks over the bottom (`footer`,
 * its height in px, measured by the caller), so the newest message is never under the composer.
 */
export const ScrollSentinel = forwardRef<HTMLDivElement, { footer: number }>(function ScrollSentinel({ footer }, ref) {
  return <div ref={ref} className={classes.sentinel} style={{ ["--nest-chat-footer" as string]: `${footer}px` }} data-ds="scroll-sentinel" />;
});

/** A pill floating just above a docked footer, centred: "New message", while reading back. */
export function FooterPill({ children }: { children: ReactNode }) {
  return (
    <div className={classes.footerPill} data-ds="footer-pill">
      {children}
    </div>
  );
}

// The manager chat's pieces (layout only; the feature gives the data): its log, which scrolls in itself
// and never the page; day separators; author groups; the owner's quiet bubble and the manager's
// unboxed prose; a message's revealed meta row; the jump pill; the turn in progress; the docked
// composer; an arriving message's 4 px fade-and-slide (180 ms, never on load, never under reduced motion);
// and a code block's header.

import { forwardRef, type ReactNode } from "react";
import classes from "./ChatLog.module.css";

/**
 * The conversation, scrolling in itself. `following`: the reader is at the end, and the chat keeps it
 * there; otherwise the browser's scroll anchoring holds the reader's line.
 */
export const ChatLog = forwardRef<HTMLDivElement, { children: ReactNode; onScroll?: () => void; label: string; following: boolean }>(function ChatLog({ children, onScroll, label, following }, ref) {
  return (
    <div ref={ref} className={classes.log} onScroll={onScroll} role="log" aria-label={label} tabIndex={0} data-following={following || undefined} data-ds="chat-log">
      {/* The content in a box of its own, so its growth (math, a figure decoding) can be observed. */}
      <div className={classes.logContent} data-slot="log-content">
        {children}
      </div>
    </div>
  );
});

export function ChatFrame({ children }: { children: ReactNode }) {
  return <div className={classes.frame}>{children}</div>;
}

export function DaySeparator({ label }: { label: string }) {
  return (
    <div className={classes.day} role="separator" aria-label={label} data-ds="day">
      {label}
    </div>
  );
}

export function MessageGroup({ side, name, children }: { side: "owner" | "manager" | "note"; name?: ReactNode; children: ReactNode }) {
  return (
    <div className={classes.group} data-side={side} data-ds="message-group">
      {name && <div className={classes.name}>{name}</div>}
      {children}
    </div>
  );
}

/** One message: its body, then its meta (time and actions) revealed on hover or focus. */
export function MessageRow({ side, children, meta, appear = false, pinned = false, ...data }: { side: "owner" | "manager" | "note"; children: ReactNode; meta?: ReactNode; appear?: boolean; pinned?: boolean; [k: `data-${string}`]: string | undefined }) {
  const cls = [classes.row, appear ? classes.appear : ""].join(" ");
  if (side === "note") {
    return (
      <div className={`${classes.note} ${appear ? classes.appear : ""}`} data-ds="message" {...data}>
        {children}
      </div>
    );
  }
  return (
    <div className={cls} data-ds="message" {...data}>
      {side === "owner" ? <div className={classes.bubble}>{children}</div> : children}
      {meta && (
        <div className={classes.meta} data-pinned={pinned || undefined} data-slot="meta">
          {meta}
        </div>
      )}
    </div>
  );
}

export function JumpPill({ children }: { children: ReactNode }) {
  return <div className={classes.jump}>{children}</div>;
}

/** The turn's text so far ends in a static cursor (no blink). */
export function StreamText({ children }: { children: ReactNode }) {
  return (
    <div className={classes.cursor} data-ds="stream">
      {children}
    </div>
  );
}

/** What the turn is doing now, in the trace's terminal style: "● Reading src/worker.ts". */
export function ActivityLine({ children }: { children: ReactNode }) {
  return (
    <div className={classes.activity} data-ds="activity" aria-hidden>
      <span className={classes.dot}>●</span>
      <span>{children}</span>
    </div>
  );
}

export function ComposerDock({ children }: { children: ReactNode }) {
  return (
    <div className={classes.dock} data-ds="composer-dock">
      {children}
    </div>
  );
}

export function CodeFrame({ lang, copy, children }: { lang: string; copy: ReactNode; children: ReactNode }) {
  return (
    <div className={classes.code} data-ds="code-block">
      <div className={classes.codeHead}>
        <span>{lang || "text"}</span>
        {copy}
      </div>
      {children}
    </div>
  );
}

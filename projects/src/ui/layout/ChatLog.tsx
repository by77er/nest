// The manager chat's pieces (layout only; the feature gives the data): its log, which scrolls in itself
// and never the page; day separators; author groups; the owner's quiet bubble and the manager's
// unboxed prose; a message's revealed meta row; the jump pill; the turn in progress; the docked
// composer; an arriving message's 4 px fade-and-slide (180 ms, never on load, never under reduced motion);
// and a code block's header.

import { useMediaQuery } from "@mantine/hooks";
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import classes from "./ChatLog.module.css";

/**
 * The conversation. The page never scrolls; one thing does, and the ref is it (its scroll, its content):
 * - from `sm` up, the log itself, filling down to the viewport's bottom above the composer;
 * - on a phone, the page's column (`[data-ds=page]`, the viewport less the top bar), with the header
 *   and its context scrolling away above the log and the composer pinned at the bottom.
 * `following`: the reader is at the end, and the chat keeps it there; otherwise the browser's scroll
 * anchoring holds the reader's line.
 */
export const ChatLog = forwardRef<HTMLDivElement, { children: ReactNode; onScroll?: () => void; label: string; following: boolean }>(function ChatLog({ children, onScroll, label, following }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery("(max-width: 48em)") ?? false;
  // The scroller, resolved when the ref is set (before the feature's effects run, which read it).
  const scrollerOf = () => {
    const d = el.current;
    return d && phone ? (d.closest<HTMLDivElement>("[data-ds=page]") ?? d) : d;
  };
  useImperativeHandle(ref, () => scrollerOf() as HTMLDivElement, [phone]);
  useEffect(() => {
    const scroller = scrollerOf();
    if (!scroller || !onScroll) return;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [phone, onScroll]);
  // From `sm` up: as tall as fits, so the page itself never scrolls (at least 12rem): the viewport less
  // everything else on the page (measured to the page's bottom, never by resetting the log, which would
  // lose its scroll). Following, it stays at the end as it's resized.
  const followingRef = useRef(following);
  followingRef.current = following;
  useLayoutEffect(() => {
    const d = el.current;
    if (!d || phone) {
      if (d) d.style.maxHeight = "";
      return;
    }
    const fit = () => {
      const page = d.closest("[data-ds=page]");
      if (!page) return;
      const others = page.getBoundingClientRect().bottom + window.scrollY - d.getBoundingClientRect().height;
      const max = `${Math.max(192, Math.floor(window.innerHeight - others))}px`;
      if (d.style.maxHeight !== max) {
        d.style.maxHeight = max;
        if (followingRef.current) d.scrollTop = d.scrollHeight;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [phone]);
  return (
    <div ref={el} className={classes.log} role="log" aria-label={label} tabIndex={0} data-following={following || undefined} data-ds="chat-log">
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

/** Floats just above the composer, centred ("Jump to latest · n new"): ComposerDock's `pill`. */
function JumpPill({ children }: { children: ReactNode }) {
  return (
    <div className={classes.jump} data-ds="jump-pill">
      {children}
    </div>
  );
}

/** The turn's text so far; its last character is a static cursor (no blink), set inline by the feature. */
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

/** The composer under the log (pinned at the viewport's bottom on a phone), its pill floating above it. */
export function ComposerDock({ children, pill }: { children: ReactNode; pill?: ReactNode }) {
  return (
    <div className={classes.dock} data-ds="composer-dock">
      {pill && <JumpPill>{pill}</JumpPill>}
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

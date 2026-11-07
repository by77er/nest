// The manager chat's pieces (layout only; the feature gives the data): its log, which scrolls in itself
// and never the page; day separators; author groups; the owner's quiet bubble and the manager's
// unboxed prose; a message's revealed meta row; the jump pill; the turn in progress (its steps as
// compact rows that open, and a working line); the docked composer in its rounded box; the empty chat's
// starters; an arriving message's 4 px fade-and-slide (180 ms, never on load, never under reduced motion);
// and a code block's header.

import { Collapse, Loader, UnstyledButton } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCheck, IconChevronRight, IconPlayerStopFilled, IconX } from "@tabler/icons-react";
import { forwardRef, type ReactNode, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { icon, motion } from "../theme";
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
  // From `sm` up: exactly as tall as fits (at least 12rem), so the page itself never scrolls and the
  // composer sits at the viewport's bottom even when the chat is short: the viewport less everything
  // else on the page (measured to the page's bottom, never by resetting the log, which would lose its
  // scroll). Following, it stays at the end as it's resized.
  const followingRef = useRef(following);
  followingRef.current = following;
  // On a phone: at least as tall as the page's column leaves it (its min-height), so a short chat still
  // has the composer flush at the bottom; a long one flows in the column, which scrolls.
  useLayoutEffect(() => {
    const d = el.current;
    if (!d || !phone) {
      if (d) d.style.minHeight = "";
      return;
    }
    const page = d.closest<HTMLElement>("[data-ds=page]");
    const content = page?.firstElementChild;
    if (!page || !content) return;
    const fit = () => {
      const others = content.getBoundingClientRect().height - d.getBoundingClientRect().height;
      const pad = (parseFloat(getComputedStyle(page).paddingTop) || 0) + (parseFloat(getComputedStyle(page).paddingBottom) || 0);
      const min = `${Math.max(0, Math.floor(page.clientHeight - pad - others))}px`;
      if (d.style.minHeight !== min) d.style.minHeight = min;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(content);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, [phone]);
  useLayoutEffect(() => {
    const d = el.current;
    if (!d || phone) {
      if (d) d.style.height = "";
      return;
    }
    const fit = () => {
      const page = d.closest("[data-ds=page]");
      if (!page) return;
      const others = page.getBoundingClientRect().bottom + window.scrollY - d.getBoundingClientRect().height;
      const max = `${Math.max(192, Math.floor(window.innerHeight - others))}px`;
      if (d.style.height !== max) {
        d.style.height = max;
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

export function MessageGroup({ side, name, avatar, children }: { side: "owner" | "manager" | "note"; name?: ReactNode; avatar?: ReactNode; children: ReactNode }) {
  return (
    <div className={classes.group} data-side={side} data-ds="message-group">
      {name && (
        <div className={classes.name}>
          {avatar && (
            <span className={classes.avatar} aria-hidden>
              {avatar}
            </span>
          )}
          {name}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * One message: its body, then its meta (time and actions) revealed on hover or focus. `quiet`: not read
 * out as it changes (a turn streaming in; its reply is announced once when it lands).
 */
export function MessageRow({ side, children, meta, appear = false, pinned = false, quiet = false, ...data }: { side: "owner" | "manager" | "note"; children: ReactNode; meta?: ReactNode; appear?: boolean; pinned?: boolean; quiet?: boolean; [k: `data-${string}`]: string | undefined }) {
  const cls = [classes.row, appear ? classes.appear : ""].join(" ");
  if (side === "note") {
    return (
      <div className={`${classes.note} ${appear ? classes.appear : ""}`} data-ds="message" {...data}>
        {children}
      </div>
    );
  }
  return (
    <div className={cls} data-ds="message" aria-live={quiet ? "off" : undefined} {...data}>
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


/** The manager is at work and has nothing new to show yet: a quiet loading line. */
export function WorkingLine({ children }: { children: ReactNode }) {
  return (
    <div className={classes.working} data-ds="working">
      <Loader type="dots" size="xs" color="gray" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

export type StepStatus = "running" | "done" | "error" | "stopped";

const STATUS_LABEL: Record<StepStatus, string> = { running: "running", done: "done", error: "failed", stopped: "stopped" };

function StepIcon({ status }: { status: StepStatus }) {
  return (
    <span className={classes.stepIcon} data-status={status} aria-hidden>
      {status === "running" ? (
        <Loader size={icon.sm} color="gray" />
      ) : status === "error" ? (
        <IconX size={icon.sm} />
      ) : status === "stopped" ? (
        <IconPlayerStopFilled size={icon.sm} />
      ) : (
        <IconCheck size={icon.sm} />
      )}
    </span>
  );
}

/**
 * One tool call of a turn: a compact row (its status, its name, its main argument) that opens onto its
 * details. The row is a button as wide as the steps; its details are the feature's.
 */
export function StepRow({ name, summary, status, open, onToggle, children }: { name: string; summary: string; status: StepStatus; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className={classes.step} data-ds="step" data-status={status} data-open={open || undefined}>
      <UnstyledButton className={classes.stepRow} onClick={onToggle} aria-expanded={open} aria-controls={id} aria-label={`${name}${summary ? ` ${summary}` : ""}, ${STATUS_LABEL[status]}`}>
        <StepIcon status={status} />
        <span className={classes.stepName}>{name}</span>
        {summary && <span className={classes.stepSummary}>{summary}</span>}
        <IconChevronRight size={icon.sm} className={classes.chevron} aria-hidden />
      </UnstyledButton>
      <Collapse expanded={open} transitionDuration={motion.slow} transitionTimingFunction={motion.enter} id={id}>
        <div className={classes.stepDetail} data-slot="step-detail">
          {children}
        </div>
      </Collapse>
    </div>
  );
}

/** A step's detail: a caption over its value, verbatim in the mono family, wrapped. */
export function StepField({ label, children, tone }: { label: string; children: ReactNode; tone?: "danger" }) {
  return (
    <div className={classes.field}>
      <div className={classes.fieldLabel}>{label}</div>
      <div className={classes.fieldValue} data-tone={tone}>
        {children}
      </div>
    </div>
  );
}

/** A turn's steps, one under another, tight: a group of their own. */
export function StepList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={classes.steps} role="list" aria-label={label} data-ds="steps">
      {children}
    </div>
  );
}

/** What the manager did along the way to a reply, closed ("Used 3 tools"), opening onto its steps. */
export function StepsDisclosure({ label, open, onToggle, children }: { label: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className={classes.disclosure} data-ds="steps-disclosure" data-open={open || undefined}>
      <UnstyledButton className={classes.disclosureRow} onClick={onToggle} aria-expanded={open} aria-controls={id}>
        <span>{label}</span>
        <IconChevronRight size={icon.sm} className={classes.chevron} aria-hidden />
      </UnstyledButton>
      <Collapse expanded={open} transitionDuration={motion.slow} transitionTimingFunction={motion.enter} id={id}>
        <div className={classes.disclosureBody}>{children}</div>
      </Collapse>
    </div>
  );
}

/** The composer's box: the field over a bar (a hint or a note on its left, the actions on its right). */
export function ComposerBox({ children, bar }: { children: ReactNode; bar: ReactNode }) {
  return (
    <div className={classes.composer} data-ds="composer">
      {children}
      <div className={classes.composerBar}>{bar}</div>
    </div>
  );
}

/** The empty chat: centred in the log, a line about the manager and its starters under it. */
export function ChatWelcome({ title, children, starters }: { title: ReactNode; children: ReactNode; starters: ReactNode }) {
  return (
    <div className={classes.welcome} data-slot="empty">
      <div className={classes.welcomeTitle}>{title}</div>
      <div className={classes.welcomeText}>{children}</div>
      <div className={classes.starters}>{starters}</div>
    </div>
  );
}

/** A starter: a suggestion that fills the composer. */
export function Starter({ children, onClick, leftSection }: { children: ReactNode; onClick: () => void; leftSection?: ReactNode }) {
  return (
    <UnstyledButton className={classes.starter} onClick={onClick} data-ds="starter">
      {leftSection}
      <span>{children}</span>
    </UnstyledButton>
  );
}

/** The composer under the log (pinned at the viewport's bottom on a phone), its pill floating above it. */
export function ComposerDock({ children, pill }: { children: ReactNode; pill?: ReactNode }) {
  return (
    <div className={classes.dock} data-ds="composer-dock">
      {pill && (
        <>
          {/* The log fades out under the pill, so it never sits on a line cut in half. */}
          <div className={classes.fade} aria-hidden />
          <JumpPill>{pill}</JumpPill>
        </>
      )}
      {children}
    </div>
  );
}

/** A code block's frame: its language and Copy above the code, and a footer (Show all N lines) under it. */
export function CodeFrame({ lang, copy, footer, children }: { lang: string; copy: ReactNode; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className={classes.code} data-ds="code-block">
      <div className={classes.codeHead}>
        <span>{lang || "text"}</span>
        {copy}
      </div>
      {children}
      {footer && <div className={classes.codeFoot}>{footer}</div>}
    </div>
  );
}

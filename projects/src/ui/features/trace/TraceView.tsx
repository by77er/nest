// An agent's trace as a terminal transcript, the way Claude Code prints one: each turn under a quiet rule
// (its start time and how it ended), the assistant's text after `●` as Markdown (TraceMarkdown), each tool call as `● Name(argument)`
// with its full input a click away and its result on the next line after `⎿` (the first lines, then
// `… +N lines`), and states, asks and errors as dim one-liners. Older turns come from nest's trace
// history, loaded as the reader scrolls to the top; only what arrives live fades in. It follows the
// newest line only while scrolled to the bottom; otherwise "Jump to live" takes it there.
//
// Kept cheap as it streams: the turns are grouped from the previous state's (groupTurnsFrom), so a turn
// that didn't change is the same object, and the turn, item, tool call and event components are memoized:
// an event appended re-renders its own turn and the log around it, not the turns before.
// And drawn only where it's seen: each turn is a TermTurn (`content-visibility: auto`), skipped off screen
// at its last drawn height or an estimate (turnSize), so the scroll holds below (Load older, following,
// Jump to live) are kept while turns take their own heights as they're drawn.

import { Badge, Button, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { memo, type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { exact } from "../../common/time";
import { FadeIn, Glyph, GLYPH, icon, TermStatus, LoadingState, Notice, Row, ScrollLog, Section, Stack, Terminal, TermLine, TermRule, TermTurn, useFillColumn, weight } from "../../layout";
import {
  groupTurnsFrom, type HistoryEvent, lastState, primaryArg, resultLines, type ToolItem, type TraceEvent, type TraceItem, type TraceState, type TraceStatus, toolName,
  type TurnGroup,
} from "./model";
import { TraceMarkdown } from "./TraceMarkdown";
import { useTrace } from "./useTrace";

/** Within this many px of the bottom counts as at the bottom (a fraction of a line); of the top, as asking for more. */
const NEAR_BOTTOM = 24;
const NEAR_TOP = 80;
/**
 * For this many frames after new lines arrive while following, the log's content growing is theirs being
 * drawn: a line fading in takes its height when it shows (a frame or two on), and a turn's estimated height
 * (TermTurn) becomes its own when the browser first draws it. Its own commit, its fade-in's, then a margin.
 */
const SETTLE_FRAMES = 4;
/** How many times "Jump to live" goes on after stopping short of a bottom that moved. */
const JUMP_TRIES = 8;

const STATUS: Record<TraceStatus, { label: string; color: "success" | "gray" | "warning" }> = {
  live: { label: "Live", color: "success" },
  connecting: { label: "Connecting", color: "gray" },
  reconnecting: { label: "Reconnecting", color: "warning" },
  ended: { label: "Ended", color: "gray" },
};

const INPUT: Record<string, string> = { user: "message", inbox: "inbox", ask_answer: "answer", recovery: "recovery", event_batch: "events" };

type AnyEvent = TraceEvent | HistoryEvent;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A tool's input as sent (compact JSON, perhaps cut short), indented when it parses. */
function pretty(input: unknown): string {
  const s = str(input);
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function ToolResult({ r }: { r: AnyEvent }) {
  const [all, setAll] = useState(false);
  const { head, more, all: lines } = resultLines(r.summary);
  const error = r.is_error === true;
  const shownLines = all ? lines : head;
  const text = shownLines.length ? shownLines.join("\n") : error ? "Error" : "(no output)";
  const toggle = (where: string) => (
    <TermLine indent={1} tone="muted" onClick={() => setAll((a) => !a)} expanded={all} data-slot="more" data-at={where}>
      {all ? "(collapse)" : `… +${more} ${more === 1 ? "line" : "lines"} (expand)`}
    </TermLine>
  );
  return (
    <>
      {more > 0 && all && toggle("top")}
      <TermLine indent={1} glyph={GLYPH.result} glyphTone="muted" tone={error ? "danger" : "muted"} data-kind="tool_result" data-error={error ? "true" : "false"}>
        {error && (
          <>
            <Glyph g={GLYPH.error} tone="danger" />{" "}
          </>
        )}
        {text}
      </TermLine>
      {more > 0 && toggle("end")}
    </>
  );
}

const ToolCall = memo(function ToolCall({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const region = useId();
  const r = item.result;
  const error = r?.is_error === true;
  const name = str(item.call.name);
  const arg = primaryArg(item.call.input);
  return (
    <Stack gap="2xs" data-kind="tool" data-call={str(item.call.call_id)} data-state={!r ? "running" : error ? "error" : "done"}>
      <TermLine
        glyph={r ? GLYPH.bullet : GLYPH.pending}
        glyphTone={!r ? "muted" : error ? "danger" : "success"}
        onClick={() => setOpen((o) => !o)}
        expanded={open}
        controls={region}
        label={`${toolName(name)}(${arg})`}
        title={name}
        data-slot="call"
      >
        <Text component="span" ff="monospace" fz="sm" fw={weight.bold} inherit>
          {toolName(name)}
        </Text>
        {`(${arg})`}
      </TermLine>
      <div id={region} role="region" aria-label={`${toolName(name)} input`} hidden={!open}>
        {open && (
          <TermLine indent={1} data-slot="input">
            {pretty(item.call.input)}
          </TermLine>
        )}
      </div>
      {r && <ToolResult r={r} />}
    </Stack>
  );
});

const EventItem = memo(function EventItem({ ev }: { ev: AnyEvent }) {
  switch (ev.type) {
    case "assistant_text":
      return (
        <TermLine glyph={GLYPH.bullet} data-kind="text">
          <TraceMarkdown text={str(ev.text)} />
        </TermLine>
      );
    case "state":
      return (
        <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-kind="state">
          now {str(ev.state).replace(/_/g, " ")}
        </TermLine>
      );
    case "ask":
      return (
        <TermLine glyph={GLYPH.ask} glyphTone="warning" tone="muted" data-kind="ask">
          waiting for an answer: {str(ev.question)}
        </TermLine>
      );
    case "ask_answered":
      return (
        <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-kind="ask_answered">
          answered
        </TermLine>
      );
    case "error":
      return (
        <TermLine glyph={GLYPH.error} glyphTone="danger" tone="danger" data-kind="error">
          {str(ev.code)}: {str(ev.message)}
        </TermLine>
      );
    case "rate_limited":
      return (
        <TermLine glyph={GLYPH.warn} glyphTone="warning" tone="muted" data-kind="rate_limited">
          rate limited: {str(ev.detail)}
        </TermLine>
      );
    case "task_exited":
      return (
        <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-kind="task_exited">
          background task {str(ev.task_id)} {str(ev.status).replace(/_/g, " ")}
          {ev.exit_code !== undefined ? ` (code ${str(ev.exit_code)})` : ""}
        </TermLine>
      );
    case "ended":
      return (
        <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-kind="ended">
          the agent ended ({str(ev.reason)})
        </TermLine>
      );
    default:
      return null; // a type this page doesn't know
  }
});

const SHOWN = new Set(["assistant_text", "state", "ask", "ask_answered", "error", "rate_limited", "task_exited", "ended"]);
/** Visible items: an unknown event type renders nothing, so it gets no slot. */
const visible = (i: TraceItem) => i.kind === "tool" || SHOWN.has(i.event.type);

function tokens(u: unknown): string | null {
  const x = u as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!x || typeof x.input_tokens !== "number" || typeof x.output_tokens !== "number") return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(x.input_tokens)} in · ${k(x.output_tokens)} out`;
}

/**
 * A turn's height before it is first drawn, for TermTurn (which holds a turn off screen at it until then):
 * its rows, the characters of the lines that wrap (spread over the log's columns), and its gaps. A line
 * that wraps costs about a third of a row more than its characters (its last row, part-filled); a blank
 * line between blocks is a block's gap. Fitted on a 2,000-event trace at 390, 1280 and 1440 px: the
 * estimated total was within 2% of the drawn one at each width.
 */
function turnSize(g: TurnGroup, items: TraceItem[]): { rows: number; chars: number; gaps: number } {
  let rows = g.turn ? 1.6 : 0; // the rule: its caption-sized label and its margins
  let chars = 0;
  for (const i of items) {
    const one = itemSize(i);
    rows += one.rows;
    chars += one.chars;
  }
  return { rows, chars, gaps: Math.max(0, items.length - 1 + (g.turn ? 1 : 0)) };
}

/** A line's share of its turn's estimate, kept per item (an item is a new object when it changes): a turn
 * growing adds its new line's, not its every line's again. */
const sizes = new WeakMap<TraceItem, { rows: number; chars: number }>();
function itemSize(i: TraceItem): { rows: number; chars: number } {
  const known = sizes.get(i);
  if (known) return known;
  let rows = 0;
  let chars = 0;
  const wraps = (s: string) => {
    chars += s.length;
    rows += 0.35;
  };
  if (i.kind === "tool") {
    wraps(`${toolName(str(i.call.name))}(${primaryArg(i.call.input)})`);
    if (i.result) {
      const { head, more } = resultLines(i.result.summary);
      if (!head.length) rows += 1;
      for (const l of head) wraps(`${l}  `);
      rows += 0.2 + (more > 0 ? 1.2 : 0);
    }
  } else if (i.event.type === "assistant_text") {
    let fence = false;
    for (const line of str(i.event.text).split("\n")) {
      if (line.startsWith("```")) fence = !fence;
      if (fence || line.startsWith("```")) rows += 1; // a fence doesn't wrap: it scrolls in itself
      else if (!line.trim()) rows += 0.4;
      else wraps(line);
    }
  } else rows += 1;
  const size = { rows, chars };
  sizes.set(i, size);
  return size;
}

/** One line of a turn, fading in if it arrived while watching. */
const Item = memo(function Item({ item, animate }: { item: TraceItem; animate: boolean }) {
  return <FadeIn animate={animate} item={item.key}>{item.kind === "tool" ? <ToolCall item={item} /> : <EventItem ev={item.event} />}</FadeIn>;
});

const Turn = memo(function Turn({ g, animateAfter }: { g: TurnGroup; animateAfter: number }) {
  const items = g.items.filter(visible);
  const head = g.items[0];
  const at = g.started?.ts_ms ?? (head ? (head.kind === "tool" ? head.call.ts_ms : head.event.ts_ms) : null);
  const kind = g.started ? INPUT[str(g.started.input_kind)] : undefined;
  const rule = [
    at !== null ? clock.format(at) : null,
    g.started ? kind : "started earlier",
    g.completed ? str(g.completed.stop_reason) || "done" : "running",
    g.completed ? tokens(g.completed.usage) : null,
  ].filter(Boolean).join(" · ");
  const size = turnSize(g, items);
  return (
    <TermTurn {...size} aria-label={g.turn ? "Turn" : "Between turns"} role="group" data-turn={g.turn ?? ""} data-status={g.completed ? "completed" : "running"}>
      {g.turn && (
        <span title={at !== null ? exact(at) : undefined}>
          <TermRule>{rule}</TermRule>
        </span>
      )}
      {items.map((i) => (
        <Item key={i.key} item={i} animate={i.seq !== null && i.seq > animateAfter} />
      ))}
    </TermTurn>
  );
});

/**
 * What a turn's `animateAfter` is: the state's if any of its lines is newer, else one value for all, so a
 * turn with nothing to fade in doesn't render again when the state's changes (at `live`, at a drop).
 */
const fadesIn = (g: TurnGroup, after: number) => {
  const newest = g.items.at(-1)?.seq;
  return newest !== undefined && newest !== null && newest > after ? after : Number.POSITIVE_INFINITY;
};

/**
 * The line being read: the first of a turn's lines not wholly above the log's top (by its item's key, so it's
 * found again when its turn is made anew: a page ending inside the first turn does that), and where it was.
 */
type Held = { line: Element; item: string; y: number };

function readerLine(v: HTMLElement): Held | null {
  const top = v.getBoundingClientRect().top;
  for (const t of v.querySelectorAll("[data-turn]")) {
    if (t.getBoundingClientRect().bottom <= top) continue;
    for (const line of t.querySelectorAll(":scope > [data-item]")) {
      const r = line.getBoundingClientRect();
      if (r.bottom > top) return { line, item: line.getAttribute("data-item")!, y: r.top - top };
    }
  }
  return null;
}

/** Scrolls `v` so `h`'s line is back where it was: whether that moved it, or null if the line is gone. */
function restore(v: HTMLElement, h: Held): boolean | null {
  if (!h.line.isConnected) {
    const again = [...v.querySelectorAll("[data-item]")].find((l) => l.getAttribute("data-item") === h.item);
    if (!again) return null;
    h.line = again;
  }
  const d = h.line.getBoundingClientRect().top - v.getBoundingClientRect().top - h.y;
  if (Math.abs(d) < 0.5) return false;
  v.scrollTop += d;
  return true;
}

/** The trace of a state, presented (separate from the socket, so tests can give a state directly). */
export function TraceLog({ title, state, loadOlder = () => {} }: { title: string; state: TraceState; loadOlder?: () => void }) {
  const { fill, untitled } = useFillColumn();
  // Grouped from the last state's grouping (kept as state, updated while rendering: React's pattern for
  // information from the previous render): the work is for what came since, and unchanged turns keep their
  // objects. It needs `state.events` to grow by appending, as the reducer makes it (groupTurnsFrom).
  const [grouping, setGrouping] = useState(() => groupTurnsFrom(null, state.events, state.older));
  let current = grouping;
  if (grouping.events !== state.events || grouping.older !== state.older) {
    current = groupTurnsFrom(grouping, state.events, state.older);
    setGrouping(current);
  }
  const groups = current.groups;
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // Following: new lines arrived and are still being drawn (SETTLE_FRAMES). Jumping: "Jump to live" is on its
  // way down. Held: the line being read while a page above is on its way (holding -1) and, once it's in,
  // while the turns around it are drawn (holding 1, or 2 counting quiet frames). Each settle and jump has its
  // own number (its run's), so a frame loop left from an earlier one stops.
  const settling = useRef(0);
  const settleRun = useRef(0);
  const jumping = useRef(0);
  const jumpRun = useRef(0);
  const held = useRef<Held | null>(null);
  const holding = useRef(0);
  const heldTop = useRef(0); // where the hold last put the log
  const [unseen, setUnseen] = useState(0);
  const seen = useRef(state.last);
  const heightBefore = useRef<number | null>(null);
  const load = useRef(loadOlder);
  load.current = loadOlder;
  const canLoad = typeof state.olderCursor === "string" && state.olderState === "idle";
  const canLoadRef = useRef(canLoad);
  canLoadRef.current = canLoad;

  const older = () => {
    const v = viewport.current;
    heightBefore.current = v ? v.scrollHeight : null;
    held.current = v ? readerLine(v) : null;
    holding.current = held.current ? -1 : 0;
    load.current();
  };

  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    // Hidden (a tab switched away: `display: none`), the log has no height and the browser may drop its
    // scroll position: what the reader had is kept, and put back when it shows again.
    // Shown for the first time (it mounted hidden), it starts at the newest line, as it would have.
    let hidden = false;
    let lastTop: number | null = null;
    const seen = new ResizeObserver(() => {
      if (v.clientHeight === 0) hidden = true;
      else if (hidden) {
        hidden = false;
        // A jump hidden on its way down (its loop stopped) arrives now.
        if (jumping.current) {
          jumping.current = 0;
          v.scrollTop = v.scrollHeight;
        } else v.scrollTop = lastTop ?? (atBottomRef.current ? v.scrollHeight : 0);
      }
    });
    seen.observe(v);
    // The log's content resized (before it's painted). While a page loaded above is drawn, the reader's line
    // stays where it was; while what just arrived is drawn, the log stays at the bottom it follows. Anything
    // else (a result expanded, a turn drawn as the reader scrolls to it) is left to the browser, as before.
    const grown = new ResizeObserver(() => {
      if (v.clientHeight === 0 || hidden) return;
      // Turns drawn while the page is on its way: the line is where the reader now sees it.
      if (held.current && holding.current === -1) held.current = readerLine(v) ?? held.current;
      else if (held.current && holding.current > 0) {
        const moved = restore(v, held.current);
        if (moved === null) {
          holding.current = 0;
          held.current = null;
        } else if (moved) {
          holding.current = 1; // what's above it drawn again: SETTLE_FRAMES more from here
          heldTop.current = v.scrollTop;
        }
      }
      // Following, a page on its way or not.
      if (settling.current > 0 && atBottomRef.current) v.scrollTo({ top: v.scrollHeight });
    });
    if (v.firstElementChild) grown.observe(v.firstElementChild);
    // The reader taking the scroll back ends a jump, a hold and following what's being drawn (a page still
    // on its way keeps the line they scroll to).
    const root = v.parentElement ?? v;
    const takeBack = () => {
      jumping.current = 0;
      settling.current = 0;
      if (holding.current > 0) {
        holding.current = 0;
        held.current = null;
      }
    };
    const taking = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const t of taking) root.addEventListener(t, takeBack, { passive: true });
    const onScroll = () => {
      if (v.clientHeight === 0 || hidden) return;
      // A jump moved back up (find-in-page, a screen reader): the reader's, so it ends. (Less than half the
      // log is the browser's anchoring as turns it passed are drawn.)
      if (jumping.current && lastTop !== null && v.scrollTop < lastTop - v.clientHeight / 2) jumping.current = 0;
      lastTop = v.scrollTop;
      if (held.current && holding.current === -1) held.current = readerLine(v) ?? held.current;
      // Scrolled by something else than the hold (find-in-page, a screen reader, focus; or the browser's own
      // anchoring, which then holds the line itself): that's the reader's.
      if (holding.current > 0 && Math.abs(v.scrollTop - heldTop.current) > 1) {
        holding.current = 0;
        held.current = null;
      }
      const near = v.scrollHeight - v.scrollTop - v.clientHeight <= NEAR_BOTTOM;
      // A jump ends at the true bottom (its own loop's), not near it: the bottom may have moved on.
      if (v.scrollHeight - v.scrollTop - v.clientHeight <= 1) jumping.current = 0;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setUnseen(0);
      // Near the top: the page before, if there is one.
      if (v.scrollTop <= NEAR_TOP && !near && canLoadRef.current) older();
    };
    v.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      v.removeEventListener("scroll", onScroll);
      for (const t of taking) root.removeEventListener(t, takeBack);
      seen.disconnect();
      grown.disconnect();
      settling.current = 0;
      jumping.current = 0;
      holding.current = 0;
    };
  }, []);

  // Older events came in above: kept in place (what was being read stays where it was), or at the bottom if it was there.
  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const h = holding.current === -1 ? held.current : null;
    holding.current = 0;
    if (atBottomRef.current) v.scrollTo({ top: v.scrollHeight });
    else if (h && restore(v, h) !== null) {
      // Held while the turns around it are drawn (the ResizeObserver above): the new ones are at their
      // estimated heights until then, which the browser's own anchoring doesn't hold the reader across.
      holding.current = 1;
      heldTop.current = v.scrollTop;
      let quiet = 0;
      const tick = () => {
        if (holding.current === 0 || held.current !== h) return; // taken back, or another page asked for
        if (holding.current === 1) {
          holding.current = 2;
          quiet = 0;
        }
        if (++quiet < SETTLE_FRAMES) requestAnimationFrame(tick);
        else {
          holding.current = 0;
          held.current = null;
        }
      };
      requestAnimationFrame(tick);
    } else if (heightBefore.current !== null) v.scrollTo({ top: v.scrollTop + v.scrollHeight - heightBefore.current });
    heightBefore.current = null;
    if (holding.current === 0) held.current = null;
    // Not enough yet to scroll (so no way to reach the top): the page before, too.
    if (canLoadRef.current && v.clientHeight > 0 && v.scrollHeight <= v.clientHeight) older();
  }, [state.older]);

  // A page asked for that didn't come (it failed): nothing is on its way, so nothing is held for it, and a
  // page that comes later (a retry asks again) isn't measured from then.
  useLayoutEffect(() => {
    if (state.olderState !== "loading" && holding.current === -1) {
      holding.current = 0;
      held.current = null;
      heightBefore.current = null;
    }
  }, [state.olderState]);

  // New events: followed only while at the bottom; otherwise counted for "Jump to live".
  useLayoutEffect(() => {
    // Counted from the newest back: the work is for what came, not for all that's held.
    let added = 0;
    for (let i = state.events.length - 1; i >= 0 && state.events[i]!.seq > seen.current; i--) added++;
    seen.current = state.last;
    if (!added) return;
    const v = viewport.current;
    if (atBottomRef.current) {
      v?.scrollTo({ top: v.scrollHeight });
      // Held at the bottom while it's drawn (the ResizeObserver above), for SETTLE_FRAMES frames from the last arrival.
      const mine = ++settleRun.current;
      settling.current = mine;
      let frames = 0;
      const tick = () => {
        if (settling.current !== mine) return; // newer lines took over, or unmounted
        if (++frames < SETTLE_FRAMES) requestAnimationFrame(tick);
        else settling.current = 0;
      };
      requestAnimationFrame(tick);
    } else setUnseen((n) => n + added);
  }, [state.events, state.last]);

  const jump = () => {
    const v = viewport.current;
    // Going to the bottom: no line above is held any more.
    holding.current = 0;
    held.current = null;
    v?.scrollTo({ top: v.scrollHeight, behavior: "smooth" });
    const mine = ++jumpRun.current;
    jumping.current = mine;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
    // The turns it passes on its way down are drawn at their own heights, so the bottom it set out for can
    // move: when it stops short of the bottom, it goes on to the bottom as it is now.
    let last = -1;
    let still = 0;
    let tries = 0;
    const tick = () => {
      if (!v || jumping.current !== mine) return; // taken back, arrived, or another jump
      if (v.clientHeight === 0) return; // hidden: it arrives when shown again (the ResizeObserver above)
      if (v.scrollHeight - v.scrollTop - v.clientHeight <= 1) {
        jumping.current = 0;
        return;
      }
      still = v.scrollTop === last ? still + 1 : 0;
      last = v.scrollTop;
      if (still >= SETTLE_FRAMES) {
        // Each time only what it passed was drawn anew, so a few tries reach it; past those it stops.
        if (++tries > JUMP_TRIES) {
          jumping.current = 0;
          return;
        }
        still = 0;
        v.scrollTo({ top: v.scrollHeight, behavior: "smooth" });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const status = STATUS[state.status];
  const agentState = useMemo(() => lastState(state.events), [state.events]);
  const empty = state.events.length === 0 && state.older.length === 0;
  let top: ReactNode = null;
  if (state.olderState === "loading") {
    top = (
      <TermLine glyph={GLYPH.pending} glyphTone="muted" tone="muted" data-slot="older">
        loading earlier…
      </TermLine>
    );
  } else if (state.olderState === "error") {
    top = (
      <TermLine glyph={GLYPH.error} glyphTone="danger" tone="muted" onClick={older} data-slot="older">
        earlier events couldn't be loaded: retry
      </TermLine>
    );
  } else if (canLoad && state.older.length > 0) {
    top = (
      <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" onClick={older} data-slot="older">
        load earlier
      </TermLine>
    );
  } else if (state.olderCursor === null && state.older.length > 0) {
    top = (
      <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-slot="older">
        the beginning of the trace
      </TermLine>
    );
  }

  const statusLine = (
    <>
      {agentState && (
        <Text fz="xs" c="dimmed" data-slot="agent-state">
          {agentState.replace(/_/g, " ")}
        </Text>
      )}
      <Badge variant="light" color={status.color} data-slot="trace-status" aria-live="polite">
        {status.label}
      </Badge>
    </>
  );
  const body = (
    <Stack gap="md" fill={fill}>
      {state.gap && (
        <Notice tone="info" title="Earlier events aren't in the live trace">
          <Text fz="xs">
            Events {state.gap.from}–{state.gap.to} are older than nest keeps for the live trace.
          </Text>
        </Notice>
      )}
      {state.trimmed && (
        <Text fz="xs" c="dimmed">
          Older events are hidden to keep the page light.
        </Text>
      )}
      <Terminal fill={fill}>
        {/* Under a tab that names it: the connection on the terminal's first line, not a row of its own. */}
        {untitled && (
          <TermStatus note={agentState?.replace(/_/g, " ")}>
            <Badge variant="light" color={status.color} data-slot="trace-status" aria-live="polite">
              {status.label}
            </Badge>
          </TermStatus>
        )}
        <ScrollLog viewportRef={viewport} fill={fill}>
          {empty && state.olderState !== "loading" ? (
            state.status === "connecting" ? (
              <LoadingState label="Connecting to the trace" terminal />
            ) : (
              <TermLine glyph={GLYPH.note} glyphTone="muted" tone="muted" data-slot="empty">
                {state.status === "ended" ? "the agent ended with nothing in its trace" : "nothing yet: what the agent does shows here as it happens"}
              </TermLine>
            )
          ) : (
            <Stack gap="sm">
              {top}
              {groups.map((g) => (
                <Turn key={g.key} g={g} animateAfter={fadesIn(g, state.animateAfter)} />
              ))}
            </Stack>
          )}
        </ScrollLog>
      </Terminal>
      {!atBottom && (
        <Row justify="center">
          <Button variant="light" size="compact-sm" leftSection={<IconArrowDown size={icon.sm} />} onClick={jump}>
            {unseen > 0 ? `Jump to live (${unseen} new)` : "Jump to live"}
          </Button>
        </Row>
      )}
    </Stack>
  );

  if (untitled) {
    return (
      <Stack gap="md" fill={fill}>
        <VisuallyHidden>
          <Title order={3}>{title}</Title>
        </VisuallyHidden>
        {body}
      </Stack>
    );
  }
  return (
    <Section title={title} region={false} fill={fill} actions={statusLine}>
      {body}
    </Section>
  );
}

/** An agent's live trace, connected while shown; `empty` says why there's no agent yet. */
export function TraceView({ title, agent, empty = "No agent yet." }: { title: string; agent: string | null; empty?: string }) {
  const { state, loadOlder } = useTrace(agent);
  if (!agent) {
    return (
      <Section title={title} region={false}>
        <Text fz="sm" c="dimmed">
          {empty}
        </Text>
      </Section>
    );
  }
  return <TraceLog title={title} state={state} loadOlder={loadOlder} />;
}

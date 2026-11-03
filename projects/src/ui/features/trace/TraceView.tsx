// An agent's trace as a terminal transcript, the way Claude Code prints one: each turn under a quiet rule
// (its start time and how it ended), the assistant's text after `●`, each tool call as `● Name(argument)`
// with its full input a click away and its result on the next line after `⎿` (the first lines, then
// `… +N lines`), and states, asks and errors as dim one-liners. Older turns come from nest's trace
// history, loaded as the reader scrolls to the top; only what arrives live fades in. It follows the
// newest line only while scrolled to the bottom; otherwise "Jump to live" takes it there.

import { Badge, Button, Text, Title, VisuallyHidden } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { exact } from "../../common/time";
import { FadeIn, Glyph, GLYPH, icon, TermStatus, LoadingState, Notice, Row, ScrollLog, Section, Stack, Terminal, TermLine, TermRule, useFillColumn } from "../../layout";
import {
  groupTurns, type HistoryEvent, lastState, primaryArg, resultLines, type ToolItem, type TraceEvent, type TraceItem, type TraceState, type TraceStatus, toolName,
  type TurnGroup,
} from "./model";
import { useTrace } from "./useTrace";

/** Within this many px of the bottom counts as at the bottom (a fraction of a line); of the top, as asking for more. */
const NEAR_BOTTOM = 24;
const NEAR_TOP = 80;

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

function ToolCall({ item }: { item: ToolItem }) {
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
        <Text component="span" ff="monospace" fz="sm" fw="bold" inherit>
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
}

function EventItem({ ev }: { ev: AnyEvent }) {
  switch (ev.type) {
    case "assistant_text":
      return (
        <TermLine glyph={GLYPH.bullet} data-kind="text">
          {str(ev.text)}
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
}

const SHOWN = new Set(["assistant_text", "state", "ask", "ask_answered", "error", "rate_limited", "task_exited", "ended"]);
/** Visible items: an unknown event type renders nothing, so it gets no slot. */
const visible = (i: TraceItem) => i.kind === "tool" || SHOWN.has(i.event.type);

function tokens(u: unknown): string | null {
  const x = u as { input_tokens?: number; output_tokens?: number } | undefined;
  if (!x || typeof x.input_tokens !== "number" || typeof x.output_tokens !== "number") return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(x.input_tokens)} in · ${k(x.output_tokens)} out`;
}

function Turn({ g, animateAfter }: { g: TurnGroup; animateAfter: number }) {
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
  return (
    <Stack gap="md" aria-label={g.turn ? "Turn" : "Between turns"} role="group" data-turn={g.turn ?? ""} data-status={g.completed ? "completed" : "running"}>
      {g.turn && (
        <span title={at !== null ? exact(at) : undefined}>
          <TermRule>{rule}</TermRule>
        </span>
      )}
      {items.map((i) => (
        <FadeIn key={i.key} animate={i.seq !== null && i.seq > animateAfter}>
          {i.kind === "tool" ? <ToolCall item={i} /> : <EventItem ev={i.event} />}
        </FadeIn>
      ))}
    </Stack>
  );
}

/** The trace of a state, presented (separate from the socket, so tests can give a state directly). */
export function TraceLog({ title, state, loadOlder = () => {} }: { title: string; state: TraceState; loadOlder?: () => void }) {
  const { fill, untitled } = useFillColumn();
  const groups = useMemo(() => groupTurns(state.events, state.older), [state.events, state.older]);
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
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
        v.scrollTop = lastTop ?? (atBottomRef.current ? v.scrollHeight : 0);
      }
    });
    seen.observe(v);
    const onScroll = () => {
      if (v.clientHeight === 0 || hidden) return;
      lastTop = v.scrollTop;
      const near = v.scrollHeight - v.scrollTop - v.clientHeight <= NEAR_BOTTOM;
      atBottomRef.current = near;
      setAtBottom(near);
      if (near) setUnseen(0);
      // Near the top: the page before, if there is one.
      if (v.scrollTop <= NEAR_TOP && !near && canLoadRef.current) older();
    };
    v.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      v.removeEventListener("scroll", onScroll);
      seen.disconnect();
    };
  }, []);

  // Older events came in above: kept in place (what was being read stays where it was), or at the bottom if it was there.
  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v) return;
    if (atBottomRef.current) v.scrollTo({ top: v.scrollHeight });
    else if (heightBefore.current !== null) v.scrollTo({ top: v.scrollTop + v.scrollHeight - heightBefore.current });
    heightBefore.current = null;
    // Not enough yet to scroll (so no way to reach the top): the page before, too.
    if (canLoadRef.current && v.clientHeight > 0 && v.scrollHeight <= v.clientHeight) older();
  }, [state.older]);

  // New events: followed only while at the bottom; otherwise counted for "Jump to live".
  useLayoutEffect(() => {
    const added = state.events.filter((e) => e.seq > seen.current).length;
    seen.current = state.last;
    if (!added) return;
    const v = viewport.current;
    if (atBottomRef.current) v?.scrollTo({ top: v.scrollHeight });
    else setUnseen((n) => n + added);
  }, [state.events, state.last]);

  const jump = () => {
    const v = viewport.current;
    v?.scrollTo({ top: v.scrollHeight, behavior: "smooth" });
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
  };

  const status = STATUS[state.status];
  const agentState = lastState(state.events);
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
                <Turn key={g.key} g={g} animateAfter={state.animateAfter} />
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

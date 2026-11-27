// The conversation with the project's manager (README.md#the-manager-chat), held to the bar of the best
// web chats through the design skill: the owner's messages a quiet bubble on the right, the manager's
// unboxed prose across the measure under its name; groups by author and day; the manager's turn
// streaming in from its live trace, each tool it calls a compact row that opens onto its input and
// result, and a reply keeping its steps behind "Used n tools"; a docked composer in a rounded box (Enter
// sends, drafts kept, Stop while a turn runs); a log that scrolls in itself, sticks to the bottom only
// when you're there, offers the way back down when you're not, and loads older messages as you scroll up
// without losing your place.

import { ActionIcon, Badge, Button, CopyButton, Menu, Text, Tooltip, VisuallyHidden } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconAlertTriangle, IconArrowDown, IconCalendarEvent, IconCopy, IconDots, IconListCheck, IconMessage, IconQuote, IconRefresh, IconWritingSign } from "@tabler/icons-react";
import { createContext, memo, startTransition, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api/client";
import { useChat, useManager, usePostChat, useRetryChat } from "../../api/queries";
import type { ChatMessage } from "../../api/types";
import { ago, exact } from "../../common/time";
import {
  ChatFrame, ChatLog, ChatWelcome, ComposerDock, DaySeparator, ErrorState, icon, isPhoneNow, LoadingState, MessageGroup, MessageRow, Prose, Row, SpinnerSlot, Stack, Starter, StepField, StepList, StepRow, StepsDisclosure, WorkingLine,
} from "../../layout";
import { RichMessage } from "../rich/RichMessage";
import { useAgentTrace } from "../trace/SharedTrace";
import { Composer, type ComposerHandle } from "./Composer";
import { type LogItem, markRead, type Step, stepsBySeq, timeline, type ToolStep, TurnReader } from "./model";

/** A message of the owner's the page couldn't post (its answer never came): kept with its request id, so Retry posts the same message. */
type Unsent = ChatMessage & { request_id: string };
const requestId = () => crypto.randomUUID().replace(/-/g, "");

/** What a new conversation can start with: they fill the composer, they don't send. */
export const STARTERS = ["Spec a task for ", "What's blocked right now?", "Summarize progress this week", "Plan the next milestone"];
const STARTER_ICONS = [IconWritingSign, IconAlertTriangle, IconListCheck, IconCalendarEvent];

/**
 * Told when the reader opens a row or a reply's steps: what they opened grows the log under where they
 * are reading, so the chat stops following the end (it would scroll what they asked for away).
 */
const OpenedContext = createContext<() => void>(() => {});

/** A row's open state, telling the chat when it opens. */
function useOpen(): [boolean, () => void] {
  const [open, setOpen] = useState(false);
  const opened = useContext(OpenedContext);
  return [
    open,
    () => {
      if (!open) opened();
      setOpen(!open);
    },
  ];
}

/** One tool call: its row, and behind it each input field and the result (drawn again only when the call changes). */
const ToolStepView = memo(function ToolStepView({ s }: { s: ToolStep }) {
  const [open, toggle] = useOpen();
  return (
    <StepRow name={s.name} summary={s.summary} status={s.status} open={open} onToggle={toggle}>
      {s.input.map((f) => (
        <StepField key={f.key} label={f.key}>
          {f.value}
        </StepField>
      ))}
      <StepField label="Result" tone={s.status === "error" ? "danger" : undefined}>
        {s.result === null ? (s.status === "running" ? "Running…" : "No result was recorded.") : s.result || "(no output)"}
      </StepField>
    </StepRow>
  );
});

/**
 * A turn's steps in order: what it said, and each run of tool calls as one tight list. `quiet`: the
 * steps behind a finished reply, where what it said along the way is secondary to the reply itself.
 */
function Steps({ steps, projectId, quiet = false }: { steps: Step[]; projectId: string; quiet?: boolean }) {
  const runs: (Step | ToolStep[])[] = [];
  for (const s of steps) {
    const last = runs.at(-1);
    if (s.kind === "tool" && Array.isArray(last)) last.push(s);
    else runs.push(s.kind === "tool" ? [s] : s);
  }
  return (
    <Stack gap="sm">
      {runs.map((r) =>
        Array.isArray(r) ? (
          <StepList key={r[0]!.key} label={r.length === 1 ? "A tool call" : `${r.length} tool calls`}>
            {r.map((s) => (
              <div role="listitem" key={s.key}>
                <ToolStepView s={s} />
              </div>
            ))}
          </StepList>
        ) : r.kind === "text" ? (
          quiet ? (
            <Prose key={r.key} size="sm" dimmed>
              {r.text}
            </Prose>
          ) : (
            <RichMessage key={r.key} text={r.text} projectId={projectId} />
          )
        ) : null,
      )}
    </Stack>
  );
}

/** A running turn shows its last `LIVE_SHOWN` steps; the earlier ones fold away above them. */
const LIVE_SHOWN = 4;

function LiveSteps({ steps, projectId }: { steps: Step[]; projectId: string }) {
  if (steps.length <= LIVE_SHOWN) return <Steps steps={steps} projectId={projectId} />;
  const recent = steps.slice(-LIVE_SHOWN);
  let earlier = steps.slice(0, -LIVE_SHOWN);
  // What it last said stays in view above the fold, when the fold would take it.
  let said: Step | null = null;
  if (!recent.some((s) => s.kind === "text")) {
    const i = earlier.map((s) => s.kind).lastIndexOf("text");
    if (i >= 0) {
      said = earlier[i]!;
      earlier = earlier.filter((_, k) => k !== i);
    }
  }
  // A failure behind the fold is named on it.
  const failed = earlier.filter((s) => s.kind === "tool" && s.status === "error").length;
  const label = `+${earlier.length} earlier ${earlier.length === 1 ? "step" : "steps"}${failed ? ` · ${failed} failed` : ""}`;
  return (
    <Stack gap="xs">
      {said && <Steps steps={[said]} projectId={projectId} />}
      {earlier.length > 0 && <ReplySteps steps={earlier} projectId={projectId} label={label} />}
      <Steps steps={recent} projectId={projectId} />
    </Stack>
  );
}

/** Steps closed until asked for: a reply's ("Used 3 tools"), or a running turn's earlier ones ("+4 earlier steps"). */
function ReplySteps({ steps, projectId, label }: { steps: Step[]; projectId: string; label?: string }) {
  const [open, toggle] = useOpen();
  const n = steps.filter((s) => s.kind === "tool").length;
  return (
    <StepsDisclosure label={label ?? `Used ${n} ${n === 1 ? "tool" : "tools"}`} open={open} onToggle={toggle}>
      <Steps steps={steps} projectId={projectId} quiet />
    </StepsDisclosure>
  );
}

/** The manager's mark beside its name. */
const MANAGER_MARK = <IconMessage size={icon.sm} />;

/** How many of the newest messages the log's first fill draws at once: more than a screen of them. */
export const DRAWN_FIRST = 8;

/** The key of the oldest item drawn at once, if the newest DRAWN_FIRST messages don't reach back to the first. */
function cutFor(items: readonly LogItem[]): string | null {
  let n = 0;
  for (let i = items.length - 1; i > 0; i--) {
    const it = items[i]!;
    n += it.kind === "group" ? it.messages.length : 0;
    // From its day's separator, if it's the day's first group.
    if (n >= DRAWN_FIRST) return items[i - 1]!.kind === "day" ? (i - 1 > 0 ? items[i - 1]!.key : null) : it.key;
  }
  return null;
}

/** How close to the bottom counts as at the bottom (px), and to the top starts loading older ones. */
const NEAR = 24;
const OLDER_AT = 80;
const PAGE = 50;
/** The longest a finished turn's stream is held waiting for its message. */
export const HOLD_MAX_MS = 30_000;

function MessageActions({ m, onQuote, onRetry }: { m: ChatMessage; onQuote: (text: string) => void; onRetry?: () => void }) {
  return (
    <Menu position="bottom-end" withinPortal={false} shadow="overlay">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" size="md" aria-label="Message actions">
          <IconDots size={icon.sm} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{exact(m.at_ms)}</Menu.Label>
        <CopyButton value={m.text}>
          {({ copied, copy }) => (
            <Menu.Item leftSection={<IconCopy size={icon.sm} />} onClick={copy} closeMenuOnClick={false}>
              {copied ? "Copied" : m.sender === "manager" ? "Copy as Markdown" : "Copy"}
            </Menu.Item>
          )}
        </CopyButton>
        <Menu.Item leftSection={<IconQuote size={icon.sm} />} onClick={() => onQuote(m.text)}>
          Quote in a reply
        </Menu.Item>
        {onRetry && (
          <Menu.Item leftSection={<IconRefresh size={icon.sm} />} onClick={onRetry}>
            Retry
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * One clock for the log's relative times, read every `AGO_TICK_MS` while any is shown: a message is drawn
 * again only for its own changes, so its time ("5 minutes ago") follows the clock on its own, and only
 * when its words change.
 */
const AGO_TICK_MS = 15_000;
const clock = { listeners: new Set<() => void>(), timer: undefined as ReturnType<typeof setInterval> | undefined };
function onTick(listener: () => void) {
  clock.listeners.add(listener);
  clock.timer ??= setInterval(() => {
    for (const l of clock.listeners) l();
  }, AGO_TICK_MS);
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0) {
      clearInterval(clock.timer);
      clock.timer = undefined;
    }
  };
}
function Ago({ ms }: { ms: number }) {
  return <>{useSyncExternalStore(onTick, () => ago(ms))}</>;
}

/** A message's delivery state (README.md#outboxes): an older row without one reads from `delivered` and `error`. */
const statusOf = (m: ChatMessage) => m.status ?? (m.delivered ? "done" : m.error ? "failed" : "owed");

/**
 * What to say of the owner's messages whose delivery changed since `seen` (updated here): the last
 * change, as a sentence, or null.
 */
export function statusNews(seen: Map<number, string>, messages: ChatMessage[]): string | null {
  let news: string | null = null;
  for (const m of messages) {
    if (m.sender !== "owner") continue;
    const now = statusOf(m);
    const before = seen.get(m.seq);
    seen.set(m.seq, now);
    if (before === now) continue;
    if (now === "failed") news = `Your message wasn't delivered${m.error ? `: ${m.error}` : ""}. Retry is available.`;
    else if (now === "retrying") news = `Still sending your message${m.error ? `: ${m.error}` : ""}.`;
    // An ordinary send (sending, then delivered) says nothing: only one that had been held up.
    else if (now === "done" && (before === "retrying" || before === "failed")) news = "Your message was delivered.";
    else if (now === "owed" && before === "failed") news = "Sending your message again.";
  }
  return news;
}

/** How long a message is in flight before its spinner shows (the skill: loading shows only after 300 ms). */
export const SPINNER_AFTER_MS = 300;

/**
 * A message in flight: the word ("Sending…", "Retrying…"), quiet, which always carries the state. `spin`:
 * this is the log's one message that may show a spinner (the most recent in flight). The spinner comes only
 * once it has been in flight here for `SPINNER_AFTER_MS`, so an ordinary send never flashes one, in room
 * kept from the start so the word doesn't move; with reduced motion there's none at all.
 */
export function InFlightMark({ retrying, spin }: { retrying: boolean; spin: boolean }) {
  const still = useReducedMotion();
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), SPINNER_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  return (
    <Row gap="xs" wrap="nowrap" data-marker="sending" data-status={retrying ? "retrying" : "owed"}>
      {spin && !still && <SpinnerSlot on={late} />}
      <Text fz="xs" c="dimmed">
        {retrying ? "Retrying…" : "Sending…"}
      </Text>
    </Row>
  );
}

interface MessageProps {
  m: ChatMessage;
  projectId: string;
  /** New since the log was last drawn: it fades in, as it mounts. */
  appear: boolean;
  steps?: Step[];
  spin?: boolean;
  onQuote: (t: string) => void;
  onRetry: (m: ChatMessage) => void;
}

const sameMessage = (a: MessageProps, b: MessageProps) => a.m === b.m && a.projectId === b.projectId && a.steps === b.steps && a.spin === b.spin && a.onQuote === b.onQuote && a.onRetry === b.onRetry;

/**
 * One message, drawn again only when what it shows changes: its data (a poll keeps an unchanged message's
 * object), its steps, its spinner. Whether it fades in is settled as it mounts (the animation runs then).
 */
const Message = memo(function Message({ m, projectId, appear: appearing, steps, spin = false, onQuote, onRetry }: MessageProps) {
  const [appear] = useState(appearing);
  if (m.sender === "app") {
    return (
      <MessageRow side="note" appear={appear} data-sender="app">
        {m.text}
      </MessageRow>
    );
  }
  const mine = m.sender === "owner";
  // Its real state (README.md#outboxes): being sent (owed, or retrying with why), or failed: refused for
  // good, or never taken by the app (an unsent one, a negative seq). Retry only on failed.
  const status = statusOf(m);
  const failed = mine && status === "failed";
  const retrying = mine && status === "retrying";
  const sending = mine && (status === "owed" || retrying);
  return (
    <MessageRow
      side={mine ? "owner" : "manager"}
      appear={appear}
      pinned={failed || sending}
      data-sender={m.sender}
      data-seq={String(m.seq)}
      meta={
        <>
          {sending && <InFlightMark retrying={retrying} spin={spin} />}
          {failed && (
            <Badge size="xs" color="warning" variant="light" leftSection={<IconAlertTriangle size={icon.sm} aria-hidden />} data-marker="undelivered">
              Not delivered
            </Badge>
          )}
          {/* The exact time on hover; for the keyboard and touch it heads the message's actions. */}
          <Tooltip label={exact(m.at_ms)} withArrow>
            <Text component="time" dateTime={new Date(m.at_ms).toISOString()} fz="xs" c="dimmed">
              <Ago ms={m.at_ms} />
            </Text>
          </Tooltip>
          {failed && (
            <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconRefresh size={icon.sm} />} onClick={() => onRetry(m)}>
              Retry
            </Button>
          )}
          <MessageActions m={m} onQuote={onQuote} onRetry={failed ? () => onRetry(m) : undefined} />
        </>
      }
    >
      {mine ? (
        <Prose size="lg">{m.text}</Prose>
      ) : (
        <Stack gap="xs">
          {steps && <ReplySteps steps={steps} projectId={projectId} />}
          <RichMessage text={m.text} projectId={projectId} />
        </Stack>
      )}
      {failed && m.error && (
        <Text fz="xs" c="warning">
          {m.error}
        </Text>
      )}
      {/* Still being sent: why it waits (the manager not started yet, nest busy), not a failure. */}
      {retrying && m.error && (
        <Text fz="xs" c="dimmed">
          {m.error}
        </Text>
      )}
    </MessageRow>
  );
}, sameMessage);

/** A group of messages by one author, drawn again only when one of its messages, or what it shows, changes. */
interface GroupProps {
  sender: string;
  messages: ChatMessage[];
  projectId: string;
  /** The steps behind each reply, by seq. */
  replySteps: Map<number, Step[]>;
  spinSeq: number | undefined;
  /** Whether a message is new since the log was last drawn. */
  isNew: (m: ChatMessage) => boolean;
  onQuote: (t: string) => void;
  onRetry: (m: ChatMessage) => void;
}

const sameGroup = (a: GroupProps, b: GroupProps) =>
  a.sender === b.sender &&
  a.projectId === b.projectId &&
  a.onQuote === b.onQuote &&
  a.onRetry === b.onRetry &&
  a.messages.length === b.messages.length &&
  a.messages.every((m, i) => m === b.messages[i] && a.replySteps.get(m.seq) === b.replySteps.get(m.seq) && (m.seq === a.spinSeq) === (m.seq === b.spinSeq));

const LogGroup = memo(function LogGroup({ sender, messages, projectId, replySteps, spinSeq, isNew, onQuote, onRetry }: GroupProps) {
  return (
    <MessageGroup side={sender === "owner" ? "owner" : sender === "manager" ? "manager" : "note"} name={sender === "manager" ? "Manager" : undefined} avatar={MANAGER_MARK}>
      {messages.map((m) => (
        <Message key={m.seq} m={m} projectId={projectId} appear={isNew(m)} steps={replySteps.get(m.seq)} spin={m.seq === spinSeq} onQuote={onQuote} onRetry={onRetry} />
      ))}
    </MessageGroup>
  );
}, sameGroup);

/** A part of the turn in progress, between the messages sent during it: the last has the working line. */
function StreamPart({ steps, working, projectId }: { steps: Step[]; working: boolean; projectId: string }) {
  return (
    <MessageGroup side="manager" name="Manager" avatar={MANAGER_MARK}>
      <MessageRow side="manager" quiet data-sender="stream">
        <Stack gap="sm">
          {steps.length > 0 && <LiveSteps steps={steps} projectId={projectId} />}
          {working && <WorkingLine>Working…</WorkingLine>}
        </Stack>
      </MessageRow>
    </MessageGroup>
  );
}

export function ChatView({ projectId, agent }: { projectId: string; agent: string | null }) {
  const chat = useChat(projectId);
  const post = usePostChat(projectId);
  const retryChat = useRetryChat(projectId);
  const trace = useAgentTrace(agent);
  // Each turn of the trace read once (README.md#the-manager-chat): only the one in progress again as it grows.
  const reader = useMemo(() => new TurnReader(), [agent]);
  const { live, finished } = useMemo(() => reader.read(trace.state.events), [reader, trace.state.events]);

  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState<Unsent[]>([]);
  const [atBottom, setAtBottomState] = useState(true);
  // Read by observers between renders; the state drives the pill.
  const atBottomRef = useRef(true);
  const setAtBottom = useCallback((b: boolean) => {
    atBottomRef.current = b;
    setAtBottomState(b);
  }, []);
  const lastTop = useRef(0);
  const [unseen, setUnseen] = useState(0);
  const [announce, setAnnounce] = useState("");
  // Each of the owner's messages' delivery state as last seen, for announcing its changes.
  const statuses = useRef(new Map<number, string>());
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const seen = useRef<Set<number> | null>(null);
  const anchor = useRef<number | null>(null);
  // One page at a time: scroll events that come before the render showing "loading" read the handler as it
  // was, so the flag the guard reads is a ref, set before the request and cleared once its page is drawn.
  const loadingOlderRef = useRef(false);
  // The log's first fill still being drawn above the newest messages (below): the top isn't the top yet.
  const partialRef = useRef(false);
  // Nothing said yet and no turn running: nothing to follow (its welcome is read from the top).
  const emptyRef = useRef(true);
  // The last stream, kept until the turn's message lands, so the swap doesn't jump.
  const [held, setHeld] = useState<{ turn: string; steps: Step[]; sinceSeq: number } | null>(null);

  const latest = useMemo(() => chat.data ?? [], [chat.data]);
  const messages = useMemo(() => {
    const bySeq = new Map<number, ChatMessage>();
    for (const m of [...older, ...latest]) bySeq.set(m.seq, m);
    // One in flight (a negative seq until nest gives it one) is the newest: after every one nest has.
    const all = [...bySeq.values()];
    return [...all.filter((m) => m.seq > 0).sort((a, b) => a.seq - b.seq), ...all.filter((m) => m.seq < 0).sort((a, b) => a.at_ms - b.at_ms), ...failed];
  }, [older, latest, failed]);
  const { maxSeq, lastManagerSeq, spinSeq } = useMemo(() => {
    let max = 0;
    let manager = 0;
    let spin: number | undefined;
    for (const m of messages) {
      max = Math.max(max, m.seq);
      if (m.sender === "manager") manager = Math.max(manager, m.seq);
      // One spinner in the log: the most recent of the owner's messages in flight.
      if (m.sender === "owner" && (statusOf(m) === "owed" || statusOf(m) === "retrying")) spin = m.seq;
    }
    return { maxSeq: max, lastManagerSeq: manager, spinSeq: spin };
  }, [messages]);

  // Reading the chat here reads it: the Manager row's unread dot clears.
  useEffect(() => {
    if (maxSeq > 0) markRead(projectId, maxSeq);
  }, [projectId, maxSeq]);

  // Hold the stream until its message lands (a manager message newer than when it began; any, for a turn
  // first seen in the backlog replayed on opening, whose message may be in the log already); another turn
  // starting lets the last one go.
  // A turn this view first sees in its first render was read from the backlog, as a fresh connection replays
  // it, even when the trace (shared with the Trace tab) was live before the view mounted.
  const firstRender = useRef(true);
  useEffect(() => {
    if (!live) return;
    const since = trace.state.status === "live" && !firstRender.current ? lastManagerSeq : 0;
    setHeld((h) => (live.steps.length ? { turn: live.turn, steps: live.steps, sinceSeq: h?.turn === live.turn ? h.sinceSeq : since } : h?.turn === live.turn ? h : null));
  }, [live]); // `lastManagerSeq` and the trace's status are read at each turn's start only
  useEffect(() => {
    firstRender.current = false;
  }, []);
  // The held turn as it ended (a call it never answered reads stopped), while the ring has it.
  const heldEnd = !live && held ? (finished.find((t) => t.turn === held.turn) ?? null) : null;
  // Its message, once in the log: one of the manager's since it began, by what it says (an older one
  // saying the same isn't it), or the newest if the ring has lost the turn.
  const reply = !held || live ? undefined : heldEnd ? (heldEnd.reply ? messages.filter((m) => m.sender === "manager" && m.seq > held.sinceSeq && m.text.trim() === heldEnd.reply).at(-1) : undefined) : lastManagerSeq > held.sinceSeq ? messages.find((m) => m.seq === lastManagerSeq) : undefined;
  // Let go once its message is in the log, or it ended without one (stopped), and the reader is at the end;
  // and after HOLD_MAX_MS if its message never comes. Landed, it isn't shown again (under its own reply)
  // while the release waits for the effect. Reading back, it stays (its parts before the messages sent
  // during it, all of a stopped one's) until the reader is back at the end: the log doesn't shrink under
  // their line.
  const landed = !!held && !live && (reply !== undefined || (heldEnd !== null && !heldEnd.reply));
  useEffect(() => {
    if (held && !live && landed && atBottom) setHeld(null);
  }, [held, live, landed, atBottom]);
  useEffect(() => {
    if (!held || live || landed) return;
    const t = setTimeout(() => setHeld(null), HOLD_MAX_MS);
    return () => clearTimeout(t);
  }, [held, live, landed]);

  // The reader opened something: the end is no longer followed (scroll anchoring holds their line).
  const stopFollowing = useCallback(() => {
    if (atBottomRef.current) setAtBottom(false);
  }, [setAtBottom]);

  const scrollToBottom = useCallback(() => {
    // The log scrolls, never the page (no scrollIntoView, which scrolls every ancestor).
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
    setUnseen(0);
  }, []);

  // New messages: followed only when at the bottom, counted for the pill otherwise. A completed manager
  // message is announced, once (never the stream's every token).
  useLayoutEffect(() => {
    if (!chat.data) return;
    const known = seen.current;
    const fresh = messages.filter((m) => m.seq > 0 && known && !known.has(m.seq));
    seen.current = new Set(messages.filter((m) => m.seq > 0).map((m) => m.seq));
    if (!known) {
      statusNews(statuses.current, messages);
      // An empty chat opens at its top (on a phone, the page's column with its header).
      if (messages.length) scrollToBottom();
      return;
    }
    const lastManager = fresh.filter((m) => m.sender === "manager").at(-1);
    // A change in one of the owner's messages' delivery is said too (once per change, never on load): a
    // reply outranks it when both land together.
    const said = statusNews(statuses.current, messages);
    if (lastManager) setAnnounce(`The manager replied: ${lastManager.text.slice(0, 500)}`);
    else if (said) setAnnounce(said);
    if (atBottomRef.current) scrollToBottom();
    else if (fresh.length) setUnseen((n) => n + fresh.length);
  }, [messages]); // follows the log, reading the scroll state as it is now

  useLayoutEffect(() => {
    if (atBottomRef.current && !emptyRef.current) scrollToBottom();
  }, [held?.steps, live?.turn]); // the stream growing, while at the bottom

  // Content that grows after it renders (math, an image or figure decoding) keeps the end in view while
  // the reader is at it.
  useEffect(() => {
    const content = log.current?.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && anchor.current === null && !emptyRef.current) {
        const el = log.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [chat.isPending, chat.isError]); // the log mounts once the chat has loaded

  // Older messages keep the place you were reading: the distance from the bottom is restored. And the
  // next page may be asked for only now that this one is drawn (a scroll before would ask for it again).
  useLayoutEffect(() => {
    loadingOlderRef.current = false;
    const el = log.current;
    if (el && anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [older]);

  const loadOlder = useCallback(async () => {
    const first = messages.find((m) => m.seq > 0);
    if (!first || loadingOlderRef.current || !hasOlder) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.chat(projectId, first.seq);
      const el = log.current;
      if (page.length === 0) loadingOlderRef.current = false; // nothing to draw: the [older] effect won't run
      else if (el) anchor.current = el.scrollHeight - el.scrollTop;
      setOlder((o) => (page.length ? [...page, ...o] : o));
      if (page.length < PAGE) setHasOlder(false);
    } catch {
      // Tried again on the next scroll.
      loadingOlderRef.current = false;
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, hasOlder, projectId]);

  // What the handlers below read as it is now, so they keep one identity (the log's rows and the composer
  // aren't drawn again for a new handler).
  const now = useRef({ loadOlder, latest, failed, post, retryChat });
  now.current = { loadOlder, latest, failed, post, retryChat };

  const onScroll = useCallback(() => {
    const el = log.current;
    if (!el) return;
    // Reaching the end rejoins it; only scrolling up leaves it (growth never moves the log).
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    if (bottom) {
      if (!atBottomRef.current) setAtBottom(true);
      setUnseen(0);
    } else if (el.scrollTop < lastTop.current && atBottomRef.current) setAtBottom(false);
    lastTop.current = el.scrollTop;
    if (el.scrollTop < OLDER_AT && now.current.latest.length >= PAGE && !partialRef.current) void now.current.loadOlder();
  }, [setAtBottom]);

  // Posts a message (the composer's, or one the page never had an answer for, again): false if not taken.
  const send = useCallback(
    (t: string, fromRetry?: Unsent): boolean => {
      const post = now.current.post;
      if (!t || post.isPending) return false;
      if (fromRetry) setFailed((f) => f.filter((x) => x !== fromRetry));
      // The same request id on a retry: if the first post landed and only its answer was lost, it's one message.
      const request_id = fromRetry?.request_id ?? requestId();
      post.mutate({ text: t, request_id }, {
        // Not taken: kept in the log as not delivered, with Retry.
        onError: (e) => setFailed((f) => [...f, { seq: -Date.now(), at_ms: Date.now(), sender: "owner", text: t, delivered: false, status: "failed", error: e.message, request_id }]),
      });
      setAtBottom(true);
      requestAnimationFrame(() => {
        scrollToBottom();
        composer.current?.focus();
      });
      return true;
    },
    [setAtBottom, scrollToBottom],
  );
  const sendComposed = useCallback((t: string) => send(t), [send]);
  const jumpToLatest = () => {
    setAtBottom(true);
    scrollToBottom();
  };
  // One the app took and nest refused: owed again on the server (once, however often asked). One the app
  // never answered for: posted again under its request id.
  const retry = useCallback(
    (m: ChatMessage) => {
      if (m.seq > 0) now.current.retryChat.mutate(m.seq);
      else send(m.text, now.current.failed.find((x) => x === m));
    },
    [send],
  );
  const quoteReply = useCallback((t: string) => composer.current?.quote(t), []);

  // The manager ended or errored (README.md#the-manager-lifecycle): said where the composer is (a phone
  // lands here, far below the page's notice), with its Restart, and nothing to Stop.
  const manager = useManager(projectId);
  const down = manager.data?.phase === "ended" || manager.data?.phase === "errored";
  const running = !!live && !down;
  // The turn in the log where it is in time (README.md#the-manager-chat): split by the messages sent
  // during it; a held one keeps its split until its reply lands.
  const shown = held && !(landed && atBottom);
  const heldSteps = heldEnd?.steps ?? held?.steps;
  const turnId = live?.turn ?? held?.turn;
  const landedSeq = reply?.seq;
  const turn = useMemo(
    () => (live ? { ...live, running } : shown && turnId && heldSteps ? { turn: turnId, steps: heldSteps, running: false, landed: landedSeq } : null),
    [live, running, shown, turnId, heldSteps, landedSeq],
  );
  // Recomputed when the log or the turn changes (or the day, for its labels), not on every render.
  const today = new Date().toDateString();
  const items = useMemo(() => timeline(messages, turn), [messages, turn, today]);
  const replySteps = useMemo(() => stepsBySeq(messages, finished), [messages, finished]);
  const stream = items.some((it) => it.kind === "stream");
  emptyRef.current = messages.length === 0 && !stream;
  const isNew = useCallback((m: ChatMessage) => !!seen.current && m.seq > 0 && !seen.current.has(m.seq), []);
  // The log's first fill (opening the chat on its latest page) drawn newest first: the newest messages, a
  // screen's worth (DRAWN_FIRST), at once, the ones above them in a transition, which React renders in
  // slices that yield to the page, so opening the chat is no single long task. The reader is at the end
  // meanwhile (the log keeps it there as it grows above), and nothing older is asked for until it's drawn.
  const [filled, setFilled] = useState(false);
  const [cut, setCut] = useState<string | null>(null);
  if (!filled && messages.length > 0) {
    setFilled(true);
    // Only where the log scrolls in itself (from `sm` up): on a phone the page is the scroller, and drawing
    // above the reader there made following the end less steady (the design review's chat-follow-growth).
    setCut(isPhoneNow() ? null : cutFor(items));
  }
  useEffect(() => {
    if (cut !== null) startTransition(() => setCut(null));
  }, [cut]);
  const from = cut === null ? -1 : items.findIndex((it) => it.key === cut);
  const drawn = from > 0 ? items.slice(from) : items;
  // As committed: a transition's render in progress (yielding to a scroll) doesn't count.
  const partial = from > 0;
  useLayoutEffect(() => {
    partialRef.current = partial;
  }, [partial]);

  const item = (it: LogItem) =>
    it.kind === "day" ? (
      <DaySeparator key={it.key} label={it.label} />
    ) : it.kind === "stream" ? (
      <StreamPart key={it.key} steps={it.steps} working={it.working} projectId={projectId} />
    ) : (
      <LogGroup key={it.key} sender={it.sender} messages={it.messages} projectId={projectId} replySteps={replySteps} spinSeq={spinSeq} isNew={isNew} onQuote={quoteReply} onRetry={retry} />
    );

  return (
    <OpenedContext.Provider value={stopFollowing}>
      <Stack gap="md">
        <ChatFrame>
          <ChatLog ref={log} onScroll={onScroll} label="Conversation with the manager" following={atBottom && !emptyRef.current}>
            {loadingOlder && <LoadingState label="Loading older messages" />}
            {chat.isPending ? (
              <>
                <LoadingState label="Loading the chat" />
                {drawn.map(item)}
              </>
            ) : chat.isError ? (
              <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
            ) : messages.length === 0 && !stream ? (
              <ChatWelcome
                title="What should we work on?"
                starters={STARTERS.map((st, i) => {
                  const Icon = STARTER_ICONS[i] ?? IconMessage;
                  return (
                    <Starter key={st} leftSection={<Icon size={icon.md} aria-hidden />} onClick={() => composer.current?.fill(st)}>
                      {st.endsWith(" ") ? `${st}…` : st}
                    </Starter>
                  );
                })}
              >
                The manager keeps this project's board: it specs tasks, assigns them, and tells you what's blocked.
              </ChatWelcome>
            ) : (
              drawn.map(item)
            )}
          </ChatLog>
        </ChatFrame>
        <VisuallyHidden aria-live="polite" role="status" data-slot="announce">
          {announce}
        </VisuallyHidden>

        <ComposerDock
          pill={
            !atBottom &&
            messages.length > 0 && (
              <Button size="xs" radius="xl" variant="default" leftSection={<IconArrowDown size={icon.sm} />} onClick={jumpToLatest}>
                {unseen > 0 ? `Jump to latest · ${unseen} new` : "Jump to latest"}
              </Button>
            )
          }
        >
          {/* Its own state: typing draws the composer alone. Each project's draft its own. */}
          <Composer key={projectId} ref={composer} projectId={projectId} running={running} down={down} sending={post.isPending} onSend={sendComposed} />
        </ComposerDock>
      </Stack>
    </OpenedContext.Provider>
  );
}

// The conversation with the project's manager (README.md#the-manager-chat), held to the bar of the best
// web chats through the design skill: the owner's messages a quiet bubble on the right, the manager's
// unboxed prose across the measure under its name; groups by author and day; the manager's turn
// streaming in from its live trace, each tool it calls a compact row that opens onto its input and
// result, and a reply keeping its steps behind "Used n tools"; a docked composer in a rounded box (Enter
// sends, drafts kept, Stop while a turn runs); a log that scrolls in itself, sticks to the bottom only
// when you're there, offers the way back down when you're not, and loads older messages as you scroll up
// without losing your place.

import { ActionIcon, Badge, Button, CopyButton, Menu, Text, Textarea, Tooltip, VisuallyHidden } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconCalendarEvent, IconCopy, IconDots, IconHourglass, IconListCheck, IconMessage, IconPlayerStop, IconQuote, IconRefresh, IconWritingSign } from "@tabler/icons-react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { human } from "../../../waits";
import { api } from "../../api/client";
import { useChat, useInterruptManager, usePostChat, useWaits } from "../../api/queries";
import type { ChatMessage } from "../../api/types";
import { ago, exact } from "../../common/time";
import {
  ChatFrame, ChatLog, ChatWelcome, ComposerBox, ComposerDock, DaySeparator, ErrorState, icon, LoadingState, MessageGroup, MessageRow, Prose, Row, Stack, Starter, StepField, StepList, StepRow, StepsDisclosure, WorkingLine,
} from "../../layout";
import { RichMessage } from "../rich/RichMessage";
import { useTrace } from "../trace/useTrace";
import { finishedTurns, groupLog, liveTurn, loadDraft, markRead, quote, saveDraft, type Step, stepsBySeq, type ToolStep } from "./model";

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

/** One tool call: its row, and behind it each input field and the result. */
function ToolStepView({ s }: { s: ToolStep }) {
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
}

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

/** A reply's steps, closed until asked for: "Used 3 tools". */
function ReplySteps({ steps, projectId }: { steps: Step[]; projectId: string }) {
  const [open, toggle] = useOpen();
  const n = steps.filter((s) => s.kind === "tool").length;
  return (
    <StepsDisclosure label={`Used ${n} ${n === 1 ? "tool" : "tools"}`} open={open} onToggle={toggle}>
      <Steps steps={steps} projectId={projectId} quiet />
    </StepsDisclosure>
  );
}

/** The manager's mark beside its name. */
const MANAGER_MARK = <IconMessage size={icon.sm} />;

/** How close to the bottom counts as at the bottom (px), and to the top starts loading older ones. */
const NEAR = 24;
const OLDER_AT = 80;
const PAGE = 50;
/** The longest a finished turn's stream is held waiting for its message. */
const HOLD_MAX_MS = 30_000;

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

function Message({ m, projectId, appear, steps, onQuote, onRetry }: { m: ChatMessage; projectId: string; appear: boolean; steps?: Step[]; onQuote: (t: string) => void; onRetry: (m: ChatMessage) => void }) {
  if (m.sender === "app") {
    return (
      <MessageRow side="note" appear={appear} data-sender="app">
        {m.text}
      </MessageRow>
    );
  }
  const mine = m.sender === "owner";
  // A message the app couldn't send (a negative seq with an error), or one nest refused for good.
  const sending = mine && m.seq < 0 && m.error === null;
  const failed = mine && !m.delivered && !sending && m.error !== null;
  return (
    <MessageRow
      side={mine ? "owner" : "manager"}
      appear={appear}
      pinned={failed}
      data-sender={m.sender}
      data-seq={String(m.seq)}
      meta={
        <>
          {mine && !m.delivered && (
            <Badge size="xs" color="warning" variant="light" data-marker="undelivered">
              {sending ? "Sending…" : "Not delivered"}
            </Badge>
          )}
          {/* The exact time on hover; for the keyboard and touch it heads the message's actions. */}
          <Tooltip label={exact(m.at_ms)} withArrow>
            <Text component="time" dateTime={new Date(m.at_ms).toISOString()} fz="xs" c="dimmed">
              {ago(m.at_ms)}
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
    </MessageRow>
  );
}

export function ChatView({ projectId, agent }: { projectId: string; agent: string | null }) {
  const chat = useChat(projectId);
  const post = usePostChat(projectId);
  const interrupt = useInterruptManager(projectId);
  const trace = useTrace(agent);
  const coarse = useMediaQuery("(pointer: coarse)") ?? false;
  const live = useMemo(() => liveTurn(trace.state.events), [trace.state.events]);
  const finished = useMemo(() => finishedTurns(trace.state.events), [trace.state.events]);
  const waits = useWaits(projectId);
  const replyWait = waits.data?.pending.find((w) => w.kind === "reply");
  // The time left on the owner's reply counts down by the minute.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!replyWait) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [replyWait?.id]);

  const [older, setOlder] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [failed, setFailed] = useState<ChatMessage[]>([]);
  const [text, setText] = useState(() => loadDraft(projectId));
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
  const log = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const seen = useRef<Set<number> | null>(null);
  const anchor = useRef<number | null>(null);
  // The last stream, kept until the turn's message lands, so the swap doesn't jump.
  const [held, setHeld] = useState<{ turn: string; steps: Step[]; sinceSeq: number } | null>(null);

  const latest = useMemo(() => chat.data ?? [], [chat.data]);
  const messages = useMemo(() => {
    const bySeq = new Map<number, ChatMessage>();
    for (const m of [...older, ...latest]) bySeq.set(m.seq, m);
    return [...[...bySeq.values()].sort((a, b) => a.seq - b.seq), ...failed];
  }, [older, latest, failed]);
  const maxSeq = messages.reduce((n, m) => Math.max(n, m.seq), 0);
  const lastManagerSeq = messages.reduce((n, m) => (m.sender === "manager" ? Math.max(n, m.seq) : n), 0);

  useEffect(() => saveDraft(projectId, text), [projectId, text]);
  // Reading the chat here reads it: the Manager row's unread dot clears.
  useEffect(() => {
    if (maxSeq > 0) markRead(projectId, maxSeq);
  }, [projectId, maxSeq]);

  // Hold the stream until its message lands (a manager message newer than when it began).
  useEffect(() => {
    if (live && live.steps.length) setHeld((h) => ({ turn: live.turn, steps: live.steps, sinceSeq: h?.turn === live.turn ? h.sinceSeq : lastManagerSeq }));
  }, [live]); // `lastManagerSeq` is read at each turn's start only
  // The held turn as it ended (a call it never answered reads stopped), while the ring has it.
  const heldEnd = !live && held ? (finished.find((t) => t.turn === held.turn) ?? null) : null;
  // Let go once its message is in the log (by what it says; by seq if the ring has lost the turn), at
  // once if it ended without a reply (stopped), and after HOLD_MAX_MS whatever happens.
  useEffect(() => {
    if (!held || live) return;
    const landed = heldEnd ? !heldEnd.reply || messages.some((m) => m.sender === "manager" && m.text.trim() === heldEnd.reply) : lastManagerSeq > held.sinceSeq;
    if (landed) {
      setHeld(null);
      return;
    }
    const t = setTimeout(() => setHeld(null), HOLD_MAX_MS);
    return () => clearTimeout(t);
  }, [held, live, heldEnd, messages, lastManagerSeq]);

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
      scrollToBottom();
      return;
    }
    const lastManager = fresh.filter((m) => m.sender === "manager").at(-1);
    if (lastManager) setAnnounce(`The manager replied: ${lastManager.text.slice(0, 500)}`);
    if (atBottomRef.current) scrollToBottom();
    else if (fresh.length) setUnseen((n) => n + fresh.length);
  }, [messages]); // follows the log, reading the scroll state as it is now

  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [held?.steps, live?.turn]); // the stream growing, while at the bottom

  // Content that grows after it renders (math, an image or figure decoding) keeps the end in view while
  // the reader is at it.
  useEffect(() => {
    const content = log.current?.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current && anchor.current === null) {
        const el = log.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [chat.isPending, chat.isError]); // the log mounts once the chat has loaded

  // Older messages keep the place you were reading: the distance from the bottom is restored.
  useLayoutEffect(() => {
    const el = log.current;
    if (el && anchor.current !== null) {
      el.scrollTop = el.scrollHeight - anchor.current;
      anchor.current = null;
    }
  }, [older]);

  const loadOlder = useCallback(async () => {
    const first = messages.find((m) => m.seq > 0);
    if (!first || loadingOlder || !hasOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api.chat(projectId, first.seq);
      const el = log.current;
      if (el) anchor.current = el.scrollHeight - el.scrollTop;
      setOlder((o) => [...page, ...o]);
      if (page.length < PAGE) setHasOlder(false);
    } catch {
      // Tried again on the next scroll.
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, hasOlder, projectId]);

  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    // Reaching the end rejoins it; only scrolling up leaves it (growth never moves the log).
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR;
    if (bottom) {
      if (!atBottomRef.current) setAtBottom(true);
      setUnseen(0);
    } else if (el.scrollTop < lastTop.current && atBottomRef.current) setAtBottom(false);
    lastTop.current = el.scrollTop;
    if (el.scrollTop < OLDER_AT && latest.length >= PAGE) void loadOlder();
  };

  const send = (t = text.trim(), fromRetry?: ChatMessage) => {
    if (!t || post.isPending) return;
    if (fromRetry) setFailed((f) => f.filter((x) => x !== fromRetry));
    post.mutate(t, {
      // Not taken: kept in the log as not delivered, with Retry.
      onError: (e) => setFailed((f) => [...f, { seq: -Date.now(), at_ms: Date.now(), sender: "owner", text: t, delivered: false, error: e.message }]),
    });
    if (!fromRetry) setText("");
    setAtBottom(true);
    requestAnimationFrame(() => {
      scrollToBottom();
      composer.current?.focus();
    });
  };
  const jumpToLatest = () => {
    setAtBottom(true);
    scrollToBottom();
  };
  const retry = (m: ChatMessage) => send(m.text, m.seq < 0 ? m : undefined);
  // Quoting puts the quote at the composer's start and the caret at its end, once the menu has closed
  // (it returns focus to its button first).
  const quoteReply = (t: string) => {
    const next = quote(t) + text;
    setText(next);
    setTimeout(() => {
      const c = composer.current;
      if (!c) return;
      c.focus();
      c.setSelectionRange(next.length, next.length);
    }, 0);
  };

  const items = groupLog(messages);
  const running = !!live;
  const streamSteps = live?.steps ?? (held ? (heldEnd?.steps ?? held.steps) : []);
  const replySteps = stepsBySeq(messages, finished);
  const stream = running || streamSteps.length > 0;
  // A tool running shows itself; otherwise the turn is between steps (thinking, writing): a working line.
  const toolRunning = streamSteps.some((st) => st.kind === "tool" && st.status === "running");
  const fillStarter = (st: string) => {
    setText(st);
    setTimeout(() => {
      const c = composer.current;
      if (!c) return;
      c.focus();
      c.setSelectionRange(st.length, st.length);
    }, 0);
  };

  return (
    <OpenedContext.Provider value={stopFollowing}>
      <Stack gap="md">
        <ChatFrame>
          <ChatLog ref={log} onScroll={onScroll} label="Conversation with the manager" following={atBottom}>
            {loadingOlder && <LoadingState label="Loading older messages" />}
            {chat.isPending ? (
              <LoadingState label="Loading the chat" />
            ) : chat.isError ? (
              <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
            ) : messages.length === 0 && !stream ? (
              <ChatWelcome
                title="What should we work on?"
                starters={STARTERS.map((st, i) => {
                  const Icon = STARTER_ICONS[i] ?? IconMessage;
                  return (
                    <Starter key={st} leftSection={<Icon size={icon.md} aria-hidden />} onClick={() => fillStarter(st)}>
                      {st.endsWith(" ") ? `${st}…` : st}
                    </Starter>
                  );
                })}
              >
                The manager keeps this project's board: it specs tasks, assigns them, and tells you what's blocked.
              </ChatWelcome>
            ) : (
              items.map((it) =>
                it.kind === "day" ? (
                  <DaySeparator key={it.key} label={it.label} />
                ) : (
                  <MessageGroup key={it.key} side={it.sender === "owner" ? "owner" : it.sender === "manager" ? "manager" : "note"} name={it.sender === "manager" ? "Manager" : undefined} avatar={MANAGER_MARK}>
                    {it.messages.map((m) => (
                      <Message
                        key={m.seq}
                        m={m}
                        projectId={projectId}
                        appear={!!seen.current && m.seq > 0 && !seen.current.has(m.seq)}
                        steps={replySteps.get(m.seq)}
                        onQuote={quoteReply}
                        onRetry={retry}
                      />
                    ))}
                  </MessageGroup>
                ),
              )
            )}
            {stream && !chat.isError && (
              <MessageGroup side="manager" name="Manager" avatar={MANAGER_MARK}>
                <MessageRow side="manager" quiet data-sender="stream">
                  <Stack gap="sm">
                    {streamSteps.length > 0 && <Steps steps={streamSteps} projectId={projectId} />}
                    {running && !toolRunning && <WorkingLine>Working…</WorkingLine>}
                  </Stack>
                </MessageRow>
              </MessageGroup>
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <ComposerBox
              bar={
                <>
                  {replyWait ? (
                    <Row gap="xs" wrap="nowrap" data-slot="reply-wait">
                      <Text component="span" c="dimmed" display="inline-flex">
                        <IconHourglass size={icon.sm} aria-hidden />
                      </Text>
                      <Text fz="xs" c="dimmed" title={`Times out ${exact(replyWait.deadline_ms)}`}>
                        Waiting for your reply · {replyWait.deadline_ms > now ? `${human(replyWait.deadline_ms - now)} left` : "timing out"}
                      </Text>
                    </Row>
                  ) : (
                    !coarse && (
                      <Text fz="xs" c="dimmed">
                        Enter to send · Shift+Enter for a new line
                      </Text>
                    )
                  )}
                  <Row gap="sm" wrap="nowrap">
                    {running && (
                      <Button variant="default" size="compact-sm" leftSection={<IconPlayerStop size={icon.sm} />} loading={interrupt.isPending} onClick={() => interrupt.mutate()}>
                        Stop
                      </Button>
                    )}
                    <Tooltip label="Send" withArrow disabled={coarse}>
                      <ActionIcon type="submit" size="lg" aria-label="Send" disabled={!text.trim() || post.isPending}>
                        <IconArrowUp size={icon.md} />
                      </ActionIcon>
                    </Tooltip>
                  </Row>
                </>
              }
            >
              <Textarea
                ref={composer}
                aria-label="Message to the manager"
                placeholder="Message the manager"
                variant="unstyled"
                autosize
                minRows={1}
                maxRows={10}
                maxLength={20000}
                value={text}
                onChange={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // On touch, Enter is a new line (a phone's keyboard has no Shift+Enter); Send sends.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !coarse) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </ComposerBox>
          </form>
        </ComposerDock>
      </Stack>
    </OpenedContext.Provider>
  );
}

// The conversation with the project's manager (README.md#the-manager-chat), held to the bar of the best
// web chats through the design skill: the owner's messages a quiet bubble on the right, the manager's
// unboxed prose across the measure; groups by author and day; the manager's turn streaming in from its
// live trace with what it's doing now; a docked composer (Enter sends, drafts kept, Stop while a turn
// runs); a log that scrolls in itself, sticks to the bottom only when you're there, and loads older
// messages as you scroll up without losing your place.

import { ActionIcon, Badge, Button, CopyButton, Menu, Text, Textarea, Tooltip, VisuallyHidden } from "@mantine/core";
import { IconArrowDown, IconCopy, IconDots, IconPlayerStop, IconQuote, IconRefresh, IconSend } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { useChat, useInterruptManager, usePostChat } from "../../api/queries";
import type { ChatMessage } from "../../api/types";
import { ago, exact } from "../../common/time";
import {
  ActivityLine, ChatFrame, ChatLog, ComposerDock, DaySeparator, ErrorState, icon, JumpPill, LoadingState, MessageGroup, MessageRow, Prose, Row, Stack, StreamText,
} from "../../layout";
import { RichMessage } from "../rich/RichMessage";
import { useTrace } from "../trace/useTrace";
import { groupLog, liveTurn, loadDraft, markRead, quote, saveDraft } from "./model";

/** What a new conversation can start with: they fill the composer, they don't send. */
export const STARTERS = ["Spec a task for ", "What's blocked right now?", "Summarize progress this week", "Plan the next milestone"];

/** How close to the bottom counts as at the bottom (px), and to the top starts loading older ones. */
const NEAR = 24;
const OLDER_AT = 80;
const PAGE = 50;

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

function Message({ m, projectId, appear, onQuote, onRetry }: { m: ChatMessage; projectId: string; appear: boolean; onQuote: (t: string) => void; onRetry: (m: ChatMessage) => void }) {
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
      {mine ? <Prose size="lg">{m.text}</Prose> : <RichMessage text={m.text} projectId={projectId} />}
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
  const live = useMemo(() => liveTurn(trace.state.events), [trace.state.events]);

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
  const [held, setHeld] = useState<{ text: string; sinceSeq: number } | null>(null);

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
    if (live && (live.text || live.activity)) setHeld((h) => ({ text: live.text, sinceSeq: h?.sinceSeq ?? lastManagerSeq }));
  }, [live]); // `lastManagerSeq` is read at the stream's start only
  useEffect(() => {
    if (held && !live && lastManagerSeq > held.sinceSeq) setHeld(null);
  }, [held, live, lastManagerSeq]);

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
  }, [held?.text, live?.activity]); // the stream growing, while at the bottom

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
  const retry = (m: ChatMessage) => send(m.text, m.seq < 0 ? m : undefined);
  const quoteReply = (t: string) => {
    setText((cur) => quote(t) + cur);
    composer.current?.focus();
  };

  const items = groupLog(messages);
  const stream = live ?? (held ? { text: held.text, activity: null, turn: "" } : null);
  const running = !!live;

  return (
    <Stack gap="md">
      <ChatFrame>
        <ChatLog ref={log} onScroll={onScroll} label="Conversation with the manager" following={atBottom}>
          {loadingOlder && <LoadingState label="Loading older messages" />}
          {chat.isPending ? (
            <LoadingState label="Loading the chat" />
          ) : chat.isError ? (
            <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
          ) : messages.length === 0 && !stream ? (
            <Stack gap="lg" align="flex-start" py="xl" data-slot="empty">
              <Text fz="lg">The manager keeps this project's board: it specs tasks, assigns them, and tells you what's blocked.</Text>
              <Row gap="sm">
                {STARTERS.map((s) => (
                  <Button
                    key={s}
                    variant="default"
                    onClick={() => {
                      setText(s);
                      composer.current?.focus();
                    }}
                  >
                    {s.endsWith(" ") ? `${s}…` : s}
                  </Button>
                ))}
              </Row>
            </Stack>
          ) : (
            items.map((it) =>
              it.kind === "day" ? (
                <DaySeparator key={it.key} label={it.label} />
              ) : (
                <MessageGroup key={it.key} side={it.sender === "owner" ? "owner" : it.sender === "manager" ? "manager" : "note"} name={it.sender === "manager" ? "Manager" : undefined}>
                  {it.messages.map((m) => (
                    <Message key={m.seq} m={m} projectId={projectId} appear={!!seen.current && m.seq > 0 && !seen.current.has(m.seq)} onQuote={quoteReply} onRetry={retry} />
                  ))}
                </MessageGroup>
              ),
            )
          )}
          {stream && (
            <MessageGroup side="manager" name="Manager">
              <MessageRow side="manager" data-sender="stream">
                <Stack gap="xs">
                  {stream.text &&
                    (running ? (
                      <StreamText>
                        <RichMessage text={stream.text} projectId={projectId} />
                      </StreamText>
                    ) : (
                      <RichMessage text={stream.text} projectId={projectId} />
                    ))}
                  {stream.activity && <ActivityLine>{stream.activity}</ActivityLine>}
                </Stack>
              </MessageRow>
            </MessageGroup>
          )}
        </ChatLog>
        {unseen > 0 && !atBottom && (
          <JumpPill>
            <Button size="xs" radius="xl" leftSection={<IconArrowDown size={icon.sm} />} onClick={scrollToBottom}>
              Jump to latest · {unseen} new
            </Button>
          </JumpPill>
        )}
      </ChatFrame>
      <VisuallyHidden aria-live="polite" role="status" data-slot="announce">
        {announce}
      </VisuallyHidden>

      <ComposerDock>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Stack gap="sm">
            <Textarea
              ref={composer}
              label="Message to the manager"
              placeholder="Write a message"
              autosize
              minRows={2}
              maxRows={10}
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Row justify="space-between">
              <Text fz="xs" c="dimmed">
                Enter to send · Shift+Enter for a new line
              </Text>
              <Row gap="sm">
                {running && (
                  <Button variant="default" leftSection={<IconPlayerStop size={icon.sm} />} loading={interrupt.isPending} onClick={() => interrupt.mutate()}>
                    Stop
                  </Button>
                )}
                <Button type="submit" rightSection={<IconSend size={icon.sm} />} disabled={!text.trim() || post.isPending}>
                  Send
                </Button>
              </Row>
            </Row>
          </Stack>
        </form>
      </ComposerDock>
    </Stack>
  );
}

// The conversation with the project's manager: the owner's messages (each flagged until it reaches the
// manager's inbox), the manager's replies and the app's notes, newest at the bottom, and the composer
// pinned to the viewport's bottom.

import { Badge, Button, Text, Textarea } from "@mantine/core";
import { IconArrowDown, IconSend } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat, usePostChat } from "../../api/queries";
import type { ChatMessage } from "../../api/types";
import { ago, exact } from "../../common/time";
import { RichMessage } from "../rich/RichMessage";
import { Bubble, ChatColumn, ErrorState, FooterPill, icon, LoadingState, PinnedFooter, Prose, Row, ScrollSentinel, Stack, weight } from "../../layout";

const WHO: Record<string, string> = { owner: "You", manager: "Manager", app: "The app" };

function Message({ m, projectId }: { m: ChatMessage; projectId: string }) {
  const mine = m.sender === "owner";
  if (m.sender === "app") {
    return (
      <Bubble side="note" data-sender={m.sender}>
        <Text fz="xs" c="dimmed">
          {m.text} · <span title={exact(m.at_ms)}>{ago(m.at_ms)}</span>
        </Text>
      </Bubble>
    );
  }
  return (
    <Bubble side={mine ? "end" : "start"} data-sender={m.sender}>
      <Stack gap="xs">
        <Row gap="sm" justify={mine ? "flex-end" : "flex-start"}>
          <Text fz="xs" fw={weight.medium}>
            {WHO[m.sender] ?? m.sender}
          </Text>
          <Text fz="xs" c="dimmed" title={exact(m.at_ms)}>
            {ago(m.at_ms)}
          </Text>
          {mine && !m.delivered && (
            <Badge size="xs" color="warning" variant="light" data-marker="undelivered">
              {m.seq < 0 ? "Sending" : "Not delivered"}
            </Badge>
          )}
        </Row>
        {/* The manager's messages render (Markdown, math, SVG, task links); the owner's stay plain text. */}
        {m.sender === "manager" ? <RichMessage text={m.text} projectId={projectId} /> : <Prose size="lg">{m.text}</Prose>}
        {mine && m.error && (
          <Text fz="xs" c="warning">
            {m.error}
          </Text>
        )}
      </Stack>
    </Bubble>
  );
}

export function ChatView({ projectId }: { projectId: string }) {
  const chat = useChat(projectId);
  const post = usePostChat(projectId);
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // Following the end: the state marks the column (its scroll anchoring), the ref is read by observers.
  const [following, setFollowingState] = useState(true);
  const followingRef = useRef(true);
  const setFollowing = useCallback((f: boolean) => {
    followingRef.current = f;
    setFollowingState(f);
  }, []);
  // Messages that arrived while reading back: the "New message" pill.
  const [unseen, setUnseen] = useState(0);
  const seenCount = useRef<number | null>(null);
  const count = chat.data?.length ?? 0;

  // To the end: exactly enough that the newest message clears the composer (the sentinel, the column's
  // gap below it, meets the composer's top), and nothing when it already does.
  const footerRef = useRef(0);
  const toEnd = useCallback(() => {
    const el = end.current;
    if (el && el.getBoundingClientRect().bottom > window.innerHeight - footerRef.current) el.scrollIntoView({ block: "end" });
  }, []);

  // The composer docks over the page's bottom: the newest message must clear it. Its height is measured,
  // and the end sentinel keeps that much room when scrolled to.
  useEffect(() => {
    const el = footer.current;
    if (!el) return;
    const measure = () => {
      footerRef.current = el.offsetHeight;
      setFooterHeight(el.offsetHeight);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // Reaching the end (the sentinel within a line of the composer's top) follows it; scrolling up leaves it.
  useEffect(() => {
    let last = window.scrollY;
    const onScroll = () => {
      const el = end.current;
      const y = window.scrollY;
      if (el && el.getBoundingClientRect().bottom <= window.innerHeight - footerHeight + 48) {
        if (!followingRef.current) setFollowing(true);
        setUnseen(0);
      } else if (y < last && followingRef.current) setFollowing(false);
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [footerHeight, setFollowing]);

  // New messages: followed at the end, counted for the pill while reading back. On open, the same:
  // scrolled exactly enough to clear the newest message above the composer, and no more.
  useEffect(() => {
    if (!count || !footerHeight) return;
    const before = seenCount.current;
    seenCount.current = count;
    if (before === null) {
      toEnd();
      return;
    }
    if (count <= before) return;
    if (followingRef.current) toEnd();
    else setUnseen((n) => n + count - before);
  }, [count, footerHeight, toEnd]);

  // Content growing after it renders (a chip resolving, math, an image decoding) keeps the end in view
  // while following; the sentinel anchors it, and this catches what anchoring can't.
  useEffect(() => {
    const log = end.current?.parentElement;
    if (!log) return;
    const ro = new ResizeObserver(() => {
      if (followingRef.current && seenCount.current !== null) toEnd();
    });
    ro.observe(log);
    return () => ro.disconnect();
  }, [toEnd]);

  const jump = () => {
    setFollowing(true);
    setUnseen(0);
    toEnd();
  };

  const send = () => {
    const t = text.trim();
    if (!t) return;
    // Shown at once; if it isn't taken, the text comes back to the composer. Sending goes to the end,
    // wherever you were reading: your message is there.
    post.mutate(t, { onError: () => setText((cur) => cur || t) });
    setText("");
    setFollowing(true);
    setUnseen(0);
    requestAnimationFrame(toEnd);
  };

  return (
    <ChatColumn following={following}>
      {chat.isPending ? (
        <LoadingState label="Loading the chat" />
      ) : chat.isError ? (
        <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
      ) : chat.data.length === 0 ? (
        <Text fz="md" c="dimmed" ta="center" py="2xl">
          No messages yet. Ask the manager to plan work, spec a task or explain the board.
        </Text>
      ) : (
        <Stack gap="md" aria-live="polite">
          {chat.data.map((m) => (
            <Message key={m.seq} m={m} projectId={projectId} />
          ))}
        </Stack>
      )}
      <ScrollSentinel ref={end} footer={footerHeight} />

      <PinnedFooter ref={footer}>
        {unseen > 0 && !following && (
          <FooterPill>
            <Button size="xs" radius="xl" leftSection={<IconArrowDown size={icon.sm} />} onClick={jump}>
              {unseen === 1 ? "New message" : `${unseen} new messages`}
            </Button>
          </FooterPill>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Stack gap="sm">
            <Textarea
              label="Message to the manager"
              placeholder="Write a message"
              autosize
              minRows={2}
              maxRows={8}
              maxLength={20000}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Row justify="space-between">
              <Text fz="xs" c="dimmed">
                Ctrl+Enter sends
              </Text>
              <Button type="submit" rightSection={<IconSend size={icon.sm} />} disabled={!text.trim()}>
                Send
              </Button>
            </Row>
          </Stack>
        </form>
      </PinnedFooter>
    </ChatColumn>
  );
}

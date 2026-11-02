// The conversation with the project's manager: the owner's messages (each flagged until it reaches the
// manager's inbox), the manager's replies and the app's notes, newest at the bottom, and the composer
// pinned to the viewport's bottom.

import { Badge, Button, Text, Textarea } from "@mantine/core";
import { IconSend } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useChat, usePostChat } from "../../api/queries";
import type { ChatMessage } from "../../api/types";
import { ago, exact } from "../../common/time";
import { Bubble, ErrorState, icon, LoadingState, PinnedFooter, Prose, Row, Stack } from "../../layout";

const WHO: Record<string, string> = { owner: "You", manager: "Manager", app: "The app" };

function Message({ m }: { m: ChatMessage }) {
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
          <Text fz="xs" fw="medium">
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
        <Prose size="lg">{m.text}</Prose>
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
  const count = chat.data?.length ?? 0;

  // Keep the newest message in view as messages arrive.
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    // Shown at once; if it isn't taken, the text comes back to the composer.
    post.mutate(t, { onError: () => setText((cur) => cur || t) });
    setText("");
  };

  return (
    <Stack gap="xl" aria-live="polite">
      {chat.isPending ? (
        <LoadingState label="Loading the chat" />
      ) : chat.isError ? (
        <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
      ) : chat.data.length === 0 ? (
        <Text fz="md" c="dimmed" ta="center" py="2xl">
          No messages yet. Ask the manager to plan work, spec a task or explain the board.
        </Text>
      ) : (
        <Stack gap="md">
          {chat.data.map((m) => (
            <Message key={m.seq} m={m} />
          ))}
        </Stack>
      )}
      <div ref={end} />

      <PinnedFooter>
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
    </Stack>
  );
}

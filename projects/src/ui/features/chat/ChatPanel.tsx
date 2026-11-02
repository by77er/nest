// The chat with the project's manager: the owner's messages (each flagged until it reaches the manager's
// inbox), the manager's replies and the app's notes, newest at the bottom, and a composer.

import { Badge, Button, Text, Textarea } from "@mantine/core";
import { IconSend } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useChat, usePostChat } from "../../api/queries";
import type { ChatMessage, Settings } from "../../api/types";
import { ago, exact } from "../../common/time";
import { Bubble, ErrorState, icon, LoadingState, Notice, Panel, Prose, Row, ScrollLog, Section, Stack } from "../../layout";

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
        <Prose size="md">{m.text}</Prose>
        {mine && m.error && (
          <Text fz="xs" c="warning">
            {m.error}
          </Text>
        )}
      </Stack>
    </Bubble>
  );
}

export function ChatPanel({ projectId, settings }: { projectId: string; settings: Settings | undefined }) {
  const chat = useChat(projectId);
  const post = usePostChat(projectId);
  const [text, setText] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const count = chat.data?.length ?? 0;

  // Keep the newest message in view as messages arrive.
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [count]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    // Shown at once; if it isn't taken, the text comes back to the composer.
    post.mutate(t, { onError: () => setText((cur) => cur || t) });
    setText("");
  };

  return (
    <Panel component="aside">
      <Section
        title="Manager"
        actions={
          settings && (
            <Badge variant="light" color={settings.manager ? "primary" : settings.manager_error ? "warning" : "gray"}>
              {settings.manager ? "Running" : settings.manager_error ? "Not started" : "Starting"}
            </Badge>
          )
        }
      >
        <Stack gap="lg">
          {settings?.manager_error && (
            <Notice tone="warning" title="The manager isn't running yet">
              <Text fz="xs">{settings.manager_error}</Text>
            </Notice>
          )}

          <ScrollLog viewportRef={viewport}>
            {chat.isPending ? (
              <LoadingState label="Loading the chat" />
            ) : chat.isError ? (
              <ErrorState title="The chat couldn't be loaded" error={chat.error} onRetry={() => void chat.refetch()} />
            ) : chat.data.length === 0 ? (
              <Text fz="sm" c="dimmed" ta="center" py="lg">
                No messages yet. Ask the manager to plan work, spec a task or explain the board.
              </Text>
            ) : (
              <Stack gap="md">
                {chat.data.map((m) => (
                  <Message key={m.seq} m={m} />
                ))}
              </Stack>
            )}
          </ScrollLog>

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
        </Stack>
      </Section>
    </Panel>
  );
}

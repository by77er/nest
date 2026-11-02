// The chat with the project's manager: the owner's messages (each flagged until it reaches the manager's
// inbox), the manager's replies and the app's notes, newest at the bottom, and a composer.

import { Alert, Badge, Box, Button, Group, Paper, ScrollArea, Stack, Text, Textarea, Title } from "@mantine/core";
import { IconAlertTriangle, IconSend } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useChat, usePostChat } from "../../api/queries";
import type { ChatMessage, Settings } from "../../api/types";
import { Loading, LoadError } from "../../common/QueryStates";
import { ago, exact } from "../../common/time";

const WHO: Record<string, string> = { owner: "You", manager: "Manager", app: "The app" };

function Message({ m }: { m: ChatMessage }) {
  const mine = m.sender === "owner";
  const note = m.sender === "app";
  return (
    <Box style={{ alignSelf: note ? "center" : mine ? "flex-end" : "flex-start", maxWidth: note ? "100%" : "88%" }} data-sender={m.sender}>
      <Paper withBorder={!note} p={note ? 0 : "xs"} bg={mine ? "gray.0" : note ? "transparent" : "white"}>
        <Group gap={6} mb={2} justify={mine ? "flex-end" : "flex-start"}>
          <Text size="xs" fw={600} c={note ? "dimmed" : undefined}>
            {WHO[m.sender] ?? m.sender}
          </Text>
          <Text size="xs" c="dimmed" title={exact(m.at_ms)}>
            {ago(m.at_ms)}
          </Text>
          {mine && !m.delivered && (
            <Badge size="xs" color="warning" variant="light" data-marker="undelivered">
              {m.seq < 0 ? "Sending" : "Not delivered"}
            </Badge>
          )}
        </Group>
        <Text size="sm" c={note ? "dimmed" : undefined} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {m.text}
        </Text>
        {mine && m.error && (
          <Text size="xs" c="warning.8" mt={4}>
            {m.error}
          </Text>
        )}
      </Paper>
    </Box>
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
    <Paper withBorder p="sm" component="section" aria-labelledby="chat-title" h="100%">
      <Stack gap="sm" h="100%">
        <Group justify="space-between" gap="xs">
          <Title order={2} size="h4" id="chat-title">
            Manager
          </Title>
          {settings && (
            <Badge variant="light" color={settings.manager ? "primary" : settings.manager_error ? "warning" : "gray"}>
              {settings.manager ? "Running" : settings.manager_error ? "Not started" : "Starting"}
            </Badge>
          )}
        </Group>
        {settings?.manager_error && (
          <Alert color="warning" variant="light" icon={<IconAlertTriangle size={18} />} title="The manager isn't running yet">
            <Text size="xs">{settings.manager_error}</Text>
          </Alert>
        )}

        <ScrollArea.Autosize mah={{ base: 360, lg: "calc(100vh - 360px)" }} viewportRef={viewport} type="auto" aria-live="polite">
          {chat.isPending ? (
            <Loading label="Loading the chat" />
          ) : chat.isError ? (
            <LoadError what="The chat" error={chat.error} onRetry={() => void chat.refetch()} />
          ) : chat.data.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="md">
              No messages yet. Ask the manager to plan work, spec a task or explain the board.
            </Text>
          ) : (
            <Stack gap="xs" pr="xs">
              {chat.data.map((m) => (
                <Message key={m.seq} m={m} />
              ))}
            </Stack>
          )}
        </ScrollArea.Autosize>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Stack gap={6}>
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
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                Ctrl+Enter sends
              </Text>
              <Button type="submit" size="sm" rightSection={<IconSend size={14} />} disabled={!text.trim()}>
                Send
              </Button>
            </Group>
          </Stack>
        </form>
      </Stack>
    </Paper>
  );
}

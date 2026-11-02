// What the project's agents are waiting on the owner for (nest's asks): an approval of a held call,
// answered approve or deny, or a question, answered in words. Shown above the board while any is open.

import { Alert, Button, Group, Paper, Stack, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useAnswerAsk, useAsks } from "../../api/queries";
import type { Ask } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";

/** nest's approval: `{name, tool}` of the call it held (docs/agents/tools/#taint-and-sinks). */
function approvalOf(a: Ask): { name: string; tool: string | null } | null {
  const x = a.approval as { name?: unknown; tool?: unknown } | null;
  if (typeof x !== "object" || x === null || typeof x.name !== "string") return null;
  return { name: x.name, tool: typeof x.tool === "string" ? x.tool : null };
}

function AskItem({ projectId, ask }: { projectId: string; ask: Ask }) {
  const answer = useAnswerAsk(projectId);
  const [text, setText] = useState("");
  const approval = approvalOf(ask);
  const send = (a: string) => answer.mutate({ ask: ask.ask, answer: a });

  return (
    <Paper withBorder p="sm" bg="white" data-ask={ask.ask}>
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          {ask.role === "manager" ? "The manager" : ask.role === "worker" ? "A worker" : ask.role === "reviewer" ? "A reviewer" : "An agent"} ({ask.agent})
          {ask.task && (
            <>
              {" on "}
              <AnchorLink to="/projects/$projectId" params={{ projectId }} search={{ task: ask.task }} size="xs">
                {ask.task}
              </AnchorLink>
            </>
          )}
          {" · "}
          <span title={exact(ask.at_ms)}>{ago(ask.at_ms)}</span>
        </Text>
        {approval && (
          <Text size="sm">
            Wants to call <b>{approval.name}</b>
            {approval.tool && approval.tool !== approval.name ? ` (${approval.tool})` : ""}.
          </Text>
        )}
        {ask.question && (
          <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {ask.question}
          </Text>
        )}
        {approval ? (
          <Group gap="xs">
            <Button size="sm" color="success" leftSection={<IconCheck size={16} />} loading={answer.isPending && answer.variables?.answer === "approve"} disabled={answer.isPending} onClick={() => send("approve")}>
              Approve
            </Button>
            <Button size="sm" color="danger" leftSection={<IconX size={16} />} loading={answer.isPending && answer.variables?.answer === "deny"} disabled={answer.isPending} onClick={() => send("deny")}>
              Deny
            </Button>
          </Group>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) send(text.trim());
            }}
          >
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <Textarea style={{ flex: 1 }} size="sm" label="Your answer" autosize minRows={1} maxRows={6} maxLength={20000} value={text} onChange={(e) => setText(e.currentTarget.value)} />
              <Button type="submit" size="sm" loading={answer.isPending} disabled={!text.trim()}>
                Answer
              </Button>
            </Group>
          </form>
        )}
      </Stack>
    </Paper>
  );
}

export function AsksPanel({ projectId }: { projectId: string }) {
  const asks = useAsks(projectId);
  const open = (asks.data ?? []).filter((a) => a.answered_ms === null);
  if (open.length === 0) return null;
  return (
    <Alert
      color="warning"
      variant="light"
      icon={<IconAlertTriangle size={20} />}
      title={open.length === 1 ? "An agent is waiting for you" : `${open.length} agents' asks are waiting for you`}
      aria-live="polite"
    >
      <Stack gap="sm">
        {open.map((a) => (
          <AskItem key={a.ask} projectId={projectId} ask={a} />
        ))}
      </Stack>
    </Alert>
  );
}

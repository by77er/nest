// One of nest's asks in "Needs you" (NeedsYou.tsx): an approval of a held call, answered approve or
// deny, or a question, answered in words.

import { Button, Text, Textarea } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useAnswerAsk } from "../../api/queries";
import type { Ask } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, MetaItem, MetaRow, Prose, Row, Stack, Toolbar } from "../../layout";
import { RichMessage } from "../rich/RichMessage";

/** nest's approval: `{name, tool}` of the call it held (docs/agents/tools/#taint-and-sinks). */
export function approvalOf(a: Ask): { name: string; tool: string | null } | null {
  const x = a.approval as { name?: unknown; tool?: unknown } | null;
  if (typeof x !== "object" || x === null || typeof x.name !== "string") return null;
  return { name: x.name, tool: typeof x.tool === "string" ? x.tool : null };
}

export function AskItem({ projectId, ask }: { projectId: string; ask: Ask }) {
  const answer = useAnswerAsk(projectId);
  const [text, setText] = useState("");
  const approval = approvalOf(ask);
  const send = (a: string) => answer.mutate({ ask: ask.ask, answer: a });

  return (
    <Stack gap="sm" data-ask={ask.ask}>
      <MetaRow>
        <MetaItem>
          {ask.role === "manager" ? "The manager" : ask.role === "worker" ? "A worker" : ask.role === "reviewer" ? "A reviewer" : "An agent"}
        </MetaItem>
        <MetaItem mono>{ask.agent}</MetaItem>
        {ask.task && (
          <MetaItem>
            on{" "}
            <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: ask.task }} inherit ff="monospace">
              {ask.task}
            </AnchorLink>
          </MetaItem>
        )}
        <MetaItem title={exact(ask.at_ms)}>{ago(ask.at_ms)}</MetaItem>
      </MetaRow>
      {approval && (
        <Text fz="md">
          Wants to call <b>{approval.name}</b>
          {approval.tool && approval.tool !== approval.name ? ` (${approval.tool})` : ""}.
        </Text>
      )}
      {ask.question && (ask.role === "manager" ? <RichMessage text={ask.question} projectId={projectId} /> : <Prose>{ask.question}</Prose>)}
      {approval ? (
        <Toolbar align="start">
          <Button color="success" leftSection={<IconCheck size={icon.md} />} loading={answer.isPending && answer.variables?.answer === "approve"} disabled={answer.isPending} onClick={() => send("approve")}>
            Approve
          </Button>
          <Button color="danger" leftSection={<IconX size={icon.md} />} loading={answer.isPending && answer.variables?.answer === "deny"} disabled={answer.isPending} onClick={() => send("deny")}>
            Deny
          </Button>
        </Toolbar>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) send(text.trim());
          }}
        >
          <Row gap="sm" align="flex-end" wrap="nowrap">
            <Textarea flex={1} label="Your answer" autosize minRows={1} maxRows={6} maxLength={20000} value={text} onChange={(e) => setText(e.currentTarget.value)} />
            <Button type="submit" loading={answer.isPending} disabled={!text.trim()}>
              Answer
            </Button>
          </Row>
        </form>
      )}
    </Stack>
  );
}

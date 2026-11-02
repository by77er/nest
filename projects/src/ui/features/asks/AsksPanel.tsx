// What the project's agents are waiting on the owner for (nest's asks): an approval of a held call,
// answered approve or deny, or a question, answered in words. Shown above the board while any is open.

import { Button, Divider, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useAnswerAsk, useAsks } from "../../api/queries";
import type { Ask } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, Toolbar } from "../../layout";

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
      {ask.question && <Prose>{ask.question}</Prose>}
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

export function AsksPanel({ projectId }: { projectId: string }) {
  const asks = useAsks(projectId);
  const open = (asks.data ?? []).filter((a) => a.answered_ms === null);
  if (open.length === 0) return null;
  const title = open.length === 1 ? "An agent is waiting for you" : `${open.length} agents' asks are waiting for you`;
  return (
    <Panel tone="warning" role="alert" aria-label={title} aria-live="polite">
      <Section title={title} icon={IconAlertTriangle} iconColor="warning" region={false}>
        <Stack gap="lg">
          {open.map((a, i) => (
            <Stack key={a.ask} gap="lg">
              {i > 0 && <Divider />}
              <AskItem projectId={projectId} ask={a} />
            </Stack>
          ))}
        </Stack>
      </Section>
    </Panel>
  );
}

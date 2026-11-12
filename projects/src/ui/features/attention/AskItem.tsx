// One of nest's asks in "Needs you" (NeedsYou.tsx): an approval of a held call, answered approve or
// deny, or a question, answered in words.

import { Button, Text, Textarea } from "@mantine/core";
import { IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { useAnswerAsk } from "../../api/queries";
import type { Ask } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { ButtonBusy, icon, MetaItem, MetaRow, Prose, Row, Stack, Toolbar } from "../../layout";
import { RichMessage } from "../rich/RichMessage";

/** nest's approval: `{name, tool}` of the call it held (docs/agents/tools/#taint-and-sinks). */
export function approvalOf(a: Ask): { name: string; tool: string | null } | null {
  const x = a.approval as { name?: unknown; tool?: unknown } | null;
  if (typeof x !== "object" || x === null || typeof x.name !== "string") return null;
  return { name: x.name, tool: typeof x.tool === "string" ? x.tool : null };
}

/**
 * `onSettled`: the answer was taken (`answered`) or refused as no longer open (`gone`: answered elsewhere, or
 * its agent ended); either way the item leaves. A failure otherwise keeps it, and is announced as one.
 */
export function AskItem({ projectId, ask, onSettled }: { projectId: string; ask: Ask; onSettled?: (how: "answered" | "gone") => void }) {
  const answer = useAnswerAsk(projectId, onSettled);
  const [text, setText] = useState("");
  const approval = approvalOf(ask);
  const pending = answer.isPending;
  // While one is out, the buttons stay focusable (`aria-disabled`, not `disabled`), so focus isn't lost; a press does nothing.
  const send = (a: string) => {
    if (pending) return;
    answer.mutate({ ask: ask.ask, answer: a });
  };
  const busy = (which: string) => (pending && answer.variables?.answer === which ? <ButtonBusy /> : null);

  return (
    <Stack gap="sm" data-ask={ask.ask}>
      <MetaRow>
        <MetaItem>
          {/* One that isn't the manager any more (README.md#the-manager-lifecycle) is said to be the previous one. */}
          {ask.role === "manager" ? (ask.previous ? "The previous manager" : "The manager") : ask.role === "worker" ? "A worker" : ask.role === "reviewer" ? "A reviewer" : "An agent"}
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
      {/* The manager's own question renders rich; a previous manager's is plain text, as any other agent's. */}
      {ask.question && (ask.role === "manager" && !ask.previous ? <RichMessage text={ask.question} projectId={projectId} /> : <Prose>{ask.question}</Prose>)}
      {approval ? (
        <Toolbar align="start">
          <Button color="success" leftSection={busy("approve") ?? <IconCheck size={icon.md} />} aria-disabled={pending || undefined} aria-busy={busy("approve") ? true : undefined} data-pending={pending || undefined} onClick={() => send("approve")}>
            Approve
          </Button>
          <Button color="danger" leftSection={busy("deny") ?? <IconX size={icon.md} />} aria-disabled={pending || undefined} aria-busy={busy("deny") ? true : undefined} data-pending={pending || undefined} onClick={() => send("deny")}>
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
            <Button type="submit" leftSection={pending ? <ButtonBusy /> : undefined} aria-disabled={pending || undefined} aria-busy={pending || undefined} data-pending={pending || undefined} disabled={!text.trim()}>
              Answer
            </Button>
          </Row>
        </form>
      )}
    </Stack>
  );
}

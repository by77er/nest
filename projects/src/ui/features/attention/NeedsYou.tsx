// "Needs you": everything in the project waiting on the owner, in one calm panel above the board:
// agents' asks (approvals and questions, nest's), blocked tasks (README.md#blocked), agents' requests
// for secrets, reviews held for approval (README.md#the-review-gate), and the repo's issues waiting for
// triage (one line, linking to Triage), oldest first.
// A warning rule and title mark it; the panel itself is the surface, so it leads without shouting.

import { Button, Collapse, Divider, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useState } from "react";
import { useAnswerBlocked, useAttention, useProject } from "../../api/queries";
import type { Attention } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, weight } from "../../layout";
import { motion } from "../../theme";
import { HeldReviewItem } from "../reviews/HeldReview";
import { RichMessage } from "../rich/RichMessage";
import { AskItem } from "./AskItem";
import { SecretRequestItem } from "./SecretRequestItem";

type BlockedItem = Extract<Attention, { kind: "blocked" }>;

function BlockedTask({ projectId, item }: { projectId: string; item: BlockedItem }) {
  const answer = useAnswerBlocked(projectId);
  const [text, setText] = useState("");
  return (
    <Stack gap="sm" data-blocked={item.task}>
      <MetaRow>
        <MetaItem>{item.role === "manager" ? "The manager" : "A worker"}</MetaItem>
        <MetaItem mono>{item.by}</MetaItem>
        <MetaItem>
          blocked{" "}
          <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: item.task }} inherit>
            {item.title}
          </AnchorLink>
        </MetaItem>
        <MetaItem title={exact(item.at_ms)}>{ago(item.at_ms)}</MetaItem>
      </MetaRow>
      {item.role === "manager" ? <RichMessage text={item.reason} projectId={projectId} /> : <Prose>{item.reason}</Prose>}
      {item.question && (
        <Text fz="md" fw={weight.medium}>
          {item.question}
        </Text>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) answer.mutate({ task: item.task, answer: text.trim() });
        }}
      >
        <Row gap="sm" align="flex-end" wrap="nowrap">
          <Textarea
            flex={1}
            label="Your answer"
            description={item.role === "worker" ? "Goes to the worker and the manager" : "Goes to the manager"}
            autosize
            minRows={1}
            maxRows={6}
            maxLength={20000}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <Button type="submit" loading={answer.isPending} disabled={!text.trim()}>
            Answer
          </Button>
        </Row>
      </form>
    </Stack>
  );
}

/** How many items show before "Show all": enough to act on, without pushing the board below the fold. */
export const SHOWN = 3;

function Item({ projectId, x, first, explain }: { projectId: string; x: Attention; first: boolean; explain: boolean }) {
  const project = useProject(projectId);
  return (
    <Stack gap="lg">
      {!first && <Divider />}
      {x.kind === "ask" ? <AskItem projectId={projectId} ask={x} /> : x.kind === "blocked" ? <BlockedTask projectId={projectId} item={x} />
        : x.kind === "review" ? <HeldReviewItem projectId={projectId} repo={project.data?.repo} item={x} full={explain} />
        : x.kind === "triage" ? <TriageItem projectId={projectId} count={x.count} at_ms={x.at_ms} /> : <SecretRequestItem projectId={projectId} item={x} />}
    </Stack>
  );
}

const keyOf = (x: Attention) => (x.kind === "ask" ? x.ask : x.kind === "blocked" ? `blocked-${x.task}` : x.kind === "triage" ? "triage" : x.kind === "review" ? `review-${x.pr}-${x.sha}` : x.id);

/** The repo's issues waiting for triage: how many, since when, and the way to them (README.md#triage). */
function TriageItem({ projectId, count, at_ms }: { projectId: string; count: number; at_ms: number }) {
  return (
    <Stack gap="sm" data-triage>
      <MetaRow>
        <MetaItem>The repo's issues</MetaItem>
        <MetaItem title={exact(at_ms)}>oldest {ago(at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md">
        {count === 1 ? "1 issue waits" : `${count} issues wait`} for triage: accept it as a draft task, or decline it.
      </Text>
      <Row>
        <Button variant="default" renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/triage" params={{ projectId }} />}>
          Open Triage
        </Button>
      </Row>
    </Stack>
  );
}

export function NeedsYou({ projectId }: { projectId: string }) {
  const attention = useAttention(projectId);
  const [all, setAll] = useState(false);
  // Oldest first, as the Worker answers; the rest behind "Show all", collapsing in 180 ms.
  const items = [...(attention.data ?? [])].sort((a, b) => a.at_ms - b.at_ms);
  if (items.length === 0) return null;
  // The held reviews' explanation is said once, on the first of them.
  const firstHeld = items.find((x) => x.kind === "review");
  const shown = items.slice(0, SHOWN);
  const rest = items.slice(SHOWN);
  return (
    <Panel tone="warning" component="section" aria-label="Needs you" aria-live="polite">
      <Section title="Needs you" count={items.length} icon={IconAlertTriangle} iconColor="warning" region={false}>
        <Stack gap="lg">
          {shown.map((x, i) => (
            <Item key={keyOf(x)} projectId={projectId} x={x} first={i === 0} explain={x === firstHeld} />
          ))}
          {rest.length > 0 && (
            <>
              <Collapse expanded={all} transitionDuration={motion.base} id={`needs-you-rest-${projectId}`}>
                <Stack gap="lg">
                  {rest.map((x) => (
                    <Item key={keyOf(x)} projectId={projectId} x={x} first={false} explain={x === firstHeld} />
                  ))}
                </Stack>
              </Collapse>
              <Row>
                <Button variant="subtle" color="gray" onClick={() => setAll((a) => !a)} aria-expanded={all} aria-controls={`needs-you-rest-${projectId}`}>
                  {all ? "Show fewer" : `Show all (${items.length})`}
                </Button>
              </Row>
            </>
          )}
        </Stack>
      </Section>
    </Panel>
  );
}

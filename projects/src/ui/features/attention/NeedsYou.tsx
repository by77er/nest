// "Needs you": everything in the project waiting on the owner, in one calm panel above the board:
// agents' asks (approvals and questions, nest's), blocked tasks (README.md#blocked), agents' requests
// for secrets, reviews held for approval (README.md#the-review-gate), and the repo's issues waiting for
// triage (one line, linking to Triage), oldest first.
// A warning rule and title mark it; the panel itself is the surface, so it leads without shouting.

import { Button, Collapse, Divider, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAnswerBlocked, useAttention, useNeedsYouList, useProject } from "../../api/queries";
import type { Waiting } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, weight } from "../../layout";
import { motion } from "../../theme";
import { HeldReviewItem } from "../reviews/HeldReview";
import { RichMessage } from "../rich/RichMessage";
import { triageSource, triageWaits } from "../triage/words";
import { AskItem } from "./AskItem";
import { SecretRequestItem } from "./SecretRequestItem";

type BlockedItem = Extract<Waiting, { kind: "blocked" }>;

function BlockedTask({ projectId, item, onAnswered }: { projectId: string; item: BlockedItem; onAnswered: () => void }) {
  const answer = useAnswerBlocked(projectId, onAnswered);
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

function Item({ projectId, x, first, explain, onFocus, onAskSettled }: { projectId: string; x: Waiting; first: boolean; explain: boolean; onFocus: () => void; onAskSettled: (how: "answered" | "gone") => void }) {
  const project = useProject(projectId);
  return (
    <Stack gap="lg" data-key={keyOf(x)} onFocusCapture={onFocus}>
      {!first && <Divider />}
      {x.kind === "ask" ? <AskItem projectId={projectId} ask={x} onSettled={onAskSettled} /> : x.kind === "blocked" ? <BlockedTask projectId={projectId} item={x} onAnswered={() => onAskSettled("answered")} />
        : x.kind === "review_backlog" ? <ReviewBacklogItem count={x.count} at_ms={x.at_ms} />
        : x.kind === "review" ? <HeldReviewItem projectId={projectId} repo={project.data?.repo} item={x} full={explain} />
        : x.kind === "triage" ? <TriageItem projectId={projectId} issues={x.count} proposals={x.proposals} at_ms={x.at_ms} /> : <SecretRequestItem projectId={projectId} item={x} />}
    </Stack>
  );
}

const keyOf = (x: Waiting) => (x.kind === "ask" ? x.ask : x.kind === "blocked" ? `blocked-${x.task}` : x.kind === "triage" ? "triage" : x.kind === "review" ? `review-${x.pr}-${x.sha}` : x.kind === "review_backlog" ? "review-backlog" : x.id);

/** PRs past the review queue's limits, with no job yet: how many, and what frees them (README.md#the-review-gate). */
function ReviewBacklogItem({ count, at_ms }: { count: number; at_ms: number }) {
  return (
    <Stack gap="sm" data-review-backlog>
      <MetaRow>
        <MetaItem>The review queue</MetaItem>
        <MetaItem title={exact(at_ms)}>oldest {ago(at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md">
        {count === 1 ? "1 more pull request waits" : `${count} more pull requests wait`} beyond the queue's limit, with no review yet. They are listed as you approve or dismiss the ones waiting.
      </Text>
    </Stack>
  );
}

/** What waits for triage, the repo's issues and routines' proposed tasks: how many, since when, and the way to them (README.md#triage). */
function TriageItem({ projectId, issues, proposals, at_ms }: { projectId: string; issues: number; proposals: number; at_ms: number }) {
  return (
    <Stack gap="sm" data-triage>
      <MetaRow>
        <MetaItem>{triageSource(issues, proposals)}</MetaItem>
        <MetaItem title={exact(at_ms)}>oldest {ago(at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md">
        {triageWaits(issues, proposals)} for triage: accept {issues + proposals === 1 ? "it" : "each"} as a draft task, or decline it.
      </Text>
      <Row>
        <Button variant="default" renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/triage" params={{ projectId }} />}>
          Open Triage
        </Button>
      </Row>
    </Stack>
  );
}

/** What the item that had focus leaves it to: the next item's first control (or the one before), else the heading. */
function refocus(panel: HTMLElement | null, heading: HTMLElement | null, prev: readonly string[], now: readonly string[], lost: string): void {
  const active = document.activeElement;
  if (active && active !== document.body && panel?.contains(active)) return; // focus is still somewhere in the panel
  const at = prev.indexOf(lost);
  const next = prev.slice(at + 1).find((k) => now.includes(k)) ?? prev.slice(0, at).reverse().find((k) => now.includes(k));
  const target = next ? panel?.querySelector<HTMLElement>(`[data-key="${next}"] :is(button, textarea, a[href])`) : null;
  target?.focus();
  if (!target || document.activeElement !== target) heading?.focus();
}

export function NeedsYou({ projectId }: { projectId: string }) {
  const attention = useAttention(projectId);
  const list = useNeedsYouList(projectId);
  const [all, setAll] = useState(false);
  // What the owner's last answer here came to: a note for an ask answered elsewhere meanwhile (cleared once a
  // read has come and gone after the one that dropped it); and once they've answered one, the panel stays
  // (saying nothing else waits) so focus has somewhere to go.
  const [note, setNote] = useState<{ text: string; reads: number } | null>(null);
  const [answered, setAnswered] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<string | null>(null);
  // Oldest first, as the Worker answers; the rest behind "Show all", collapsing in 180 ms.
  const items = [...list.items].sort((a, b) => a.at_ms - b.at_ms);
  const keys = items.map(keyOf);
  const shownKeys = useRef<string[]>(keys);
  // An item that had focus left (answered, or gone): focus goes on from where it was, never to the page.
  useLayoutEffect(() => {
    const prev = shownKeys.current;
    shownKeys.current = keys;
    const lost = focused.current;
    if (lost && prev.includes(lost) && !keys.includes(lost)) {
      focused.current = null;
      refocus(panel.current, heading.current, prev, keys, lost);
    }
  });
  // Each read after the note counts: the re-read that drops the ask, then a poll; after that the note goes.
  const readAt = attention.dataUpdatedAt;
  const lastRead = useRef(readAt);
  useEffect(() => {
    if (readAt === lastRead.current) return;
    lastRead.current = readAt;
    setNote((n) => (n === null ? null : n.reads >= 1 ? null : { ...n, reads: n.reads + 1 }));
  }, [readAt]);
  const settled = (how: "answered" | "gone") => {
    setAnswered(true);
    setNote(how === "gone" ? { text: "Already answered: it was answered elsewhere, or its agent ended.", reads: 0 } : null);
  };
  const whole = list.asks === "read";
  // Nothing to show yet, or nothing waits: no panel. Reading with the app's own items, it shows them, saying the asks are to come.
  if (items.length === 0 && !answered && !list.stale && (whole || list.asks === "reading")) return null;
  // The held reviews' explanation is said once, on the first of them.
  const firstHeld = items.find((x) => x.kind === "review");
  const shown = items.slice(0, SHOWN);
  const rest = items.slice(SHOWN);
  const item = (x: Waiting, first: boolean) => (
    <Item key={keyOf(x)} projectId={projectId} x={x} first={first} explain={x === firstHeld} onFocus={() => (focused.current = keyOf(x))} onAskSettled={settled} />
  );
  return (
    <Panel ref={panel} tone="warning" component="section" aria-label="Needs you" aria-live="polite">
      {/* A count only for a whole list: the app's own items alone aren't all that waits. */}
      <Section title="Needs you" count={whole ? items.length : undefined} icon={IconAlertTriangle} iconColor="warning" region={false} headingRef={heading}>
        <Stack gap="lg">
          {list.asks === "reading" && (
            <Text fz="sm" c="dimmed" data-asks-reading>
              Reading the agents' asks…
            </Text>
          )}
          {/* The asks couldn't be read: what's listed is the rest, and the next poll tries again. */}
          {list.asks === "unavailable" && (
            <Text fz="sm" c="dimmed" data-asks-unavailable>
              The agents' asks couldn't be read, so any they have aren't listed here. Trying again.
            </Text>
          )}
          {list.stale && (
            <Text fz="sm" c="dimmed" data-stale title={exact(list.readAt)}>
              Couldn't refresh; showing what was read {ago(list.readAt)}. Trying again.
            </Text>
          )}
          {note !== null && (
            <Text fz="sm" c="dimmed" role="status" data-note>
              {note.text}
            </Text>
          )}
          {items.length === 0 && whole && (
            <Text fz="sm" c="dimmed">
              Nothing else waits on you.
            </Text>
          )}
          {shown.map((x, i) => item(x, i === 0))}
          {rest.length > 0 && (
            <>
              <Collapse expanded={all} transitionDuration={motion.base} id={`needs-you-rest-${projectId}`}>
                <Stack gap="lg">{rest.map((x) => item(x, false))}</Stack>
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

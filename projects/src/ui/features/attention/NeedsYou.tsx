// "Needs you": everything in the project waiting on the owner, in one calm panel above the board:
// agents' asks (approvals and questions, nest's), blocked tasks (README.md#blocked), agents' requests
// for secrets, reviews held for approval (README.md#the-review-gate), and the repo's issues waiting for
// triage (one line, linking to Triage), oldest first.
// A warning rule and title mark it; the panel itself is the surface, so it leads without shouting.

import { Button, Collapse, Divider, Text, Textarea, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Fragment, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAnswerBlocked, useAttention, useDismissCommentsCleared, useNeedsYouList, useProject } from "../../api/queries";
import type { Waiting } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { ago, clock, exact } from "../../common/time";
import { ButtonBusy, MetaItem, MetaRow, Panel, Prose, Row, Section, Stack, weight } from "../../layout";
import { motion } from "../../theme";
import { HeldReviewItem } from "../reviews/HeldReview";
import { RichMessage } from "../rich/RichMessage";
import { commentsCleared, triageSource, triageWaits } from "../triage/words";
import { useNeedsYou } from "../shell/attention";
import { approvalOf, AskItem } from "./AskItem";
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

function Item({ projectId, x, first, explain, onFocus, onAskSettled }: { projectId: string; x: Waiting; first: boolean; explain: boolean; onFocus: (e: React.FocusEvent) => void; onAskSettled: (how: "answered" | "gone") => void }) {
  const project = useProject(projectId);
  return (
    <Stack gap="lg" data-key={keyOf(x)} onFocusCapture={onFocus}>
      {!first && <Divider />}
      {x.kind === "ask" ? <AskItem projectId={projectId} ask={x} onSettled={onAskSettled} /> : x.kind === "blocked" ? <BlockedTask projectId={projectId} item={x} onAnswered={() => onAskSettled("answered")} />
        : x.kind === "review_backlog" ? <ReviewBacklogItem count={x.count} at_ms={x.at_ms} />
        : x.kind === "review" ? <HeldReviewItem projectId={projectId} repo={project.data?.repo} item={x} full={explain} />
        : x.kind === "triage" ? <TriageItem projectId={projectId} issues={x.count} proposals={x.proposals} at_ms={x.at_ms} />
        : x.kind === "comments_cleared" ? <CommentsClearedItem projectId={projectId} item={x} onDone={() => onAskSettled("answered")} /> : <SecretRequestItem projectId={projectId} item={x} />}
    </Stack>
  );
}

const keyOf = (x: Waiting) => (x.kind === "ask" ? x.ask : x.kind === "blocked" ? `blocked-${x.task}` : x.kind === "triage" ? "triage" : x.kind === "review" ? `review-${x.pr}-${x.sha}` : x.kind === "review_backlog" ? "review-backlog" : x.kind === "comments_cleared" ? "comments-cleared" : x.id);

type CommentsCleared = Extract<Waiting, { kind: "comments_cleared" }>;

/**
 * The default PR comments user cleared because the repo's owner is another account now (README.md#pr-comments):
 * nobody's comments count until the owner chooses in Settings, or leaves it so (`onDone`: before the item
 * leaves the list, so focus goes on from it as from an answered block).
 */
function CommentsClearedItem({ projectId, item, onDone }: { projectId: string; item: CommentsCleared; onDone: () => void }) {
  const dismiss = useDismissCommentsCleared(projectId, onDone);
  const pending = dismiss.isPending;
  // While it's out, the button stays focusable (`aria-disabled`, not `disabled`), so focus isn't lost; a press does nothing.
  const leave = () => {
    if (!pending) dismiss.mutate();
  };
  return (
    <Stack gap="sm" data-comments-cleared>
      <MetaRow>
        <MetaItem>PR comments</MetaItem>
        <MetaItem title={exact(item.at_ms)}>{ago(item.at_ms)}</MetaItem>
      </MetaRow>
      <Text fz="md">{commentsCleared(item)}.</Text>
      <Text fz="sm" c="dimmed">
        It was only the default from when the repo was attached. Until you choose someone, nobody's PR comments reach workers, and nobody is trusted as the comments user for reviews and triage.
      </Text>
      <Row>
        <Button variant="default" renderRoot={(props) => <AnchorLink {...props} to="/projects/$projectId/settings" params={{ projectId }} hash="pr-comments" />}>
          Choose someone…
        </Button>
        <Button variant="subtle" color="gray" leftSection={pending ? <ButtonBusy /> : undefined} aria-disabled={pending || undefined} aria-busy={pending || undefined} data-pending={pending || undefined} onClick={leave}>
          Leave it unset
        </Button>
      </Row>
    </Stack>
  );
}

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

/** What the item that had focus leaves it to: the next item's first control (or the one before), else `fallback`. */
function refocus(panel: HTMLElement | null, fallback: HTMLElement | null, prev: readonly string[], now: readonly string[], lost: string): HTMLElement | null {
  const active = document.activeElement;
  if (active && active !== document.body && panel?.contains(active)) return active as HTMLElement; // still somewhere in the panel
  const at = prev.indexOf(lost);
  const next = prev.slice(at + 1).find((k) => now.includes(k)) ?? prev.slice(0, at).reverse().find((k) => now.includes(k));
  const target = next ? panel?.querySelector<HTMLElement>(`[data-key="${next}"] :is(button, textarea, a[href])`) : null;
  target?.focus();
  if (target && document.activeElement === target) return target;
  fallback?.focus();
  return fallback;
}

/** What an ask was, for a note about it: the call it held, or its question. */
function askName(x: Waiting): string {
  if (x.kind !== "ask") return "it";
  const a = approvalOf(x);
  return a ? `the call to ${a.name}` : "the question";
}

/** How long the panel waits before saying the asks are still being read (a fast read shows nothing in between). */
const READING_DELAY_MS = 300;

/**
 * "Needs you" above the board. `after`: the board's heading, where focus goes once the panel has nothing
 * left to hold it (the owner answered the last item), with an announcement in a live region outside it.
 */
export function NeedsYou({ projectId, after, shownBeforeAsks = false }: { projectId: string; after?: RefObject<HTMLElement | null>; shownBeforeAsks?: boolean }) {
  const attention = useAttention(projectId);
  const list = useNeedsYouList(projectId);
  // The projects list's count (the sidebar's): when it's more than what's here while the asks are read, the
  // panel shows (saying so) rather than appear only once nest answers.
  const listed = useNeedsYou(projectId);
  const [all, setAll] = useState(false);
  // An ask answered elsewhere meanwhile: a note where it was, naming it, until the next poll or focus moves on.
  const [note, setNote] = useState<{ text: string; at: number; reads: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [late, setLate] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focused = useRef<string | null>(null);
  const landed = useRef<HTMLElement | null>(null);
  // Oldest first, as the Worker answers; the rest behind "Show all", collapsing in 180 ms.
  const items = [...list.items].sort((a, b) => a.at_ms - b.at_ms);
  const keys = items.map(keyOf);
  const shownKeys = useRef<string[]>(keys);
  const whole = list.asks === "read";
  // Something to show: items, a note, the asks unknown (unreadable, or a stale read), or, while they're read,
  // more waiting than the app's own items (the sidebar's count says so) once the read has taken a moment.
  // Whether more waits than the app's own items: the sidebar's count says (unknown: maybe); before it's read,
  // only a page shown ahead of the asks (a cold load past its budget) assumes so.
  const moreWaits = listed === undefined ? shownBeforeAsks : listed === null || listed > items.length;
  const reading = list.asks === "reading" && (items.length > 0 || ((late || shownBeforeAsks) && moreWaits));
  const shows = items.length > 0 || note !== null || list.asks === "unavailable" || list.stale || reading;
  // Counted afresh for each project (the same panel shows another's when the route changes).
  useEffect(() => {
    setLate(false);
    if (list.asks !== "reading") return;
    const t = setTimeout(() => setLate(true), READING_DELAY_MS);
    return () => clearTimeout(t);
  }, [list.asks, projectId]);
  // An item that had focus left (answered, or gone): focus goes on from where it was, never to the page; with
  // nothing left in the panel, to the board's heading, and that's said.
  useLayoutEffect(() => {
    const prev = shownKeys.current;
    shownKeys.current = keys;
    const lost = focused.current;
    if (lost && prev.includes(lost) && !keys.includes(lost)) {
      focused.current = null;
      const gone = !shows;
      landed.current = refocus(panel.current, gone ? (after?.current ?? null) : heading.current, prev, keys, lost);
      if (gone) setAnnounce("Answered; nothing else waits on you.");
    } else if (!shows && panel.current === null && document.activeElement === document.body && landed.current?.closest?.("[data-needs-you]")) {
      // The panel went with focus on its heading (its last note cleared): on to the board's.
      after?.current?.focus();
      landed.current = after?.current ?? null;
    }
  });
  // The note goes at the read after the one that dropped its ask (the next poll).
  const readAt = attention.dataUpdatedAt;
  const lastRead = useRef(readAt);
  useEffect(() => {
    if (readAt === lastRead.current) return;
    lastRead.current = readAt;
    setNote((n) => (n === null ? null : n.reads >= 1 ? null : { ...n, reads: n.reads + 1 }));
  }, [readAt]);
  const settled = (x: Waiting, how: "answered" | "gone") => {
    setAnnounce("");
    setNote(how === "gone" ? { text: `Already answered: ${askName(x)} was answered elsewhere, or its agent ended.`, at: Math.max(0, keys.indexOf(keyOf(x))), reads: 0 } : null);
  };
  // Focus moving on from where it landed clears the note.
  const moved = (e: React.FocusEvent) => {
    if (note !== null && landed.current !== null && e.target !== landed.current) setNote(null);
  };
  const live = (
    <VisuallyHidden role="status" aria-live="polite" data-announce>
      {announce}
    </VisuallyHidden>
  );
  if (!shows) return live;
  // The held reviews' explanation is said once, on the first of them.
  const firstHeld = items.find((x) => x.kind === "review");
  const noteAt = note === null ? -1 : Math.min(note.at, items.length);
  const row = (x: Waiting, i: number) => (
    <Fragment key={keyOf(x)}>
      {i === noteAt && <Note text={note!.text} first={i === 0} />}
      <Item projectId={projectId} x={x} first={i === 0 && noteAt !== 0} explain={x === firstHeld} onFocus={(e) => {
        focused.current = keyOf(x);
        moved(e);
      }} onAskSettled={(how) => settled(x, how)} />
    </Fragment>
  );
  const shown = items.slice(0, SHOWN);
  const rest = items.slice(SHOWN);
  // A count only for a whole list; unknown ("?") while the asks are read or can't be; none for a note alone.
  // A stale read's count is unknown now too ("?", as the sidebar's): the stale line says what was read and when.
  // The warning tone only when something waits, or might (the asks unknown); not while a cold load's read is out
  // with nothing known yet (the sidebar's count unread): then the panel only holds the space.
  const warn = items.length > 0 || list.stale || (!whole && !(list.asks === "reading" && listed === undefined));
  const count = items.length === 0 && whole && !list.stale ? undefined : whole && !list.stale ? items.length : null;
  return (
    <>
      {live}
      <Panel ref={panel} tone={warn ? "warning" : "default"} component="section" aria-label="Needs you" aria-live="polite" data-needs-you>
        <Section title="Needs you" count={count} icon={warn ? IconAlertTriangle : undefined} iconColor="warning" region={false} headingRef={heading}>
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
                Couldn't refresh; showing what was read at {clock(list.readAt)}. Trying again.
              </Text>
            )}
            {shown.map((x, i) => row(x, i))}
            {noteAt >= shown.length && noteAt >= items.length && <Note text={note!.text} first={items.length === 0} />}
            {rest.length > 0 && (
              <>
                <Collapse expanded={all} transitionDuration={motion.base} id={`needs-you-rest-${projectId}`}>
                  <Stack gap="lg">{rest.map((x, j) => row(x, SHOWN + j))}</Stack>
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
    </>
  );
}

/** The note where an ask answered elsewhere was. */
function Note({ text, first }: { text: string; first: boolean }) {
  return (
    <Stack gap="lg">
      {!first && <Divider />}
      <Text fz="sm" c="dimmed" role="status" data-note>
        {text}
      </Text>
    </Stack>
  );
}

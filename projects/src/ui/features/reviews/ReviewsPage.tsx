// A project's reviews: every review job ReviewDO knows, newest first, with its PR, where it is, and the
// verdict once there is one: each reviewer's dimensions, grouped by reviewer when there are several. Read-only, but for a review held for the owner's approval
// (README.md#the-review-gate), which is approved or dismissed here. A table, or below `sm` a card per review (its
// PR and title, its sha, its state, its verdicts, when, and its trace), so nothing starts off screen. Under
// them, the project's reviewers (ReviewersSection); while none is on, a warning at the top says so too.

import { Anchor, Badge, Button, Table, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronRight, IconShieldCheck, IconX } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { Fragment, type ReactNode, useRef, useState } from "react";
import { useReviewers, useReviews } from "../../api/queries";
import type { Job, Review, Verdict } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Notice, Panel, Row, Section, Stack, TableFrame, Token, TriggerBadge, usePhone, weight } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { ProjectFrame } from "../project/ProjectFrame";
import { ReviewTrace } from "../trace/AgentTraces";
import { HeldActions, heldFrom } from "./HeldReview";
import { NONE_ON, ReviewersSection } from "./ReviewersSection";

/** Whether a verdict failed: any dimension of any review (src/reviewers.ts's `verdictPassed`, negated). */
const failed = (v: Verdict) => v.reviews.length === 0 || v.reviews.some((r) => r.dimensions.length === 0 || r.dimensions.some((d) => d.verdict !== "pass"));

/** Whether a job is done with a verdict that failed: "Changes needed", here and on a task's PRs. */
export const changesNeeded = (job: Job) => job.state === "done" && job.verdict !== null && failed(job.verdict);

/** Reviews waiting for the owner's approval first (the longest waiting on top), then those waiting their turn, then the rest, newest first. */
export function byHeldThenNewest(a: Job, b: Job): number {
  const rank = (j: Job) => (j.state === "held" ? 0 : j.state === "overflow" ? 1 : 2);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return rank(a) < 2 ? a.created_ms - b.created_ms : b.updated_ms - a.updated_ms;
}

/** A review job's state, or "Changes needed" for a verdict that failed a dimension (also on a task's PRs). */
export function JobState({ job, size = "md" }: { job: Job; size?: "sm" | "md" }) {
  const s = changesNeeded(job) ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
  return (
    <Badge color={s.color} variant="light" size={size} data-state={job.state}>
      {s.label}
    </Badge>
  );
}

function TaintedBadge() {
  return (
    <Badge size="sm" variant="outline" color="gray">
      Tainted
    </Badge>
  );
}

/** One review's dimensions as badges that open their notes; `who` names its reviewer when there are several. */
function DimensionBadges({ review, who, children }: { review: Review; who?: string; children?: ReactNode }) {
  return (
    // Wrapping into rows: a 44 px pitch between rows on touch.
    <Row gap="xs" data-touch-pitch>
      {review.dimensions.map((d) => {
        // Pass and fail are status: their roles, and an icon each, so color isn't the only cue.
        const pass = d.verdict === "pass";
        return (
          <Tooltip key={d.name} label={d.notes || d.name} multiline maw="var(--nest-side-panel)">
            <TriggerBadge
              size="sm"
              variant="light"
              color={pass ? "success" : "danger"}
              leftSection={pass ? <IconCheck size={icon.sm} aria-hidden /> : <IconX size={icon.sm} aria-hidden />}
              aria-label={`${who ? `${who}, ` : ""}${d.name}: ${pass ? "passed" : "failed"}`}
              data-verdict={pass ? "pass" : "fail"}
            >
              {d.name}
            </TriggerBadge>
          </Tooltip>
        );
      })}
      {children}
    </Row>
  );
}

/**
 * The verdict: one reviewer's dimension badges, or with several, each reviewer's name over its own. With one,
 * `tainted` (the table's) puts Tainted after its badges, and a card puts it on its state row; with several,
 * Tainted always follows the badges of the review whose session was, so it says whose.
 */
function Verdicts({ job, tainted = true, projectId }: { job: Job; tainted?: boolean; projectId: string }) {
  // Waiting for the owner (held, or past the cap on held ones), or dismissed by them: who it's from, and what the owner can do.
  if (job.state === "held" || job.state === "overflow" || job.state === "dismissed") {
    const why = job.state === "held" ? "Its review waits for your approval." : job.state === "overflow" ? "It waits its turn: too many reviews wait for your approval." : "You dismissed its review.";
    return (
      <Stack gap="sm">
        <Text fz="sm" c="dimmed">
          {heldFrom(job)}. {why}
        </Text>
        <HeldActions projectId={projectId} held={job} dismiss={job.state === "held"} primary={job.state === "held"} />
      </Stack>
    );
  }
  if (!job.verdict) return <Text fz="sm" c="dimmed">{job.error ?? "No verdict yet"}</Text>;
  const reviews = job.verdict.reviews;
  if (reviews.length === 1) {
    return <DimensionBadges review={reviews[0]!}>{tainted && reviews[0]!.tainted && <TaintedBadge />}</DimensionBadges>;
  }
  return (
    <Stack gap="sm">
      {reviews.map((r) => (
        <Stack key={r.reviewer.id} gap="2xs" data-reviewer={r.reviewer.id}>
          <Text fz="xs" c="dimmed" fw={weight.medium}>
            {r.reviewer.name}
          </Text>
          <DimensionBadges review={r} who={r.reviewer.name}>
            {r.tainted && <TaintedBadge />}
          </DimensionBadges>
        </Stack>
      ))}
    </Stack>
  );
}

function PrTitle({ repo, j }: { repo: string; j: Job }) {
  return (
    <Stack gap="2xs">
      <Anchor href={`https://github.com/${repo}/pull/${j.pr}`} target="_blank" rel="noreferrer" fz="sm" fw={weight.medium}>
        #{j.pr} {j.title ?? ""}
      </Anchor>
      <Text fz="xs" c="dimmed" ff="monospace">
        {j.sha.slice(0, 7)}
        {j.base ? ` → ${j.base}` : ""}
      </Text>
    </Stack>
  );
}

/** Show or Hide its trace; in a card, where no column heading says what, "Show trace" / "Hide trace". */
function TraceToggle({ j, open, onToggle, long = false }: { j: Job; open: boolean; onToggle: () => void; long?: boolean }) {
  return (
    <Button
      variant="subtle"
      color="gray"
      size="xs"
      leftSection={open ? <IconChevronDown size={icon.sm} /> : <IconChevronRight size={icon.sm} />}
      aria-expanded={open}
      aria-label={`${open ? "Hide" : "Show"} the trace of #${j.pr}`}
      onClick={onToggle}
    >
      {open ? "Hide" : "Show"}
      {long ? " trace" : ""}
    </Button>
  );
}

/** Below `sm`: a review as a card, top to bottom, its trace under it when open. */
function ReviewCard({ projectId, repo, j, open, onToggle }: { projectId: string; repo: string; j: Job; open: boolean; onToggle: () => void }) {
  const key = `${j.pr}/${j.sha}`;
  return (
    <Panel dense>
      <Stack gap="sm" role="listitem" data-job={key}>
        <PrTitle repo={repo} j={j} />
        <Row gap="sm">
          <JobState job={j} />
          {j.tainted && (j.verdict?.reviews.length ?? 0) < 2 && <TaintedBadge />}
        </Row>
        <Verdicts job={j} tainted={false} projectId={projectId} />
        <Row justify="space-between" wrap="nowrap">
          <MetaRow>
            <MetaItem>
              {j.runs} {j.runs === 1 ? "run" : "runs"}
            </MetaItem>
            <MetaItem title={exact(j.updated_ms)}>Updated {ago(j.updated_ms)}</MetaItem>
          </MetaRow>
          <TraceToggle j={j} open={open} onToggle={onToggle} long />
        </Row>
        {open && (
          <div data-trace={key}>
            <ReviewTrace job={j} />
          </div>
        )}
      </Stack>
    </Panel>
  );
}

export function ReviewsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/reviews" });
  const reviews = useReviews(projectId);
  const reviewers = useReviewers(projectId);
  const reviewersHeading = useRef<HTMLHeadingElement>(null);
  // None on, with reviews above the section: said at the top too, where the owner looks first.
  const noneOn = reviewers.data !== undefined && !reviewers.data.some((r) => r.enabled) && (reviews.data?.length ?? 0) > 0;
  // The job whose reviewer's trace is open (one at a time: each open trace is a WebSocket).
  const [traced, setTraced] = useState<string | null>(null);
  // Below `sm`, a card per review: the table's Verdict column would start off screen.
  const phone = usePhone();
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <Stack gap="2xl">
          {noneOn && (
            <Notice tone="warning" title="No reviewer is on" role="status">
              <Stack gap="sm">
                <Text fz="sm">{NONE_ON}</Text>
                <Row>
                  <Button variant="default" size="xs" onClick={() => reviewersHeading.current?.focus()}>
                    Go to reviewers
                  </Button>
                </Row>
              </Stack>
            </Notice>
          )}
          <Section title="Reviews" count={reviews.data?.length}>
            {reviews.isPending ? (
              <LoadingState label="Loading the reviews" />
            ) : reviews.isError ? (
              <ErrorState title="The reviews couldn't be loaded" error={reviews.error} onRetry={() => void reviews.refetch()} />
            ) : reviews.data.length === 0 ? (
              <Panel>
                <EmptyState icon={IconShieldCheck} title="No reviews yet" description="Every PR on the repo gets a review by each reviewer that's on; one from someone the project doesn't trust waits here for your approval." />
              </Panel>
            ) : phone ? (
              <Stack gap="sm" role="list" aria-label="Review jobs">
                {[...reviews.data]
                  .sort(byHeldThenNewest)
                  .map((j) => {
                    const key = `${j.pr}/${j.sha}`;
                    const open = traced === key;
                    return <ReviewCard key={key} projectId={projectId} repo={p.repo} j={j} open={open} onToggle={() => setTraced(open ? null : key)} />;
                  })}
              </Stack>
            ) : (
              <TableFrame label="Review jobs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Pull request</Table.Th>
                    <Table.Th>State</Table.Th>
                    <Table.Th>Verdict</Table.Th>
                    <Table.Th ta="right">Runs</Table.Th>
                    <Table.Th ta="right">Updated</Table.Th>
                    <Table.Th>Trace</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {[...reviews.data]
                    .sort(byHeldThenNewest)
                    .map((j) => {
                      const key = `${j.pr}/${j.sha}`;
                      const open = traced === key;
                      return (
                      <Fragment key={key}>
                      <Table.Tr data-job={key}>
                        <Table.Td>
                          <PrTitle repo={p.repo} j={j} />
                        </Table.Td>
                        <Table.Td>
                          <JobState job={j} />
                        </Table.Td>
                        <Table.Td>
                          <Verdicts job={j} projectId={projectId} />
                        </Table.Td>
                        <Table.Td ta="right">
                          <Text fz="sm">{j.runs}</Text>
                        </Table.Td>
                        <Table.Td ta="right">
                          <Token mono={false} size="sm" nowrap title={exact(j.updated_ms)}>
                            {ago(j.updated_ms)}
                          </Token>
                        </Table.Td>
                        <Table.Td>
                          <TraceToggle j={j} open={open} onToggle={() => setTraced(open ? null : key)} />
                        </Table.Td>
                      </Table.Tr>
                      {open && (
                        <Table.Tr data-trace={key}>
                          <Table.Td colSpan={6}>
                            <ReviewTrace job={j} />
                          </Table.Td>
                        </Table.Tr>
                      )}
                      </Fragment>
                      );
                    })}
                </Table.Tbody>
              </TableFrame>
            )}
          </Section>
          <ReviewersSection projectId={projectId} reviewers={reviewers} headingRef={reviewersHeading} />
        </Stack>
      )}
    </ProjectFrame>
  );
}

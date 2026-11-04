// A project's reviews: every review job ReviewDO knows, newest first, with its PR, where it is, and the
// verdict on each dimension once there is one. Read-only. A table, or below `sm` a card per review (its
// PR and title, its sha, its state, its verdicts, when, and its trace), so nothing starts off screen.

import { Anchor, Badge, Button, Table, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconChevronDown, IconChevronRight, IconShieldCheck, IconX } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useReviews } from "../../api/queries";
import type { Dimension, Job } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, icon, LoadingState, MetaItem, MetaRow, Panel, Row, Section, Stack, TableFrame, TriggerBadge, usePhone, weight } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { ProjectFrame } from "../project/ProjectFrame";
import { ReviewTrace } from "../trace/AgentTraces";

const DIMENSIONS = [
  ["correctness", "Correctness"],
  ["quality", "Quality"],
  ["architecture", "Architecture"],
] as const satisfies readonly (readonly [Dimension, string])[];

/** A review job's state, or "Changes needed" for a verdict that failed a dimension (also on a task's PRs). */
export function JobState({ job, size = "md" }: { job: Job; size?: "sm" | "md" }) {
  const failedVerdict = job.state === "done" && job.verdict && DIMENSIONS.some(([d]) => job.verdict![d].verdict !== "pass");
  const s = failedVerdict ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
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

/** The verdict badges; `tainted` (the table's) puts Tainted after them, a card puts it on its state row. */
function Verdicts({ job, tainted = true }: { job: Job; tainted?: boolean }) {
  if (!job.verdict) return <Text fz="sm" c="dimmed">{job.error ?? "No verdict yet"}</Text>;
  return (
    // Badges that open their notes, wrapping into rows: a 44 px pitch between rows on touch.
    <Row gap="xs" data-touch-pitch>
      {DIMENSIONS.map(([d, label]) => {
        // Pass and fail are status: their roles, and an icon each, so color isn't the only cue.
        const pass = job.verdict![d].verdict === "pass";
        return (
          <Tooltip key={d} label={job.verdict![d].notes || label} multiline maw="var(--nest-side-panel)">
            <TriggerBadge
              size="sm"
              variant="light"
              color={pass ? "success" : "danger"}
              leftSection={pass ? <IconCheck size={icon.sm} aria-hidden /> : <IconX size={icon.sm} aria-hidden />}
              aria-label={`${label}: ${pass ? "passed" : "failed"}`}
              data-verdict={pass ? "pass" : "fail"}
            >
              {label}
            </TriggerBadge>
          </Tooltip>
        );
      })}
      {tainted && job.tainted && <TaintedBadge />}
    </Row>
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
function ReviewCard({ repo, j, open, onToggle }: { repo: string; j: Job; open: boolean; onToggle: () => void }) {
  const key = `${j.pr}/${j.sha}`;
  return (
    <Panel dense>
      <Stack gap="sm" role="listitem" data-job={key}>
        <PrTitle repo={repo} j={j} />
        <Row gap="sm">
          <JobState job={j} />
          {j.tainted && <TaintedBadge />}
        </Row>
        <Verdicts job={j} tainted={false} />
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
  // The job whose reviewer's trace is open (one at a time: each open trace is a WebSocket).
  const [traced, setTraced] = useState<string | null>(null);
  // Below `sm`, a card per review: the table's Verdict column would start off screen.
  const phone = usePhone();
  return (
    <ProjectFrame projectId={projectId}>
      {(p) => (
        <Section title="Reviews" count={reviews.data?.length}>
          {reviews.isPending ? (
            <LoadingState label="Loading the reviews" />
          ) : reviews.isError ? (
            <ErrorState title="The reviews couldn't be loaded" error={reviews.error} onRetry={() => void reviews.refetch()} />
          ) : reviews.data.length === 0 ? (
            <Panel>
              <EmptyState icon={IconShieldCheck} title="No reviews yet" description="Every PR on the repo gets a review by a reviewer agent; its jobs show here." />
            </Panel>
          ) : phone ? (
            <Stack gap="sm" role="list" aria-label="Review jobs">
              {[...reviews.data]
                .sort((a, b) => b.updated_ms - a.updated_ms)
                .map((j) => {
                  const key = `${j.pr}/${j.sha}`;
                  const open = traced === key;
                  return <ReviewCard key={key} repo={p.repo} j={j} open={open} onToggle={() => setTraced(open ? null : key)} />;
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
                  .sort((a, b) => b.updated_ms - a.updated_ms)
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
                        <Verdicts job={j} />
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text fz="sm">{j.runs}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text fz="sm" c="dimmed" title={exact(j.updated_ms)}>
                          {ago(j.updated_ms)}
                        </Text>
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
      )}
    </ProjectFrame>
  );
}

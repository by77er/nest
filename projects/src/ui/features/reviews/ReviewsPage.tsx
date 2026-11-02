// A project's reviews: every review job ReviewDO knows, newest first, with its PR, where it is, and the
// verdict on each dimension once there is one. Read-only.

import { Anchor, Badge, Table, Text, Tooltip } from "@mantine/core";
import { IconShieldCheck } from "@tabler/icons-react";
import { useParams } from "@tanstack/react-router";
import { useReviews } from "../../api/queries";
import type { Dimension, Job } from "../../api/types";
import { ago, exact } from "../../common/time";
import { EmptyState, ErrorState, LoadingState, Panel, Row, Section, Stack, TableFrame } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { ProjectFrame } from "../project/ProjectFrame";

const DIMENSIONS = [
  ["correctness", "Correctness"],
  ["quality", "Quality"],
  ["architecture", "Architecture"],
] as const satisfies readonly (readonly [Dimension, string])[];

function JobState({ job }: { job: Job }) {
  const failedVerdict = job.state === "done" && job.verdict && DIMENSIONS.some(([d]) => job.verdict![d].verdict !== "pass");
  const s = failedVerdict ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
  return (
    <Badge color={s.color} variant="light" data-state={job.state}>
      {s.label}
    </Badge>
  );
}

function Verdicts({ job }: { job: Job }) {
  if (!job.verdict) return <Text fz="sm" c="dimmed">{job.error ?? "No verdict yet"}</Text>;
  return (
    <Row gap="xs">
      {DIMENSIONS.map(([d, label]) => (
        <Tooltip key={d} label={job.verdict![d].notes || label} multiline maw="var(--nest-side-panel)">
          <Badge size="sm" variant="outline" color={job.verdict![d].verdict === "pass" ? "success" : "danger"} tabIndex={0}>
            {label}
          </Badge>
        </Tooltip>
      ))}
      {job.tainted && (
        <Badge size="sm" variant="outline" color="gray">
          Tainted
        </Badge>
      )}
    </Row>
  );
}

export function ReviewsPage() {
  const { projectId } = useParams({ from: "/projects/$projectId/reviews" });
  const reviews = useReviews(projectId);
  return (
    <ProjectFrame projectId={projectId} title="Reviews">
      {(p) => (
        <Section title="Review jobs" count={reviews.data?.length}>
          {reviews.isPending ? (
            <LoadingState label="Loading the reviews" />
          ) : reviews.isError ? (
            <ErrorState title="The reviews couldn't be loaded" error={reviews.error} onRetry={() => void reviews.refetch()} />
          ) : reviews.data.length === 0 ? (
            <Panel>
              <EmptyState icon={IconShieldCheck} title="No reviews yet" description="Every PR on the repo gets a review by a reviewer agent; its jobs show here." />
            </Panel>
          ) : (
            <TableFrame label="Review jobs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Pull request</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Verdict</Table.Th>
                  <Table.Th ta="right">Runs</Table.Th>
                  <Table.Th ta="right">Updated</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {[...reviews.data]
                  .sort((a, b) => b.updated_ms - a.updated_ms)
                  .map((j) => (
                    <Table.Tr key={`${j.pr}/${j.sha}`} data-job={`${j.pr}/${j.sha}`}>
                      <Table.Td>
                        <Stack gap="2xs">
                          <Anchor href={`https://github.com/${p.repo}/pull/${j.pr}`} target="_blank" rel="noreferrer" fz="sm" fw="medium">
                            #{j.pr} {j.title ?? ""}
                          </Anchor>
                          <Text fz="xs" c="dimmed" ff="monospace">
                            {j.sha.slice(0, 7)}
                            {j.base ? ` → ${j.base}` : ""}
                          </Text>
                        </Stack>
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
                    </Table.Tr>
                  ))}
              </Table.Tbody>
            </TableFrame>
          )}
        </Section>
      )}
    </ProjectFrame>
  );
}

// Tasks referenced in a manager's message, resolved live from the project's board (one query for the
// whole log, polled with the board), never from the message's own text. An id the board doesn't have
// (another project's, or none) is plain text: no chip, no card, no link. A chip or card opens the task
// in the Board's drawer.

import { Badge, Text } from "@mantine/core";
import { IconGitPullRequest, IconRobot } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { useAttention, useReviews, useTasks } from "../../api/queries";
import type { Job, Task } from "../../api/types";
import { TaskCardTitleLink, TaskChipLink } from "../../common/links";
import { MetaItem, MetaRow, Row, TaskCards, TaskRefCard } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { taskLine } from "../../rich/tasks";
import { StateBadge } from "../board/StateBadge";

const useTask = (projectId: string, id: string) => useTasks(projectId).data?.find((t) => t.id === id);

/** Fields other in-flight work adds to a task (several PRs, dependencies): read only when present. */
function extras(t: Task): { prs: number[]; waitingOn: number } {
  const x = t as Task & { prs?: unknown; waiting_on?: unknown; depends_on?: unknown };
  const prs = Array.isArray(x.prs) ? x.prs.filter((p): p is number => typeof p === "number") : t.pr !== null ? [t.pr] : [];
  const deps = Array.isArray(x.waiting_on) ? x.waiting_on : Array.isArray(x.depends_on) ? x.depends_on : [];
  return { prs, waitingOn: deps.length };
}

export function TaskChip({ projectId, id, fallback }: { projectId: string; id: string; fallback: ReactNode }) {
  const t = useTask(projectId, id);
  if (!t) return <span data-task-ref="unresolved">{fallback}</span>;
  return (
    <TaskChipLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: t.id }} aria-label={`Task ${t.title}`} data-task-ref={t.id}>
      <StateBadge state={t.state} size="xs" />
      <span>{t.title}</span>
    </TaskChipLink>
  );
}

function Verdict({ job }: { job: Job | undefined }) {
  if (!job) return null;
  const failed = job.state === "done" && job.verdict && (["correctness", "quality", "architecture"] as const).some((d) => job.verdict![d].verdict !== "pass");
  const s = failed ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
  return (
    <Badge size="xs" variant="light" color={s.color}>
      {s.label}
    </Badge>
  );
}

function Card({ projectId, t, note, needsYou, jobs }: { projectId: string; t: Task; note: string; needsYou: boolean; jobs: Job[] }) {
  const { prs, waitingOn } = extras(t);
  // The latest review of each PR.
  const latest = (pr: number) => jobs.filter((j) => j.pr === pr).sort((a, b) => b.updated_ms - a.updated_ms)[0];
  return (
    <TaskRefCard data-task-ref={t.id}>
      <TaskCardTitleLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: t.id }}>
        {t.title}
      </TaskCardTitleLink>
      <Row gap="xs">
        <StateBadge state={t.state} size="sm" />
        {needsYou && (
          <Badge size="sm" color="warning" variant="filled" data-marker="needs-you">
            Needs you
          </Badge>
        )}
        {waitingOn > 0 && (
          <Badge size="sm" color="gray" variant="outline">
            Waiting on {waitingOn}
          </Badge>
        )}
      </Row>
      {(t.assignee || prs.length > 0) && (
        <MetaRow>
          {t.assignee && (
            <MetaItem icon={IconRobot} mono>
              {t.assignee}
            </MetaItem>
          )}
          {prs.map((pr) => (
            <MetaItem key={pr} icon={IconGitPullRequest}>
              <Row gap="xs" wrap="nowrap">
                <span>#{pr}</span>
                <Verdict job={latest(pr)} />
              </Row>
            </MetaItem>
          ))}
        </MetaRow>
      )}
      {note && (
        <Text fz="sm" c="dimmed">
          {note}
        </Text>
      )}
    </TaskRefCard>
  );
}

/** A ```tasks block: one card per id the board has, the line as plain text otherwise. */
export function TaskBlock({ projectId, lines }: { projectId: string; lines: string[] }) {
  const tasks = useTasks(projectId).data ?? [];
  const attention = useAttention(projectId).data ?? [];
  const jobs = useReviews(projectId).data ?? [];
  const waiting = new Set(attention.map((a) => (a.kind === "blocked" ? a.task : a.task)).filter(Boolean));
  return (
    <TaskCards>
      {lines.map((line, i) => {
        const ref = taskLine(line);
        const t = ref && tasks.find((x) => x.id === ref.id);
        if (!ref || !t) {
          return (
            <Text key={i} fz="md" data-task-ref="unresolved">
              {line}
            </Text>
          );
        }
        return <Card key={i} projectId={projectId} t={t} note={ref.note} needsYou={!!t.blocked || waiting.has(t.id)} jobs={jobs} />;
      })}
    </TaskCards>
  );
}

/** Cards for these tasks (ids the board has), in order; nothing when there are none. */
export function TaskCardList({ projectId, ids }: { projectId: string; ids: string[] }) {
  return <TaskBlock projectId={projectId} lines={ids} />;
}

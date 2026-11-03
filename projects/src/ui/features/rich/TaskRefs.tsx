// Tasks referenced in a manager's message, resolved live from the project's board (one query for the
// whole log, polled with the board), never from the message's own text. An id the board doesn't have
// (another project's, or none) is plain text: no chip, no card, no link. A chip or card opens the task
// in the Board's drawer.

import { Anchor, Badge, Text } from "@mantine/core";
import type { ReactNode } from "react";
import { useAsks, useProject, useReviews, useTasks } from "../../api/queries";
import type { Job, Task } from "../../api/types";
import { TaskCardTitleLink, TaskChipLink } from "../../common/links";
import { Row, TaskCards, TaskRefCard } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { taskLine } from "../../rich/tasks";
import { StateBadge } from "../board/StateBadge";
import { TaskCardBody } from "../board/TaskCardBody";

const useTask = (projectId: string, id: string) => useTasks(projectId).data?.find((t) => t.id === id);

export function TaskChip({ projectId, id, fallback }: { projectId: string; id: string; fallback: ReactNode }) {
  const t = useTask(projectId, id);
  // An unknown or foreign id: muted inline code, never a link.
  if (!t) return <code data-task-ref="unresolved">{fallback}</code>;
  // The title first, then its state; all phrasing content (it sits inside a paragraph).
  return (
    <TaskChipLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: t.id }} aria-label={`Task ${t.title}`} data-task-ref={t.id}>
      <span>{t.title}</span>
      <StateBadge state={t.state} size="sm" component="span" />
    </TaskChipLink>
  );
}

function Verdict({ job }: { job: Job | undefined }) {
  if (!job) return null;
  const failed = job.state === "done" && job.verdict && (["correctness", "quality", "architecture"] as const).some((d) => job.verdict![d].verdict !== "pass");
  const s = failed ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
  return (
    <Badge size="sm" variant="light" color={s.color}>
      {s.label}
    </Badge>
  );
}

function Card({ projectId, repo, t, note, pendingAsks, jobs }: { projectId: string; repo: string; t: Task; note: string; pendingAsks: number; jobs: Job[] }) {
  // The latest review of each PR.
  const latest = (pr: number) => jobs.filter((j) => j.pr === pr).sort((a, b) => b.updated_ms - a.updated_ms)[0];
  return (
    <TaskRefCard data-task-ref={t.id}>
      <TaskCardBody
        task={t}
        pendingAsks={pendingAsks}
        note={note}
        title={
          <TaskCardTitleLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: t.id }}>
            {t.title}
          </TaskCardTitleLink>
        }
        pr={(n) => (
          <Row gap="xs" wrap="nowrap">
            <Anchor href={`https://github.com/${repo}/pull/${n}`} target="_blank" rel="noopener noreferrer" inherit>
              #{n}
            </Anchor>
            <Verdict job={latest(n)} />
          </Row>
        )}
      />
    </TaskRefCard>
  );
}

/** A ```tasks block: one card per id the board has, the line as plain text otherwise. */
export function TaskBlock({ projectId, lines }: { projectId: string; lines: string[] }) {
  const tasks = useTasks(projectId).data ?? [];
  const asks = useAsks(projectId).data ?? [];
  const jobs = useReviews(projectId).data ?? [];
  const repo = useProject(projectId).data?.repo ?? "";
  const asksOf = (id: string) => asks.filter((a) => a.answered_ms === null && a.task === id).length;
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
        return <Card key={i} projectId={projectId} repo={repo} t={t} note={ref.note} pendingAsks={asksOf(t.id)} jobs={jobs} />;
      })}
    </TaskCards>
  );
}

/** Cards for these tasks (ids the board has), in order; nothing when there are none. */
export function TaskCardList({ projectId, ids }: { projectId: string; ids: string[] }) {
  return <TaskBlock projectId={projectId} lines={ids} />;
}

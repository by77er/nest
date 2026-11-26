// Tasks referenced in a manager's message, resolved live from the project's board (one query for the
// whole log, polled with the board), never from the message's own text. An id the board doesn't have
// (another project's, or none) is plain text: no chip, no card, no link. A chip or card opens the task
// in the Board's drawer.

import { Anchor, Badge, Text } from "@mantine/core";
import { memo, type ReactNode, useCallback, useMemo } from "react";
import { tasksById, useAsks, useBoardTask, useProject, useReviews, useTasksSelect } from "../../api/queries";
import type { Job, TaskSummary } from "../../api/types";
import { TaskCardTitleLink, TaskChipLink } from "../../common/links";
import { Row, TaskCards, TaskChipPending, TaskRefCard } from "../../layout";
import { REVIEW_STATE } from "../../status";
import { taskLine } from "../../rich/tasks";
import { StateBadge } from "../board/StateBadge";
import { changesNeeded } from "../reviews/ReviewsPage";
import { TaskCardBody } from "../board/TaskCardBody";

// Each chip and card reads its own task from the board's query (`select`, with the board's poll):
// another task's change doesn't re-render it.

export function TaskChip({ projectId, id, fallback }: { projectId: string; id: string; fallback: ReactNode }) {
  const task = useBoardTask(projectId, id);
  // While the board loads: a chip's box with its state's room, so nothing in view grows when it lands.
  if (task.isPending) return <TaskChipPending>{fallback}</TaskChipPending>;
  const t = task.data;
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
  const s = changesNeeded(job) ? { label: "Changes needed", color: "danger" as const } : REVIEW_STATE[job.state];
  return (
    <Badge size="sm" variant="light" color={s.color}>
      {s.label}
    </Badge>
  );
}

/** A card, rendered when its task, its note, its asks, its PR's latest review (`job`) or the repo change. */
const Card = memo(function Card({ projectId, repo, t, note, pendingAsks, job }: { projectId: string; repo: string; t: TaskSummary; note: string; pendingAsks: number; job: Job | undefined }) {
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
            <Verdict job={job} />
          </Row>
        )}
      />
    </TaskRefCard>
  );
});

/** A ```tasks block: one card per id the board has, the line as plain text otherwise. */
export function TaskBlock({ projectId, lines }: { projectId: string; lines: string[] }) {
  const key = lines.join("\n");
  const refs = useMemo(() => (key === "" ? [] : key.split("\n")).map((line) => ({ line, ref: taskLine(line) })), [key]);
  // Just these tasks: the selection keeps its identity while none of them changed.
  const select = useCallback((xs: TaskSummary[]) => {
    const byId = tasksById(xs);
    return refs.map(({ ref }) => (ref ? byId.get(ref.id) ?? null : null));
  }, [refs]);
  const tasks = useTasksSelect(projectId, select).data ?? [];
  const asks = useAsks(projectId).data;
  const jobs = useReviews(projectId).data;
  const repo = useProject(projectId).data?.repo ?? "";
  const asksOf = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of asks ?? []) if (a.task) m.set(a.task, (m.get(a.task) ?? 0) + 1);
    return m;
  }, [asks]);
  // The latest review of each PR.
  const latest = useMemo(() => {
    const m = new Map<number, Job>();
    for (const j of jobs ?? []) {
      const had = m.get(j.pr);
      if (!had || j.updated_ms > had.updated_ms) m.set(j.pr, j);
    }
    return m;
  }, [jobs]);
  return (
    <TaskCards>
      {refs.map(({ line, ref }, i) => {
        const t = tasks[i];
        if (!ref || !t) {
          return (
            <Text key={i} fz="md" data-task-ref="unresolved">
              {line}
            </Text>
          );
        }
        return <Card key={i} projectId={projectId} repo={repo} t={t} note={ref.note} pendingAsks={asksOf.get(t.id) ?? 0} job={t.pr !== null ? latest.get(t.pr) : undefined} />;
      })}
    </TaskCards>
  );
}

/** Cards for these tasks (ids the board has), in order; nothing when there are none. */
export const TaskCardList = memo(function TaskCardList({ projectId, ids }: { projectId: string; ids: string[] }) {
  return <TaskBlock projectId={projectId} lines={ids} />;
});

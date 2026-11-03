// A task, opened from the board (`?task=` in the URL): its text, its spec, its history and what the
// owner can do to it.

import { Badge } from "@mantine/core";
import { IconRobot, IconTimeline } from "@tabler/icons-react";
import { useTask } from "../../api/queries";
import { EmptyState, ErrorState, LoadingState, MetaItem, MetaRow, Notice, Prose, Row, Section, Sheet, Stack } from "../../layout";
import { ago, exact } from "../../common/time";
import { StateBadge } from "../board/StateBadge";
import { WaitingBadge } from "../board/WaitingBadge";
import { TERMINAL } from "../../../tasks";
import { HistoryList } from "./HistoryList";
import { SpecView } from "./SpecView";
import { TaskActions } from "./TaskActions";
import { TaskDescription } from "./TaskDescription";
import { TaskTraces } from "../trace/AgentTraces";
import { TaskDependencies } from "./TaskDependencies";
import { TaskPrs } from "./TaskPrs";

export function TaskDrawer({ projectId, repo, taskId, onClose }: { projectId: string; repo: string; taskId: string | undefined; onClose: () => void }) {
  const task = useTask(projectId, taskId);
  const t = task.data;

  return (
    // A task that has (or had) a worker: its trace beside the details (two columns from `xl`, tabs below).
    <Sheet opened={taskId !== undefined} onClose={onClose} title="Task"
      split
      beside={t?.assignee ? <TaskTraces task={t} /> : undefined}
      besideEmpty={t ? <EmptyState icon={IconTimeline} title="No worker yet" description="Its worker's trace shows here once the task is assigned and its worker starts." /> : undefined}
    >
      {task.isPending ? (
        <LoadingState label="Loading the task" />
      ) : task.isError ? (
        <ErrorState title="The task couldn't be loaded" error={task.error} onRetry={() => void task.refetch()} />
      ) : t ? (
        <Stack gap="2xl">
          <Stack gap="lg">
            <Stack gap="sm">
              <Row gap="xs">
                <StateBadge state={t.state} />
                <WaitingBadge task={t} size="md" />
                {t.tainted && (
                  <Badge color="gray" variant="outline">
                    Tainted
                  </Badge>
                )}
              </Row>
              <MetaRow>
                {t.assignee && (
                  <MetaItem icon={IconRobot} mono>
                    {t.assignee}
                  </MetaItem>
                )}
                <MetaItem title={exact(t.updated_ms)}>Updated {ago(t.updated_ms)}</MetaItem>
              </MetaRow>
            </Stack>
            {t.blocked && (
              <Notice tone="warning" title={`Blocked by ${t.blocked.role === "manager" ? "the manager" : "its worker"}, ${ago(t.blocked.at_ms)}`}>
                <Stack gap="xs">
                  <Prose>{t.blocked.reason}</Prose>
                  {t.blocked.question && <Prose>{t.blocked.question}</Prose>}
                </Stack>
              </Notice>
            )}
            {t.start_error && (
              <Notice tone="warning" title={t.state === "stalled" ? "Its worker didn't start" : "Its worker is being retried"}>
                {t.start_error}
              </Notice>
            )}
            <TaskActions projectId={projectId} task={t} onDeleted={onClose} />
          </Stack>

          <TaskDescription key={t.id} projectId={projectId} task={t} readOnly={TERMINAL.has(t.state)} />

          <Section title="Spec" region={false}>
            <SpecView spec={t.spec} />
          </Section>

          <TaskPrs projectId={projectId} repo={repo} task={t} />

          <TaskDependencies projectId={projectId} task={t} />

          <Section title="History" count={t.history.length} region={false}>
            <HistoryList history={t.history} />
          </Section>
        </Stack>
      ) : null}
    </Sheet>
  );
}

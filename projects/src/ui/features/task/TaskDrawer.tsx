// A task, opened from the board (`?task=` in the URL): its text, its spec, its history and what the
// owner can do to it.

import { Badge } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { useTask } from "../../api/queries";
import { ErrorState, LoadingState, MetaItem, MetaRow, Notice, Prose, Row, Section, Sheet, Stack } from "../../layout";
import { ago, exact } from "../../common/time";
import { StateBadge } from "../board/StateBadge";
import { WaitingBadge } from "../board/WaitingBadge";
import { TERMINAL } from "../../../tasks";
import { HistoryList } from "./HistoryList";
import { SpecView } from "./SpecView";
import { TaskActions } from "./TaskActions";
import { TaskEditForm } from "./TaskEditForm";
import { TaskTraces } from "../trace/AgentTraces";
import { TaskDependencies } from "./TaskDependencies";
import { TaskPrs } from "./TaskPrs";

export function TaskDrawer({ projectId, repo, taskId, onClose }: { projectId: string; repo: string; taskId: string | undefined; onClose: () => void }) {
  const task = useTask(projectId, taskId);
  const t = task.data;

  return (
    <Sheet opened={taskId !== undefined} onClose={onClose} title="Task">
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

          <Section title="Description" region={false}>
            <TaskEditForm key={t.id} projectId={projectId} task={t} readOnly={TERMINAL.has(t.state)} />
          </Section>

          <Section title="Spec" region={false}>
            <SpecView spec={t.spec} />
          </Section>

          <TaskPrs projectId={projectId} repo={repo} task={t} />

          <TaskDependencies projectId={projectId} task={t} />

          <Section title="History" count={t.history.length} region={false}>
            <HistoryList history={t.history} />
          </Section>

          <TaskTraces task={t} />
        </Stack>
      ) : null}
    </Sheet>
  );
}

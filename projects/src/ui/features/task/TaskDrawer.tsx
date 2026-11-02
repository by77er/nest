// A task, opened from the board (`?task=` in the URL): its text, its spec, its history and what the
// owner can do to it.

import { Anchor, Badge } from "@mantine/core";
import { IconGitPullRequest, IconRobot } from "@tabler/icons-react";
import { useTask } from "../../api/queries";
import { ErrorState, LoadingState, MetaItem, MetaRow, Notice, Row, Section, Sheet, Stack } from "../../layout";
import { ago, exact } from "../../common/time";
import { StateBadge } from "../board/StateBadge";
import { TERMINAL } from "../../../tasks";
import { HistoryList } from "./HistoryList";
import { SpecView } from "./SpecView";
import { TaskActions } from "./TaskActions";
import { TaskEditForm } from "./TaskEditForm";
import { TaskTraces } from "../trace/AgentTraces";

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
                {t.pr !== null && (
                  <MetaItem icon={IconGitPullRequest}>
                    <Anchor href={`https://github.com/${repo}/pull/${t.pr}`} target="_blank" rel="noreferrer" inherit>
                      PR #{t.pr}
                    </Anchor>
                  </MetaItem>
                )}
                <MetaItem title={exact(t.updated_ms)}>Updated {ago(t.updated_ms)}</MetaItem>
              </MetaRow>
            </Stack>
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

          <Section title="History" count={t.history.length} region={false}>
            <HistoryList history={t.history} />
          </Section>

          <TaskTraces task={t} />
        </Stack>
      ) : null}
    </Sheet>
  );
}

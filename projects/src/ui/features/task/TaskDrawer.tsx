// A task, opened from the board (`?task=` in the URL): its text, its spec, its history and what the
// owner can do to it.

import { Alert, Anchor, Badge, Divider, Drawer, Group, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconGitPullRequest, IconRobot } from "@tabler/icons-react";
import { useTask } from "../../api/queries";
import { Loading, LoadError } from "../../common/QueryStates";
import { ago, exact } from "../../common/time";
import { StateBadge } from "../board/StateBadge";
import { TERMINAL } from "../../../tasks";
import { HistoryList } from "./HistoryList";
import { SpecView } from "./SpecView";
import { TaskActions } from "./TaskActions";
import { TaskEditForm } from "./TaskEditForm";

export function TaskDrawer({ projectId, repo, taskId, onClose }: { projectId: string; repo: string; taskId: string | undefined; onClose: () => void }) {
  const task = useTask(projectId, taskId);
  const phone = useMediaQuery("(max-width: 48em)");
  const t = task.data;

  return (
    <Drawer opened={taskId !== undefined} onClose={onClose} position="right" size={phone ? "100%" : "xl"} title="Task">
      {task.isPending ? (
        <Loading label="Loading the task" />
      ) : task.isError ? (
        <LoadError what="The task" error={task.error} onRetry={() => void task.refetch()} />
      ) : t ? (
        <Stack gap="lg">
          <Stack gap="xs">
            <Group gap="xs">
              <StateBadge state={t.state} />
              {t.tainted && (
                <Badge color="gray" variant="outline">
                  Tainted
                </Badge>
              )}
              <Text size="xs" c="dimmed" title={exact(t.updated_ms)}>
                Updated {ago(t.updated_ms)}
              </Text>
            </Group>
            <Group gap="md">
              {t.assignee && (
                <Group gap={4}>
                  <IconRobot size={14} aria-hidden />
                  <Text size="sm">{t.assignee}</Text>
                </Group>
              )}
              {t.pr !== null && (
                <Anchor href={`https://github.com/${repo}/pull/${t.pr}`} target="_blank" rel="noreferrer" size="sm">
                  <Group gap={4}>
                    <IconGitPullRequest size={14} aria-hidden />
                    PR #{t.pr}
                  </Group>
                </Anchor>
              )}
            </Group>
          </Stack>

          {t.start_error && (
            <Alert color="warning" variant="light" icon={<IconAlertTriangle size={18} />} title={t.state === "stalled" ? "Its worker didn't start" : "Its worker is being retried"}>
              {t.start_error}
            </Alert>
          )}

          <TaskActions projectId={projectId} task={t} onDeleted={onClose} />

          <TaskEditForm key={t.id} projectId={projectId} task={t} readOnly={TERMINAL.has(t.state)} />

          <Divider label="Spec" labelPosition="left" />
          <SpecView spec={t.spec} />

          <Divider label="History" labelPosition="left" />
          <HistoryList history={t.history} />
        </Stack>
      ) : null}
    </Drawer>
  );
}

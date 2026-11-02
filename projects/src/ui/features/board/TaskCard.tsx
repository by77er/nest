// One task on the board: its title (a link that opens its drawer), its state, who works on it, its PR,
// and the markers that need the owner's eye. The grip drags it, by pointer or keyboard (space, arrows).

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, Anchor, Badge, Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconGitPullRequest, IconGripVertical, IconRobot } from "@tabler/icons-react";
import type { Task } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { StateBadge } from "./StateBadge";

export interface TaskCardProps {
  task: Task;
  projectId: string;
  repo: string;
  /** Open asks from this task's worker. */
  pendingAsks: number;
  /** Whether cards in its column can be dragged. */
  sortable: boolean;
}

export function TaskCard({ task, projectId, repo, pendingAsks, sortable }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: task.id, disabled: !sortable });
  const style = { transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 2 : undefined };

  return (
    <Paper ref={setNodeRef} style={style} withBorder p="sm" shadow={isDragging ? "md" : undefined} data-task={task.id} aria-label={task.title} component="article">
      <Stack gap={6}>
        <Group gap={4} wrap="nowrap" align="flex-start">
          {sortable && (
            <ActionIcon
              ref={setActivatorNodeRef}
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Move ${task.title}`}
              style={{ cursor: isDragging ? "grabbing" : "grab", touchAction: "none" }}
              {...attributes}
              {...listeners}
            >
              <IconGripVertical size={14} />
            </ActionIcon>
          )}
          <AnchorLink to="/projects/$projectId" params={{ projectId }} search={{ task: task.id }} c="dark" fw={500} size="sm" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            {task.title}
          </AnchorLink>
        </Group>
        <Group gap={6}>
          <StateBadge state={task.state} size="sm" />
          {pendingAsks > 0 && (
            <Badge size="sm" color="warning" variant="filled" leftSection={<IconAlertTriangle size={12} />} data-marker="ask">
              Needs input
            </Badge>
          )}
          {task.tainted && (
            <Tooltip label="A tainted session wrote to this task (it read untrusted content)" withArrow multiline w={220}>
              <Badge size="sm" color="gray" variant="outline" data-marker="tainted" tabIndex={0}>
                Tainted
              </Badge>
            </Tooltip>
          )}
        </Group>
        {(task.assignee || task.pr !== null) && (
          <Group gap="sm" wrap="nowrap">
            {task.assignee && (
              <Group gap={4} wrap="nowrap" miw={0}>
                <IconRobot size={14} aria-hidden color="var(--mantine-color-dimmed)" />
                <Text size="xs" c="dimmed" truncate title={task.assignee}>
                  {task.assignee}
                </Text>
              </Group>
            )}
            {task.pr !== null && (
              <Anchor href={`https://github.com/${repo}/pull/${task.pr}`} target="_blank" rel="noreferrer" size="xs">
                <Group gap={2} wrap="nowrap">
                  <IconGitPullRequest size={14} aria-hidden />#{task.pr}
                </Group>
              </Anchor>
            )}
          </Group>
        )}
        {task.start_error && (
          <Text size="xs" c="warning.8" lineClamp={2} title={task.start_error}>
            {task.start_error}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

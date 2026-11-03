// One task on the board: its title (a link that opens its drawer), then its status badges with the
// grip at the right, then a caption line of who and which PR. The grip drags it, by pointer or keyboard
// (space, arrows).

import { Anchor, Badge, Text, Tooltip } from "@mantine/core";
import { IconGitPullRequest, IconHandStop, IconMessageQuestion, IconRobot } from "@tabler/icons-react";
import type { Task } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { icon, MetaItem, MetaRow, Row, SortablePanel, Stack, TriggerBadge } from "../../layout";
import { StateBadge } from "./StateBadge";
import { WaitingBadge } from "./WaitingBadge";

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
  return (
    <SortablePanel id={task.id} disabled={!sortable} gripLabel={`Move ${task.title}`} dense component="article" aria-label={task.title} data-task={task.id}>
      {(grip) => (
        <Stack gap="sm">
          <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: task.id }} c="bright" fw="medium" fz="sm">
            {task.title}
          </AnchorLink>
          <Row gap="xs" justify="space-between" align="flex-start">
            <Row gap="xs">
              <StateBadge state={task.state} size="sm" />
              <WaitingBadge task={task} />
              {task.blocked && (
                <Tooltip label={`Blocked: ${task.blocked.reason}`} withArrow multiline maw="var(--nest-side-panel)">
                  <TriggerBadge size="sm" color="warning" variant="filled" data-marker="blocked" leftSection={<IconHandStop size={icon.sm} aria-hidden />}>
                    Blocked
                  </TriggerBadge>
                </Tooltip>
              )}
              {pendingAsks > 0 && (
                <Badge size="sm" color="warning" variant="filled" data-marker="ask" leftSection={<IconMessageQuestion size={icon.sm} aria-hidden />}>
                  Needs input
                </Badge>
              )}
              {task.tainted && (
                <Tooltip label="A tainted session wrote to this task (it read untrusted content)" withArrow multiline maw="var(--nest-side-panel)">
                  <TriggerBadge size="sm" color="gray" variant="outline" data-marker="tainted">
                    Tainted
                  </TriggerBadge>
                </Tooltip>
              )}
            </Row>
            {grip}
          </Row>
          {(task.assignee || task.pr !== null) && (
            <MetaRow>
              {task.assignee && (
                <MetaItem icon={IconRobot} mono>
                  {task.assignee}
                </MetaItem>
              )}
              {task.pr !== null && (
                <MetaItem icon={IconGitPullRequest}>
                  <Anchor href={`https://github.com/${repo}/pull/${task.pr}`} target="_blank" rel="noreferrer" inherit>
                    #{task.pr}
                  </Anchor>
                  {task.prs.length > 1 ? ` +${task.prs.length - 1}` : ""}
                </MetaItem>
              )}
            </MetaRow>
          )}
          {task.start_error && (
            <Text size="xs" c="warning">
              {task.start_error}
            </Text>
          )}
        </Stack>
      )}
    </SortablePanel>
  );
}

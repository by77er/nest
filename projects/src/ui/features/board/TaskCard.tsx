// One task on the board: its title (a link that opens its drawer), then its status badges with the
// grip at the right, then a caption line of who and which PR. The grip drags it, by pointer or keyboard
// (space, arrows).

import { Anchor, Badge, Text, Tooltip } from "@mantine/core";
import { IconGitPullRequest, IconRobot } from "@tabler/icons-react";
import type { Task } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { MetaItem, MetaRow, Row, SortablePanel, Stack } from "../../layout";
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
              {task.waiting_on.length > 0 && (
                <Tooltip
                  label={`Waiting on ${task.blocked_by.filter((b) => task.waiting_on.includes(b.id)).map((b) => `${b.title} (${b.state.replace("_", " ")})`).join(", ")}`}
                  withArrow
                  multiline
                  maw="var(--nest-side-panel)"
                  events={{ hover: true, focus: true, touch: true }}
                >
                  <Badge size="sm" color="gray" variant="outline" data-marker="waiting" tabIndex={0}>
                    Waiting on {task.waiting_on.length}
                  </Badge>
                </Tooltip>
              )}
              {task.blocked && (
                <Tooltip label={`Blocked: ${task.blocked.reason}`} withArrow multiline maw="var(--nest-side-panel)">
                  <Badge size="sm" color="warning" variant="filled" data-marker="blocked" tabIndex={0}>
                    Blocked
                  </Badge>
                </Tooltip>
              )}
              {pendingAsks > 0 && (
                <Badge size="sm" color="warning" variant="filled" data-marker="ask">
                  Needs input
                </Badge>
              )}
              {task.tainted && (
                <Tooltip label="A tainted session wrote to this task (it read untrusted content)" withArrow multiline maw="var(--nest-side-panel)">
                  <Badge size="sm" color="gray" variant="outline" data-marker="tainted" tabIndex={0}>
                    Tainted
                  </Badge>
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

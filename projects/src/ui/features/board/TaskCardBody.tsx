// A task's card body, the one look a task has everywhere (similarity): the Board's cards, a message's
// task cards and the Manager's context column. Its title (a link the caller gives), its badges in one
// size (state, Blocked, Needs input, Tainted), who works on it and its PRs, its start error, and an
// optional note. The Board adds its grip; nothing else differs.

import { Badge, Text, Tooltip } from "@mantine/core";
import { IconGitPullRequest, IconRobot } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { Task } from "../../api/types";
import { MetaItem, MetaRow, Row, Stack } from "../../layout";
import { StateBadge } from "./StateBadge";

export interface TaskCardBodyProps {
  task: Task;
  /** The title, as a link to the task (the caller's: the Board's or the drawer's). */
  title: ReactNode;
  /** Open asks from this task's worker (the Board's "Needs input"). */
  pendingAsks: number;
  /** A PR's link and review, the caller's; the number alone when not given. */
  pr?: (pr: number) => ReactNode;
  /** What sits at the badge row's end (the Board's grip). */
  end?: ReactNode;
  note?: string;
}

export function TaskCardBody({ task, title, pendingAsks, pr, end, note }: TaskCardBodyProps) {
  const prs = task.pr !== null ? [task.pr] : [];
  return (
    <Stack gap="sm">
      {title}
      <Row gap="xs" justify="space-between" align="flex-start">
        <Row gap="xs">
          <StateBadge state={task.state} size="sm" />
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
        {end}
      </Row>
      {(task.assignee || prs.length > 0) && (
        <MetaRow>
          {task.assignee && (
            <MetaItem icon={IconRobot} mono>
              {task.assignee}
            </MetaItem>
          )}
          {prs.map((n) => (
            <MetaItem key={n} icon={IconGitPullRequest}>
              {pr ? pr(n) : `#${n}`}
            </MetaItem>
          ))}
        </MetaRow>
      )}
      {task.start_error && (
        <Text size="xs" c="warning">
          {task.start_error}
        </Text>
      )}
      {note && (
        <Text fz="sm" c="dimmed">
          {note}
        </Text>
      )}
    </Stack>
  );
}

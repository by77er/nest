// One task on the board's list: its state's glyph, its short id, its title (the link that opens its
// drawer; the whole row opens it), its markers (waiting on, Blocked, Needs input, Tainted, a failed
// start), then quiet metadata in fixed columns: its worker, its first PR (number and state, +N more), and
// when it last changed. Markers are the same badges the drawer and the task cards use (similarity); on
// touch they're plain status, the row opening the drawer where each explains itself.

import { Anchor, Badge, Text, Tooltip } from "@mantine/core";
import {
  IconAlertCircle, IconAlertTriangle, IconCircle, IconCircleCheck, IconCircleDashed, IconCircleDot, IconCircleHalf, IconCircleHalf2, IconCircleX, IconHandStop, IconMessageQuestion,
} from "@tabler/icons-react";
import type { ComponentType } from "react";
import type { Task, TaskState } from "../../api/types";
import { TaskRowTitleLink } from "../../common/links";
import { ago, exact } from "../../common/time";
import { icon, StateGlyph, TaskRow, TriggerBadge } from "../../layout";
import { STATE_COLOR, STATE_LABEL } from "../../status";
import { WaitingBadge } from "./WaitingBadge";

/** Each state's glyph: an empty ring before work, filling as it goes, a check when done. */
const GLYPH: Record<TaskState, ComponentType<{ size?: number; stroke?: number }>> = {
  draft: IconCircleDashed,
  ready: IconCircle,
  assigned: IconCircleHalf,
  in_progress: IconCircleHalf2,
  in_review: IconCircleDot,
  stalled: IconAlertCircle,
  done: IconCircleCheck,
  cancelled: IconCircleX,
};

export function TaskStateGlyph({ state }: { state: TaskState }) {
  const Glyph = GLYPH[state];
  return (
    <StateGlyph color={STATE_COLOR[state]} label={STATE_LABEL[state]} data-state={state}>
      <Glyph size={icon.md} />
    </StateGlyph>
  );
}

const shortDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const shortDayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** When it changed, short enough for its column: relative within a week, then the day ("Nov 3"), with the year when not this one. */
export function changedWhen(ms: number, now = Date.now()): string {
  const rel = ago(ms, now);
  // `ago` turns to the full date and time from a week on: that's when the day alone takes over.
  if (rel !== exact(ms)) return rel;
  return new Date(ms).getFullYear() === new Date(now).getFullYear() ? shortDay.format(ms) : shortDayYear.format(ms);
}

/** A task's short id: its id without the `tsk_` prefix, at most its last 6 characters. */
export const shortId = (id: string) => {
  const bare = id.replace(/^tsk_/, "");
  return bare.length > 6 ? bare.slice(-6) : bare;
};

export interface TaskListRowProps {
  task: Task;
  projectId: string;
  repo: string;
  /** Open asks from this task's worker. */
  pendingAsks: number;
  sortable: boolean;
  /** Its group's name: a row whose state reads otherwise (Assigned, in "In progress") says its own, muted. */
  group?: string;
}

export function TaskListRow({ task, projectId, repo, pendingAsks, sortable, group }: TaskListRowProps) {
  const first = task.prs[0] ?? (task.pr !== null ? { number: task.pr, state: "open" as const } : null);
  return (
    <TaskRow
      id={task.id}
      label={task.title}
      sortable={sortable}
      data-task={task.id}
      glyph={<TaskStateGlyph state={task.state} />}
      code={<span title={task.id}>{shortId(task.id)}</span>}
      title={
        <TaskRowTitleLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: task.id }}>
          {task.title}
        </TaskRowTitleLink>
      }
      markers={
        <>
          {group !== undefined && STATE_LABEL[task.state] !== group && (
            <Text component="span" fz="xs" c="dimmed" data-slot="row-state">
              {STATE_LABEL[task.state]}
            </Text>
          )}
          <WaitingBadge task={task} size="sm" plainOnTouch />
          {task.blocked && (
            <Tooltip label={`Blocked: ${task.blocked.reason}`} withArrow multiline maw="var(--nest-side-panel)">
              <TriggerBadge plainOnTouch size="sm" color="warning" variant="filled" data-marker="blocked" aria-label={`Blocked: ${task.blocked.reason}`} leftSection={<IconHandStop size={icon.sm} aria-hidden />}>
                Blocked
              </TriggerBadge>
            </Tooltip>
          )}
          {pendingAsks > 0 && (
            <Badge size="sm" color="warning" variant="filled" data-marker="ask" leftSection={<IconMessageQuestion size={icon.sm} aria-hidden />}>
              Needs input
            </Badge>
          )}
          {task.start_error && (
            <Tooltip label={task.start_error} withArrow multiline maw="var(--nest-side-panel)">
              <TriggerBadge plainOnTouch size="sm" color="warning" variant="light" data-marker="start-error" aria-label={`Didn't start: ${task.start_error}`} leftSection={<IconAlertTriangle size={icon.sm} aria-hidden />}>
                Didn't start
              </TriggerBadge>
            </Tooltip>
          )}
          {task.tainted && (
            <Tooltip label="A tainted session wrote to this task (it read untrusted content)" withArrow multiline maw="var(--nest-side-panel)">
              <TriggerBadge plainOnTouch size="sm" color="gray" variant="outline" data-marker="tainted" aria-label="Tainted: a tainted session wrote to this task">
                Tainted
              </TriggerBadge>
            </Tooltip>
          )}
        </>
      }
      who={task.assignee ? <span title={task.assignee}>{task.assignee}</span> : undefined}
      pr={
        first ? (
          // A line of text (a paragraph), so its number is an inline link on touch: the drawer lists the same PRs.
          <Text component="p" inherit c="dimmed" data-slot="pr">
            <Anchor href={`https://github.com/${repo}/pull/${first.number}`} target="_blank" rel="noreferrer" inherit c="dimmed" data-inline aria-label={`PR #${first.number}, ${first.state}`}>
              #{first.number}
            </Anchor>
            <Text component="span" inherit c="dimmed">
              {" "}
              {first.state}
            </Text>
            {task.prs.length > 1 && (
              <Text component="span" inherit c="dimmed">
                {" "}+{task.prs.length - 1}
              </Text>
            )}
          </Text>
        ) : undefined
      }
      updated={
        <Text component="time" inherit c="dimmed" dateTime={new Date(task.updated_ms).toISOString()} title={`Updated ${exact(task.updated_ms)}`}>
          {changedWhen(task.updated_ms)}
        </Text>
      }
    />
  );
}

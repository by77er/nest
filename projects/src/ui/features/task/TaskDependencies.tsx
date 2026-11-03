// A task's dependencies (README.md#dependencies): what it waits on and what waits on it, each a group
// with its count, each row its title then its state; a status line; removing one confirmed; and adding
// one from the section's top right: a picker offering only tasks it may wait on (not itself, not one
// over, not one that would make a cycle), each with its state. Distinct from "Blocked", the flag an agent
// raises for the owner. A task waiting on one not done can't be assigned.

import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconLink } from "@tabler/icons-react";
import { useAddDependency, useRemoveDependency, useTasks } from "../../api/queries";
import type { Task, TaskRef } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { Grow, Picker, Row, RowAction, Section, Stack } from "../../layout";
import { dependencyError, TERMINAL } from "../../../tasks";
import { StateBadge } from "../board/StateBadge";

function Ref({ projectId, t, action }: { projectId: string; t: TaskRef; action?: React.ReactNode }) {
  return (
    <Row gap="sm" wrap="nowrap" data-dep={t.id}>
      <Grow>
        {/* Its title, then its state, together; only the row's action sits at the right. */}
        <Row gap="xs">
          <AnchorLink to="/projects/$projectId/board" params={{ projectId }} search={{ task: t.id }} fz="sm">
            {t.title}
          </AnchorLink>
          <StateBadge state={t.state} size="sm" />
        </Row>
      </Grow>
      {action}
    </Row>
  );
}

function RelationGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <Stack gap="sm" role="group" aria-label={label}>
      <Section title={label} count={count} dense region={false}>
        {count === 0 ? (
          <Text fz="sm" c="dimmed">
            Nothing
          </Text>
        ) : (
          <Stack gap="sm">{children}</Stack>
        )}
      </Section>
    </Stack>
  );
}

/** The status line: how many of its dependencies aren't done, and what that means. */
function status(task: Task): string | null {
  const n = task.blocked_by.length;
  if (n === 0) return null;
  const w = task.waiting_on.length;
  return w === 0 ? (n === 1 ? "Its 1 dependency is done" : `Its ${n} dependencies are done`) : `${w} of ${n} not done: can't be assigned yet`;
}

export function TaskDependencies({ projectId, task }: { projectId: string; task: Task }) {
  const tasks = useTasks(projectId);
  const add = useAddDependency(projectId);
  const remove = useRemoveDependency(projectId);
  const over = TERMINAL.has(task.state);
  // Only what the Worker would take: the pure rule (src/tasks.ts) over the board as the page has it.
  const all = tasks.data ?? [];
  const states = new Map(all.map((t) => [t.id, t.state]));
  const edges = all.flatMap((t) => t.blocked_by.map((b) => [t.id, b.id] as const));
  const items = all
    .filter((t) => !TERMINAL.has(t.state) && dependencyError(task.id, t.id, edges, states) === null)
    .map((t) => ({ value: t.id, label: t.title, keywords: t.id, end: <StateBadge state={t.state} size="sm" /> }));
  const confirmRemove = (b: TaskRef) => {
    const left = task.waiting_on.filter((id) => id !== b.id).length;
    modals.openConfirmModal({
      title: `Stop waiting on ${b.title}?`,
      children: <Text fz="md">{left === 0 ? "It can then be assigned." : `It still waits on ${left} other ${left === 1 ? "task" : "tasks"}.`}</Text>,
      labels: { confirm: "Stop waiting", cancel: "Cancel" },
      confirmProps: { color: "danger" },
      cancelProps: { variant: "default", "data-autofocus": true },
      onConfirm: () => remove.mutate({ task: task.id, blocker: b.id }),
    });
  };
  const line = status(task);
  return (
    <Section
      title="Dependencies"
      region={false}
      actions={
        !over && (
          <Picker
            label="Add dependency"
            icon={IconLink}
            items={items}
            searchLabel="A task it waits on"
            loading={tasks.isPending}
            busy={add.isPending}
            empty={(q) => (q ? `No task it may wait on matches "${q}"` : "No task it may wait on: not itself, nor one that's over or waits on it")}
            onPick={(v) => add.mutate({ task: task.id, blocked_by: v })}
          />
        )
      }
    >
      <Stack gap="lg">
        {line && (
          <Text fz="sm" c={task.waiting_on.length ? undefined : "dimmed"} data-marker="dependency-status">
            {line}
          </Text>
        )}
        {task.blocked_by.length === 0 && task.blocks.length === 0 ? (
          <Text fz="sm" c="dimmed">
            No dependencies
          </Text>
        ) : (
          <>
        <RelationGroup label="Waits on" count={task.blocked_by.length}>
          {task.blocked_by.map((b) => (
            <Ref
              key={b.id}
              projectId={projectId}
              t={b}
              action={
                !over && (
                  <RowAction variant="subtle" color="danger" loading={remove.isPending && remove.variables?.blocker === b.id} onClick={() => confirmRemove(b)} aria-label={`Stop waiting on ${b.title}`}>
                    Remove
                  </RowAction>
                )
              }
            />
          ))}
        </RelationGroup>
        <RelationGroup label="Blocks" count={task.blocks.length}>
          {task.blocks.map((b) => (
            <Ref key={b.id} projectId={projectId} t={b} />
          ))}
        </RelationGroup>
          </>
        )}
      </Stack>
    </Section>
  );
}

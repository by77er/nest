// A task's dependencies (README.md#dependencies): the tasks it waits on ("Waiting on"), each with its
// state, removable, and added through a searchable task picker; and the tasks that wait on it. Distinct
// from "Blocked", the flag an agent raises for the owner. A task waiting on one not done can't be assigned.

import { Button, Text } from "@mantine/core";
import { IconLink } from "@tabler/icons-react";
import { useAddDependency, useRemoveDependency, useTasks } from "../../api/queries";
import type { Task, TaskRef } from "../../api/types";
import { AnchorLink } from "../../common/links";
import { Row, Section, Stack } from "../../layout";
import { Switcher } from "../../layout/Switcher";
import { TERMINAL } from "../../../tasks";
import { StateBadge } from "../board/StateBadge";

function Ref({ projectId, t, action }: { projectId: string; t: TaskRef; action?: React.ReactNode }) {
  return (
    <Row gap="sm" justify="space-between" wrap="nowrap" data-dep={t.id}>
      <Row gap="sm" wrap="nowrap">
        <StateBadge state={t.state} size="sm" />
        <AnchorLink to="/projects/$projectId" params={{ projectId }} search={{ task: t.id }} fz="sm">
          {t.title}
        </AnchorLink>
      </Row>
      {action}
    </Row>
  );
}

export function TaskDependencies({ projectId, task }: { projectId: string; task: Task }) {
  const tasks = useTasks(projectId);
  const add = useAddDependency(projectId);
  const remove = useRemoveDependency(projectId);
  const over = TERMINAL.has(task.state);
  const taken = new Set([task.id, ...task.blocked_by.map((b) => b.id)]);
  const items = (tasks.data ?? []).filter((t) => !taken.has(t.id)).map((t) => ({ value: t.id, label: t.title, keywords: t.id }));
  const waiting = task.waiting_on.length;
  return (
    <Section title="Dependencies" count={task.blocked_by.length + task.blocks.length} region={false}>
      <Stack gap="lg">
        <Stack gap="sm">
          <Text fz="sm" fw="medium">
            {task.blocked_by.length === 0 ? "Waits on nothing" : waiting ? `Waiting on ${waiting} of ${task.blocked_by.length}: not assignable until done` : "Waited on, all done"}
          </Text>
          {task.blocked_by.map((b) => (
            <Ref
              key={b.id}
              projectId={projectId}
              t={b}
              action={
                !over && (
                  <Button size="xs" variant="subtle" color="danger" loading={remove.isPending && remove.variables?.blocker === b.id} onClick={() => remove.mutate({ task: task.id, blocker: b.id })} aria-label={`Stop waiting on ${b.title}`}>
                    Remove
                  </Button>
                )
              }
            />
          ))}
          {!over && (
            <Row>
              <Switcher
                icon={IconLink}
                current={{ label: "Wait on another task", ariaLabel: "Wait on another task" }}
                items={items}
                searchLabel="Search the project's tasks"
                empty={(q) => (q ? `No task matches "${q}"` : "No other tasks")}
                onPick={(v) => add.mutate({ task: task.id, blocked_by: v })}
              />
            </Row>
          )}
        </Stack>
        {task.blocks.length > 0 && (
          <Stack gap="sm">
            <Text fz="sm" fw="medium">
              Waited on by
            </Text>
            {task.blocks.map((b) => (
              <Ref key={b.id} projectId={projectId} t={b} />
            ))}
          </Stack>
        )}
      </Stack>
    </Section>
  );
}

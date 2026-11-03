// The Manager page's context column: what the manager is doing, the tasks it's working on (the active
// ones, newest first, as the task cards a message shows) and what needs the owner, linking to the Board.

import { Text } from "@mantine/core";
import { IconLayoutKanban } from "@tabler/icons-react";
import { useAttention, useTasks } from "../../api/queries";
import { ButtonLink } from "../../common/links";
import { icon, Section, Stack } from "../../layout";
import { TaskCardList } from "../rich/TaskRefs";
import { ManagerStatusLine } from "./ManagerStatus";

const ACTIVE = new Set(["assigned", "in_progress", "in_review", "stalled"]);
const RECENT_MS = 24 * 3600 * 1000;
const SHOWN = 5;

export function ManagerContext({ projectId }: { projectId: string }) {
  const tasks = useTasks(projectId).data ?? [];
  const needs = useAttention(projectId).data?.length ?? 0;
  // What it's on: tasks under way, and those just created; newest change first.
  const now = Date.now();
  const on = tasks
    .filter((t) => ACTIVE.has(t.state) || now - t.created_ms < RECENT_MS)
    .sort((a, b) => b.updated_ms - a.updated_ms)
    .slice(0, SHOWN);
  return (
    <Stack gap="xl" data-slot="manager-context">
      <Section title="Status" dense region={false}>
        <ManagerStatusLine projectId={projectId} />
      </Section>
      <Section title="Working on" count={on.length} dense region={false}>
        {on.length ? (
          <TaskCardList projectId={projectId} ids={on.map((t) => t.id)} />
        ) : (
          <Text fz="sm" c="dimmed">
            Nothing under way.
          </Text>
        )}
      </Section>
      <Section title="Needs you" count={needs} dense region={false}>
        <Stack gap="sm" align="flex-start">
          <Text fz="sm" c="dimmed">
            {needs ? `${needs} ${needs === 1 ? "thing waits" : "things wait"} on you on the board.` : "Nothing waits on you."}
          </Text>
          <ButtonLink to="/projects/$projectId/board" params={{ projectId }} search={{}} variant="default" size="xs" leftSection={<IconLayoutKanban size={icon.sm} />}>
            Open the board
          </ButtonLink>
        </Stack>
      </Section>
    </Stack>
  );
}


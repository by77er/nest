// A task's title and description (README.md#descriptions): read as the chat renders Markdown (the same
// safe path: no raw HTML, links only http, https and mailto), and edited in place with "Edit" while the
// task can change. A finished task (done, cancelled) is read only.

import { Button, Text } from "@mantine/core";
import { IconPencil } from "@tabler/icons-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Task } from "../../api/types";
import { icon, LoadingState, Section, Stack, weight } from "../../layout";
import { RichMessage } from "../rich/RichMessage";
// The editor (Tiptap) is loaded only when a task is edited.
const TaskEditForm = lazy(() => import("./TaskEditForm").then((m) => ({ default: m.TaskEditForm })));

export function TaskDescription({ projectId, task, readOnly }: { projectId: string; task: Task; readOnly: boolean }) {
  const [editing, setEditing] = useState(false);
  const edit = editing && !readOnly;
  // Back from the form (saved or not), focus returns to the Edit button that opened it.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !edit) editButton.current?.focus();
    wasEditing.current = edit;
  }, [edit]);
  return (
    <Section
      title="Description"
      region={false}
      actions={!readOnly && !edit && (
        <Button ref={editButton} variant="default" size="xs" leftSection={<IconPencil size={icon.sm} aria-hidden />} onClick={() => setEditing(true)} aria-label="Edit the title and description">
          Edit
        </Button>
      )}
    >
      {edit ? (
        <Suspense fallback={<LoadingState label="Loading the editor" />}>
          <TaskEditForm projectId={projectId} task={task} onDone={() => setEditing(false)} />
        </Suspense>
      ) : (
        <Stack gap="sm" data-slot="description">
          <Text fz="lg" fw={weight.bold} data-slot="title">
            {task.title}
          </Text>
          {task.body.trim() ? (
            <RichMessage text={task.body} projectId={projectId} />
          ) : (
            <Text c="dimmed">No description yet.</Text>
          )}
        </Stack>
      )}
    </Section>
  );
}

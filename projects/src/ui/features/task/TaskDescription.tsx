// A task's description (README.md#descriptions): read as the chat renders Markdown (the same safe path:
// no raw HTML, links only http, https and mailto), and edited in place with "Edit" while the task can
// change; a finished task (done, cancelled) is read only. Its title is the drawer's heading.
//
// While editing, Cancel and Save are the section's actions (top right, always in view), and leaving with
// unsaved changes, by Cancel, Escape, or closing the drawer, asks first ("Discard changes?", Keep
// editing the default). The editor's code (Tiptap) loads only for editing: fetched ahead when the drawer
// is idle or the pointer or focus reaches Edit, and until it's in, the description stays as it reads, so
// nothing below it moves twice.

import { Button, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import { IconPencil } from "@tabler/icons-react";
import { lazy, type MutableRefObject, Suspense, useEffect, useId, useRef, useState } from "react";
import type { Task } from "../../api/types";
import { icon, Section, Stack } from "../../layout";
import { RichMessage } from "../rich/RichMessage";
import type { EditState } from "./TaskEditForm";

const loadEditForm = () => import("./TaskEditForm");
const TaskEditForm = lazy(() => loadEditForm().then((m) => ({ default: m.TaskEditForm })));

/** Ask before unsaved changes are dropped; `then` drops them. Keep editing is the default. */
export function confirmDiscard(then: () => void) {
  modals.openConfirmModal({
    title: "Discard changes?",
    children: <Text fz="md">Your changes to this task's title and description aren't saved.</Text>,
    labels: { confirm: "Discard", cancel: "Keep editing" },
    confirmProps: { color: "danger" },
    cancelProps: { variant: "default", "data-autofocus": true },
    onConfirm: then,
  });
}

function ReadView({ projectId, task }: { projectId: string; task: Task }) {
  return (
    <Stack gap="sm" data-slot="description">
      {task.body.trim() ? <RichMessage text={task.body} projectId={projectId} /> : <Text c="dimmed">No description yet.</Text>}
    </Stack>
  );
}

export function TaskDescription({ projectId, task, readOnly, editing, onEditing, dirty }: {
  projectId: string; task: Task; readOnly: boolean;
  /** Whether it's being edited, held by the drawer (whose close and Escape depend on it). */
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** Whether the form has unsaved changes, for the drawer's close. */
  dirty: MutableRefObject<boolean>;
}) {
  const edit = editing && !readOnly;
  const formId = `edit-${useId().replace(/:/g, "")}`;
  const [state, setState] = useState<EditState>({ dirty: false, pending: false });
  useEffect(() => {
    dirty.current = edit && state.dirty;
  }, [edit, state.dirty, dirty]);

  // Back from the form (saved or not), focus returns to the Edit button that opened it.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !edit) editButton.current?.focus();
    wasEditing.current = edit;
    if (!edit) setState({ dirty: false, pending: false });
  }, [edit]);

  // Fetch the editor ahead, once the drawer is idle.
  useEffect(() => {
    if (readOnly) return;
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const h = idle(() => void loadEditForm());
    return () => cancel(h);
  }, [readOnly]);

  const leave = () => onEditing(false);
  const cancel = () => (state.dirty ? confirmDiscard(leave) : leave());

  return (
    <Section
      title="Description"
      region={false}
      actions={
        readOnly ? null : edit ? (
          <>
            <Button variant="subtle" color="danger" size="xs" onClick={cancel}>
              Cancel
            </Button>
            <Button type="submit" form={formId} size="xs" disabled={!state.dirty} loading={state.pending}>
              Save
            </Button>
          </>
        ) : (
          <Button
            ref={editButton}
            variant="default"
            size="xs"
            leftSection={<IconPencil size={icon.sm} aria-hidden />}
            onClick={() => onEditing(true)}
            onPointerEnter={() => void loadEditForm()}
            onFocus={() => void loadEditForm()}
            aria-label="Edit the title and description"
          >
            Edit
          </Button>
        )
      }
    >
      {edit ? (
        <Suspense fallback={<ReadView projectId={projectId} task={task} />}>
          <TaskEditForm projectId={projectId} task={task} formId={formId} onDone={leave} onCancel={cancel} onState={setState} />
        </Suspense>
      ) : (
        <ReadView projectId={projectId} task={task} />
      )}
    </Section>
  );
}

// A task's title and description, edited (README.md#descriptions): the description in the rich editor,
// saved as Markdown. Only what changed is sent, so a description no one touched is never rewritten in
// the editor's own Markdown. Its Cancel and Save are its section's (TaskDescription), at the top right of
// the Description heading, so they're in view however long the description; Save submits this form by
// its id. Escape is Cancel (a popover's Escape, the link editor's, only closes the popover).

import { TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { type KeyboardEvent, useEffect } from "react";
import { UpdateTask } from "../../../requests";
import { normalized } from "../../rich/editor-markdown";
import { useUpdateTask } from "../../api/queries";
import type { Task } from "../../api/types";
import { FieldGroup } from "../../layout";
import { DescriptionField } from "../rich/DescriptionField";

export interface EditState {
  dirty: boolean;
  pending: boolean;
}

export function TaskEditForm({ projectId, task, formId, onDone, onCancel, onState }: {
  projectId: string; task: Task; formId: string;
  /** Saved (or nothing to save): leave the form. */
  onDone: () => void;
  /** Cancel asked for (Escape): the section asks first if there are changes. */
  onCancel: () => void;
  onState: (s: EditState) => void;
}) {
  const update = useUpdateTask(projectId);
  // The description as the editor would save it untouched: the baseline an edit is measured from.
  const initial = () => ({ title: task.title, body: normalized(task.body) });
  const form = useForm({ initialValues: initial(), validate: schemaResolver(UpdateTask, { sync: true }) });

  // Another writer (the manager) changed it: take the new text unless the owner is mid-edit.
  useEffect(() => {
    if (form.isDirty()) return;
    const next = initial();
    form.setInitialValues(next);
    form.setValues(next);
  }, [task.title, task.body]); // `form` is stable across renders

  const dirty = form.isDirty();
  useEffect(() => onState({ dirty, pending: update.isPending }), [dirty, update.isPending]);

  const escape = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    // The link editor's popover closes on its own Escape; the form stays.
    if ((e.target as HTMLElement).closest(".mantine-Popover-dropdown")) return;
    e.preventDefault();
    onCancel();
  };

  return (
    <form
      id={formId}
      onKeyDown={escape}
      onSubmit={form.onSubmit((v) => {
        const title = v.title.trim();
        const change = { ...(title !== task.title ? { title } : {}), ...(form.isDirty("body") ? { body: v.body } : {}) };
        if (Object.keys(change).length === 0) return onDone();
        update.mutate({ task: task.id, ...change }, { onSuccess: onDone });
      })}
    >
      <FieldGroup>
        {/* Focus goes to the first field as the form opens (its Edit button is gone). */}
        <TextInput label="Title" withAsterisk maxLength={200} autoFocus {...form.getInputProps("title")} />
        <DescriptionField value={form.values.body} onChange={(md) => form.setFieldValue("body", md)} error={form.errors.body} />
      </FieldGroup>
    </form>
  );
}

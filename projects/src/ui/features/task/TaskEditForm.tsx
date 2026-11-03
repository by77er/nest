// A task's title and description, edited (README.md#descriptions): the description in the rich editor,
// saved as Markdown. Only what changed is sent, so a description no one touched is never rewritten in
// the editor's own Markdown.

import { Button, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useEffect } from "react";
import { UpdateTask } from "../../../requests";
import { normalized } from "../../rich/editor-markdown";
import { useUpdateTask } from "../../api/queries";
import type { Task } from "../../api/types";
import { FieldGroup } from "../../layout";
import { DescriptionField } from "../rich/DescriptionField";

export function TaskEditForm({ projectId, task, onDone }: { projectId: string; task: Task; onDone: () => void }) {
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

  return (
    <form
      onSubmit={form.onSubmit((v) => {
        const title = v.title.trim();
        const change = { ...(title !== task.title ? { title } : {}), ...(form.isDirty("body") ? { body: v.body } : {}) };
        if (Object.keys(change).length === 0) return onDone();
        update.mutate({ task: task.id, ...change }, { onSuccess: onDone });
      })}
    >
      <FieldGroup
        actions={
          <>
            <Button variant="subtle" color="danger" onClick={() => { form.reset(); onDone(); }}>
              {form.isDirty() ? "Discard changes" : "Cancel"}
            </Button>
            <Button type="submit" disabled={!form.isDirty()} loading={update.isPending}>
              Save
            </Button>
          </>
        }
      >
        {/* Focus goes to the first field as the form opens (its Edit button is gone). */}
        <TextInput label="Title" withAsterisk maxLength={200} autoFocus {...form.getInputProps("title")} />
        <DescriptionField value={form.values.body} onChange={(md) => form.setFieldValue("body", md)} error={form.errors.body} />
      </FieldGroup>
    </form>
  );
}

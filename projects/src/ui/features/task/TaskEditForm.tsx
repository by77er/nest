// A task's title and body, edited in place. A finished task (done, cancelled) can't change.

import { Button, Textarea, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { useEffect } from "react";
import { UpdateTask } from "../../../requests";
import { useUpdateTask } from "../../api/queries";
import type { Task } from "../../api/types";
import { FieldGroup } from "../../layout";

export function TaskEditForm({ projectId, task, readOnly }: { projectId: string; task: Task; readOnly: boolean }) {
  const update = useUpdateTask(projectId);
  const form = useForm({ initialValues: { title: task.title, body: task.body }, validate: schemaResolver(UpdateTask, { sync: true }) });

  // Another writer (the manager) changed it: take the new text unless the owner is mid-edit.
  useEffect(() => {
    if (form.isDirty()) return;
    const next = { title: task.title, body: task.body };
    form.setInitialValues(next);
    form.setValues(next);
  }, [task.title, task.body]); // `form` is stable across renders

  return (
    <form
      onSubmit={form.onSubmit((v) =>
        update.mutate({ task: task.id, title: v.title.trim(), body: v.body }, { onSuccess: (t) => form.setInitialValues({ title: t.title, body: t.body }) }))}
    >
      <FieldGroup
        actions={
          !readOnly && (
            <>
              <Button variant="subtle" color="danger" disabled={!form.isDirty()} onClick={() => form.reset()}>
                Discard changes
              </Button>
              <Button type="submit" disabled={!form.isDirty()} loading={update.isPending}>
                Save
              </Button>
            </>
          )
        }
      >
        <TextInput label="Title" withAsterisk maxLength={200} readOnly={readOnly} {...form.getInputProps("title")} />
        <Textarea label="Details" autosize minRows={3} maxRows={16} readOnly={readOnly} {...form.getInputProps("body")} />
      </FieldGroup>
    </form>
  );
}

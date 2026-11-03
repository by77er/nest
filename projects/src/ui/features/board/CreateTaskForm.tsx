// A new task: a title and a description (in the rich editor, saved as Markdown, README.md#descriptions).
// It starts as a draft, and the manager specs it.

import { Button, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { CreateTask } from "../../../requests";
import { useCreateTask } from "../../api/queries";
import type { Task } from "../../api/types";
import { FieldGroup } from "../../layout";
import { DescriptionField } from "../rich/DescriptionField";

export function CreateTaskForm({ projectId, onCreated, onCancel }: { projectId: string; onCreated: (t: Task) => void; onCancel?: () => void }) {
  const create = useCreateTask(projectId);
  const form = useForm({ initialValues: { title: "", body: "" }, validate: schemaResolver(CreateTask, { sync: true }) });

  return (
    <form onSubmit={form.onSubmit((v) => create.mutate({ title: v.title.trim(), body: v.body }, { onSuccess: onCreated }))}>
      <FieldGroup
        actions={
          <>
            {onCancel && (
              <Button variant="subtle" color="danger" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" loading={create.isPending}>
              Create task
            </Button>
          </>
        }
      >
        <TextInput label="Title" withAsterisk maxLength={200} data-autofocus {...form.getInputProps("title")} />
        <DescriptionField
          value={form.values.body}
          onChange={(md) => form.setFieldValue("body", md)}
          description="What it's for and anything the manager should know to spec it."
          error={form.errors.body}
        />
      </FieldGroup>
    </form>
  );
}

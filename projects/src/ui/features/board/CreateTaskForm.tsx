// A new task: a title and a body. It starts as a draft, and the manager specs it.

import { Button, Group, Stack, Textarea, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { CreateTask } from "../../../requests";
import { useCreateTask } from "../../api/queries";
import type { Task } from "../../api/types";

export function CreateTaskForm({ projectId, onCreated, onCancel }: { projectId: string; onCreated: (t: Task) => void; onCancel?: () => void }) {
  const create = useCreateTask(projectId);
  const form = useForm({ mode: "uncontrolled", initialValues: { title: "", body: "" }, validate: schemaResolver(CreateTask, { sync: true }) });

  return (
    <form onSubmit={form.onSubmit((v) => create.mutate({ title: v.title.trim(), body: v.body }, { onSuccess: onCreated }))}>
      <Stack gap="sm">
        <TextInput label="Title" withAsterisk maxLength={200} data-autofocus key={form.key("title")} {...form.getInputProps("title")} />
        <Textarea label="Details" description="What it's for and anything the manager should know to spec it." autosize minRows={4} maxRows={14} key={form.key("body")} {...form.getInputProps("body")} />
        <Group justify="flex-end" mt="xs">
          {onCancel && (
            <Button variant="subtle" color="danger" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={create.isPending}>
            Create task
          </Button>
        </Group>
      </Stack>
    </form>
  );
}

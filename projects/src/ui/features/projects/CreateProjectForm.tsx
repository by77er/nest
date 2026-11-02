// A new project: its name, its GitHub repo, and how it assigns work. Checked with the Worker's own
// schema (src/requests.ts) before it's sent.

import { Button, NumberInput, Switch, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { CreateProject } from "../../../requests";
import { useCreateProject } from "../../api/queries";
import type { CreatedProject } from "../../api/types";
import { FieldGroup } from "../../layout";

export function CreateProjectForm({ onCreated, onCancel }: { onCreated: (p: CreatedProject) => void; onCancel?: () => void }) {
  const create = useCreateProject();
  const form = useForm({
    mode: "uncontrolled",
    initialValues: { name: "", repo: "", auto_assign: false, max_workers: 2 },
    validate: schemaResolver(CreateProject, { sync: true }),
  });

  return (
    <form onSubmit={form.onSubmit((v) => create.mutate({ ...v, repo: v.repo.trim() }, { onSuccess: onCreated }))}>
      <FieldGroup
        actions={
          <>
            {onCancel && (
              <Button variant="subtle" color="danger" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" loading={create.isPending}>
              Create project
            </Button>
          </>
        }
      >
        <TextInput label="Name" withAsterisk data-autofocus key={form.key("name")} {...form.getInputProps("name")} />
        <TextInput
          label="Repository"
          description="On GitHub, as owner/name. nest's GitHub App must be installed on it."
          placeholder="owner/name"
          withAsterisk
          autoComplete="off"
          spellCheck={false}
          key={form.key("repo")}
          {...form.getInputProps("repo")}
        />
        <Switch
          label="Assign ready tasks automatically"
          description="In board order, while live workers stay under the cap."
          key={form.key("auto_assign")}
          {...form.getInputProps("auto_assign", { type: "checkbox" })}
        />
        <NumberInput label="Max workers" min={0} max={20} allowDecimal={false} clampBehavior="strict" key={form.key("max_workers")} {...form.getInputProps("max_workers")} />
      </FieldGroup>
    </form>
  );
}

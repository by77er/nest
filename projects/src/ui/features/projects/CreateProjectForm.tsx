// A new project: its name, its GitHub repo, and how it assigns work. Checked with the Worker's own
// schema (src/requests.ts) before it's sent. The repo is picked from those nest's grant lets the app
// attach (GET /api/repos: nest decides, owner-wide entries included); a repo already a project's is
// shown but can't be picked. If the list can't be had, the name is typed, as before.

import { Button, NumberInput, Select, Switch, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { CreateProject } from "../../../requests";
import { useAttachableRepos, useCreateProject } from "../../api/queries";
import type { AttachableRepos, CreatedProject } from "../../api/types";
import { FieldGroup } from "../../layout";

/** What the picker says under its label: where the repos come from, and what it couldn't list. */
function pickerDescription(r: AttachableRepos): string {
  const said = ["Repos nest's grant lets the app work in, on which nest's GitHub App is installed."];
  if (!r.repos.length) said.push("None yet: the operator adds repos to the app's grant in nest.");
  if (r.unlisted.length) said.push(`Not listed: ${r.unlisted.map((e) => e.replace(/\/\*$/, "")).join(", ")}'s repos (the App isn't installed there).`);
  if (!r.complete) said.push("Only an owner's first 1000 repos are listed.");
  return said.join(" ");
}

export function CreateProjectForm({ onCreated, onCancel }: { onCreated: (p: CreatedProject) => void; onCancel?: () => void }) {
  const create = useCreateProject();
  const repos = useAttachableRepos();
  const form = useForm({
    mode: "uncontrolled",
    initialValues: { name: "", repo: "", auto_assign: false, max_workers: 2 },
    validate: schemaResolver(CreateProject, { sync: true }),
  });

  return (
    <form onSubmit={form.onSubmit((v) => create.mutate({ ...v, repo: (v.repo ?? "").trim() }, { onSuccess: onCreated }))}>
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
        {repos.isError ? (
          <TextInput
            label="Repository"
            description="On GitHub, as owner/name. nest's GitHub App must be installed on it. (The repos nest's grant covers couldn't be listed.)"
            placeholder="owner/name"
            withAsterisk
            autoComplete="off"
            spellCheck={false}
            key={form.key("repo")}
            {...form.getInputProps("repo")}
          />
        ) : (
          <Select
            label="Repository"
            description={repos.data ? pickerDescription(repos.data) : "Loading the repos nest's grant covers…"}
            placeholder={repos.data ? "Pick a repo" : "Loading…"}
            withAsterisk
            searchable
            nothingFoundMessage="No repo matches"
            disabled={!repos.data || repos.data.repos.length === 0}
            data={(repos.data?.repos ?? []).map((r) => ({ value: r.repo, label: r.project ? `${r.repo} (already a project)` : r.repo, disabled: r.project !== null }))}
            key={form.key("repo")}
            {...form.getInputProps("repo")}
          />
        )}
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

// A new project: its name, its GitHub repo, and how it assigns work. Checked with the Worker's own
// schema (src/requests.ts) before it's sent. The repo is picked from those the GitHub App reaches
// (GET /api/repos: GitHub decides, each installation's own repos, on the accounts the app acts for); a repo
// already a project's is shown but can't be picked. A repo missing from the list is added on GitHub (the App's
// installation page, linked); one the list may not show (an installation it couldn't read, or past its cap) can be
// typed, and the Worker checks it at create. If the list can't be had at all, the name is typed.

import { Anchor, Button, NumberInput, Select, Switch, Text, TextInput } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { type ReactNode, useState } from "react";
import { CreateProject } from "../../../requests";
import { useAttachableRepos, useCreateProject } from "../../api/queries";
import type { AttachableRepos, CreatedProject } from "../../api/types";
import { FieldGroup, Notice, Stack } from "../../layout";

/**
 * "on GitHub", linking the App's installation page there (where it's installed on an account, or an installation's
 * repos are chosen): short and unbroken, so it's one tap target on a phone. Plain words when the App isn't named.
 */
function OnGitHub({ r }: { r: AttachableRepos }) {
  if (!r.app) return <>on&nbsp;GitHub</>;
  return (
    <Anchor href={r.app.install_url} target="_blank" rel="noreferrer" inherit lh="lg" data-inline>
      on&nbsp;GitHub
    </Anchor>
  );
}

/** The App, by name when the Worker knows it: one term throughout. */
const theApp = (r: AttachableRepos) => (r.app ? `the GitHub App ${r.app.slug}` : "the GitHub App");

/** What the picker says under its label: where the repos come from (and, when there are none, that there are none). */
function pickerDescription(r: AttachableRepos): string {
  const said = `Repos ${theApp(r)} is installed on.`;
  return r.repos.length ? said : `${said} None yet.`;
}

/** The line under the picker: how a repo that's missing (or, with none, the first one) gets added, on GitHub. */
function addRepoLine(r: AttachableRepos): ReactNode {
  return r.repos.length ? (
    <>
      Missing one? Add it to the App&apos;s installation <OnGitHub r={r} />, then reopen this form.
    </>
  ) : (
    <>
      Install the App on an account, or add repos to an installation it already has (<OnGitHub r={r} />), then reopen this form.
    </>
  );
}

/** What GitHub couldn't list, said apart from the field's description, one line each: installations it didn't answer for, and the cap. */
function unlistedNote(r: AttachableRepos): string[] {
  const said: string[] = [];
  if (r.unlisted.length) said.push(`The App's repos on ${r.unlisted.join(", ")} couldn't be listed just now: reopen this form to try again, or type the repo.`);
  if (!r.complete) said.push("Only an installation's first 1000 repos are listed: type a repo that isn't.");
  return said;
}

/** The picker's options: repos that can be picked first, then those already a project's (shown, disabled); each group in the Worker's order. */
function pickerOptions(r: AttachableRepos | undefined) {
  const repos = r?.repos ?? [];
  return [...repos.filter((x) => x.project === null), ...repos.filter((x) => x.project !== null)]
    .map((x) => ({ value: x.repo, label: x.project ? `${x.repo} (already a project)` : x.repo, disabled: x.project !== null }));
}

export function CreateProjectForm({ onCreated, onCancel }: { onCreated: (p: CreatedProject) => void; onCancel?: () => void }) {
  const create = useCreateProject();
  const repos = useAttachableRepos();
  // The owner's choice to type a repo the list may not show (an installation it couldn't read, or past its cap).
  const [typing, setTyping] = useState(false);
  const partial = repos.data !== undefined && (repos.data.unlisted.length > 0 || !repos.data.complete);
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
            {/* Nothing to pick: nothing to create (the typed fallback, when the list can't be had, stays open). */}
            <Button type="submit" loading={create.isPending} disabled={!typing && repos.data !== undefined && repos.data.repos.length === 0}>
              Create project
            </Button>
          </>
        }
      >
        <TextInput label="Name" withAsterisk data-autofocus key={form.key("name")} {...form.getInputProps("name")} />
        {repos.isError || typing ? (
          <TextInput
            label="Repository"
            description={
              repos.isError
                ? "The repos couldn't be listed just now. Type it as owner/name: the GitHub App must be installed on it."
                : "As owner/name. The GitHub App must reach it; that's checked when the project is created."
            }
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
            description={repos.data ? pickerDescription(repos.data) : "Loading the repos the GitHub App is installed on…"}
            placeholder={repos.data ? "Pick a repo" : "Loading…"}
            withAsterisk
            searchable
            nothingFoundMessage={
              repos.data ? (
                <>
                  No repo matches. Add it to the App&apos;s installation <OnGitHub r={repos.data} />, then reopen this form.
                </>
              ) : (
                "No repo matches"
              )
            }
            disabled={!repos.data || repos.data.repos.length === 0}
            data={pickerOptions(repos.data)}
            key={form.key("repo")}
            {...form.getInputProps("repo")}
          />
        )}
        {repos.data && !typing && (
          <Text size="sm" lh="lg">
            {addRepoLine(repos.data)}
          </Text>
        )}
        {repos.data && partial && (
          <Notice tone="info" title="Some repos aren't listed">
            <Stack gap="xs" align="flex-start">
              {unlistedNote(repos.data).map((line) => (
                <Text key={line} inherit>
                  {line}
                </Text>
              ))}
              <Button variant="default" onClick={() => setTyping((t) => !t)}>
                {typing ? "Pick from the list" : "Type a repo instead"}
              </Button>
            </Stack>
          </Notice>
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

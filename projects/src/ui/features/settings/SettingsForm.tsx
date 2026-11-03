// A project's settings: whether ready tasks are assigned automatically, how many workers may run, and
// whether task PRs merge automatically once their review passes (with the repo's setting behind it).
// The two Panels sit in one row with Save right under them at the bottom right; on a phone, one column,
// so Save comes right after the last field.

import { Badge, Button, NumberInput, Select, Switch, Text } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { Settings as SettingsSchema } from "../../../requests";
import { useRetryRepoAutoMerge, useUpdateSettings } from "../../api/queries";
import type { Settings } from "../../api/types";
import { ago, exact } from "../../common/time";
import { FieldGroup, MetaItem, Notice, Panel, Row, Section, SectionGrid, Stack, Toolbar, weight } from "../../layout";
import { MERGE_METHODS, type MergeMethod, type RepoAutoMerge } from "../../../automerge";

const METHOD_LABEL: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

const values = (s: Settings) => ({ auto_assign: s.auto_assign, max_workers: s.max_workers, auto_merge: s.auto_merge, merge_method: s.merge_method });

/** The editable settings as Panels in a row, saved together by the one Save right under them. */
export function SettingsForm({ projectId, settings, onDone }: { projectId: string; settings: Settings; onDone?: () => void }) {
  const update = useUpdateSettings(projectId);
  const form = useForm({
    initialValues: values(settings),
    validate: schemaResolver(SettingsSchema, { sync: true }),
  });

  return (
    <form
      onSubmit={form.onSubmit((v) =>
        update.mutate(v, {
          onSuccess: (s) => {
            form.setInitialValues(values(s));
            notifications.show({ color: "success", message: "Settings saved" });
            onDone?.();
          },
        }))}
    >
      <Stack gap="xl">
        <SectionGrid>
          <Panel>
            <Section title="Workers" order={4} region={false}>
              <FieldGroup>
                <Switch
                  label="Assign ready tasks automatically"
                  description="In board order, while the project's live workers are fewer than the cap."
                  {...form.getInputProps("auto_assign", { type: "checkbox" })}
                />
                <NumberInput
                  label="Max workers"
                  description="Caps auto-assign and the manager's assigning. Your own assigning isn't capped."
                  min={0}
                  max={20}
                  allowDecimal={false}
                  clampBehavior="strict"
                  {...form.getInputProps("max_workers")}
                />
              </FieldGroup>
            </Section>
          </Panel>
          <Panel>
            <Section title="Auto-merge" order={4} region={false}>
              <FieldGroup>
                <Switch
                  label="Auto-merge when review passes"
                  description="Each task's PR merges once the review check and the branch's other rules pass. Turns on the repo's “Allow auto-merge”."
                  {...form.getInputProps("auto_merge", { type: "checkbox" })}
                />
                <Select
                  label="Merge method"
                  data={MERGE_METHODS.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
                  allowDeselect={false}
                  disabled={!form.getValues().auto_merge}
                  {...form.getInputProps("merge_method")}
                />
                <RepoAutoMergeStatus projectId={projectId} status={settings.repo_auto_merge} />
              </FieldGroup>
            </Section>
          </Panel>
        </SectionGrid>
        <Toolbar>
          {onDone && (
            <Button variant="subtle" color="danger" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty()}>
            Save settings
          </Button>
        </Toolbar>
      </Stack>
    </form>
  );
}

const STATE: Record<Exclude<RepoAutoMerge["state"], "none">, { label: string; color: string }> = {
  applied: { label: "Applied", color: "success" },
  pending: { label: "Pending", color: "primary" },
  error: { label: "Error", color: "danger" },
  drifted: { label: "Changed on GitHub", color: "warning" },
};

/** The repo's "Allow auto-merge" as the app last wrote or read it, with a retry when it isn't as set. */
export function RepoAutoMergeStatus({ projectId, status }: { projectId: string; status: RepoAutoMerge }) {
  const retry = useRetryRepoAutoMerge(projectId);
  if (status.state === "none") return null;
  const s = STATE[status.state];
  const allows = status.repo === null ? null : status.repo ? "allows" : "doesn't allow";
  const action = (label: string) => (
    <Row>
      <Button size="xs" variant="default" loading={retry.isPending} onClick={() => retry.mutate()}>
        {label}
      </Button>
    </Row>
  );
  return (
    <Stack gap="sm" aria-live="polite">
      <Row gap="sm">
        <Text size="sm" fw={weight.medium}>
          Repo setting
        </Text>
        <Badge color={s.color} variant="light">
          {s.label}
        </Badge>
        {allows && status.at_ms !== null && (
          <MetaItem title={exact(status.at_ms)}>
            The repo {allows} auto-merge, {ago(status.at_ms)}
          </MetaItem>
        )}
      </Row>
      {status.state === "error" && (
        <Notice tone="danger" title="GitHub refused the repo setting">
          <Stack gap="sm">
            <Text size="sm">{status.error}</Text>
            {action("Try again")}
          </Stack>
        </Notice>
      )}
      {status.state === "drifted" && (
        <Notice tone="warning" title="Changed on GitHub">
          <Stack gap="sm">
            <Text size="sm">Someone changed the repo's “Allow auto-merge” since the app set it.</Text>
            {action(status.want ? "Allow it again" : "Disallow it again")}
          </Stack>
        </Notice>
      )}
      {status.state === "pending" && status.error && <MetaItem>Retrying: {status.error}</MetaItem>}
    </Stack>
  );
}

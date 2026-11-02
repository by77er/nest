// A project's settings: whether ready tasks are assigned automatically, how many workers may run, and
// whether task PRs merge automatically once their review passes (with the repo's setting behind it).

import { Alert, Badge, Button, Group, NumberInput, Select, Stack, Switch, Text } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle } from "@tabler/icons-react";
import { MERGE_METHODS, type MergeMethod, type RepoAutoMerge } from "../../../automerge";
import { Settings as SettingsSchema } from "../../../requests";
import { useRetryRepoAutoMerge, useUpdateSettings } from "../../api/queries";
import type { Settings } from "../../api/types";
import { ago, exact } from "../../common/time";

const METHOD_LABEL: Record<MergeMethod, string> = { squash: "Squash and merge", merge: "Merge commit", rebase: "Rebase and merge" };

const values = (s: Settings) => ({ auto_assign: s.auto_assign, max_workers: s.max_workers, auto_merge: s.auto_merge, merge_method: s.merge_method });

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
      <Stack gap="md">
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
        <Group justify="flex-end" gap="xs">
          {onDone && (
            <Button variant="subtle" color="danger" onClick={onDone}>
              Cancel
            </Button>
          )}
          <Button type="submit" loading={update.isPending} disabled={!form.isDirty()}>
            Save settings
          </Button>
        </Group>
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
    <Button size="xs" variant="default" loading={retry.isPending} onClick={() => retry.mutate()}>
      {label}
    </Button>
  );
  return (
    <Stack gap="xs" aria-live="polite">
      <Group gap="xs">
        <Text size="sm" fw={500}>
          Repo setting
        </Text>
        <Badge color={s.color} variant="light">
          {s.label}
        </Badge>
        {allows && status.at_ms !== null && (
          <Text size="xs" c="dimmed" title={exact(status.at_ms)}>
            The repo {allows} auto-merge, {ago(status.at_ms)}
          </Text>
        )}
      </Group>
      {status.state === "error" && (
        <Alert color="danger" variant="light" icon={<IconAlertTriangle size={18} />} title="GitHub refused the repo setting">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{status.error}</Text>
            {action("Try again")}
          </Stack>
        </Alert>
      )}
      {status.state === "drifted" && (
        <Alert color="warning" variant="light" icon={<IconAlertTriangle size={18} />} title="Changed on GitHub">
          <Stack gap="xs" align="flex-start">
            <Text size="sm">Someone changed the repo's “Allow auto-merge” since the app set it.</Text>
            {action(status.want ? "Allow it again" : "Disallow it again")}
          </Stack>
        </Alert>
      )}
      {status.state === "pending" && status.error && (
        <Text size="xs" c="dimmed">
          Retrying: {status.error}
        </Text>
      )}
    </Stack>
  );
}

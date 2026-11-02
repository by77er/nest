// A project's settings: whether ready tasks are assigned automatically, and how many workers may run.

import { Button, NumberInput, Switch } from "@mantine/core";
import { schemaResolver, useForm } from "@mantine/form";
import { notifications } from "@mantine/notifications";
import { Settings as SettingsSchema } from "../../../requests";
import { useUpdateSettings } from "../../api/queries";
import type { Settings } from "../../api/types";
import { FieldGroup } from "../../layout";

export function SettingsForm({ projectId, settings, onDone }: { projectId: string; settings: Settings; onDone?: () => void }) {
  const update = useUpdateSettings(projectId);
  const form = useForm({
    initialValues: { auto_assign: settings.auto_assign, max_workers: settings.max_workers },
    validate: schemaResolver(SettingsSchema, { sync: true }),
  });

  return (
    <form
      onSubmit={form.onSubmit((v) =>
        update.mutate(v, {
          onSuccess: (s) => {
            form.setInitialValues({ auto_assign: s.auto_assign, max_workers: s.max_workers });
            notifications.show({ color: "success", message: "Settings saved" });
            onDone?.();
          },
        }))}
    >
      <FieldGroup
        actions={
          <>
            {onDone && (
              <Button variant="subtle" color="danger" onClick={onDone}>
                Cancel
              </Button>
            )}
            <Button type="submit" loading={update.isPending} disabled={!form.isDirty()}>
              Save settings
            </Button>
          </>
        }
      >
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
    </form>
  );
}

// Adding or editing one of the project's reviewers (README.md#reviewers), in a Sheet: its name, its
// instructions, its dimensions (1 to 6, each judged pass or fail) and whether it's on. Checked with the
// Worker's own schema before it's sent; the Worker's refusal is shown here. Every field is sent, so a save
// makes a tainted reviewer's text the owner's, as the notice at the top says.

import { ActionIcon, Button, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { NewReviewer, REVIEWER_LIMITS } from "../../../requests";
import { ApiError } from "../../api/client";
import { useCreateReviewer, useUpdateReviewer } from "../../api/queries";
import type { Reviewer } from "../../api/types";
import { FieldGroup, icon, Notice, Row, Section, Stack } from "../../layout";
import { taintedText } from "../routines/Untrusted";

interface Draft {
  name: string;
  instructions: string;
  dimensions: string[];
  enabled: boolean;
}

const draftOf = (r?: Reviewer): Draft => ({ name: r?.name ?? "", instructions: r?.instructions ?? "", dimensions: r ? [...r.dimensions] : [""], enabled: r?.enabled ?? true });

/**
 * What's wrong with a draft, by field, in the Worker's words: `name`, `instructions`, `dimension.<i>` for one
 * dimension (a repeated name on its second use), and `dimensions` for the list as a whole.
 */
export function problems(d: Draft): Record<string, string> {
  const r = NewReviewer.safeParse(d);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const i of r.error.issues) {
    const [field, at] = i.path;
    if (field === "dimensions" && typeof at === "number") out[`dimension.${at}`] ??= i.message;
    else if (field === "dimensions") {
      const keys = d.dimensions.map((x) => x.trim().toLowerCase());
      const again = keys.findIndex((k, n) => k !== "" && keys.indexOf(k) < n);
      out[again >= 0 ? `dimension.${again}` : "dimensions"] ??= i.message;
    } else out[String(field)] ??= i.message;
  }
  return out;
}

export function ReviewerForm({ projectId, editing, onDone }: { projectId: string; editing?: Reviewer; onDone: () => void }) {
  const create = useCreateReviewer(projectId);
  const update = useUpdateReviewer(projectId);
  const [d, setD] = useState<Draft>(() => draftOf(editing));
  const [tried, setTried] = useState(false);
  const errs = tried ? problems(d) : {};
  const saving = create.isPending || update.isPending;
  const failed = create.error ?? update.error;
  const max = REVIEWER_LIMITS.dimensions;
  const setDimension = (i: number, v: string) => setD((x) => ({ ...x, dimensions: x.dimensions.map((y, n) => (n === i ? v : y)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (Object.keys(problems(d)).length) return;
    const body = { name: d.name, instructions: d.instructions, dimensions: d.dimensions, enabled: d.enabled };
    if (editing) update.mutate({ reviewer: editing.id, ...body }, { onSuccess: onDone });
    else create.mutate(body, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate>
      <Stack gap="2xl">
        {editing?.tainted && (
          <Notice tone="warning" title="Tainted">
            {taintedText(editing.source, "name, instructions or dimensions")}
          </Notice>
        )}
        <Section title="Reviewer" order={4} region={false}>
          <FieldGroup>
            <TextInput label="Name" required maxLength={REVIEWER_LIMITS.name} value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} error={errs.name} data-autofocus />
            <Textarea
              label="Instructions"
              description="What it judges and how. Its brief carries them; it reads the PR's diff and the repo."
              required
              autosize
              minRows={5}
              maxRows={16}
              value={d.instructions}
              onChange={(e) => setD({ ...d, instructions: e.currentTarget.value })}
              error={errs.instructions}
            />
            <Switch label="On" description="Off, it reviews no PR heads until it's on again." checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
          </FieldGroup>
        </Section>

        <Section title="Dimensions" order={4} region={false}>
          <FieldGroup
            actions={
              <>
                <Button variant="default" onClick={onDone}>
                  Cancel
                </Button>
                <Button type="submit" loading={saving}>
                  {editing ? "Save" : "Add reviewer"}
                </Button>
              </>
            }
          >
            <Text fz="sm" c="dimmed">
              Each is judged pass or fail; the review passes only if all pass. 1 to {max}, each named differently.
            </Text>
            <Stack gap="sm" role="list" aria-label="Dimensions">
              {d.dimensions.map((x, i) => (
                <Row key={i} gap="xs" wrap="nowrap" align="flex-start" role="listitem">
                  <TextInput
                    flex={1}
                    aria-label={`Dimension ${i + 1}`}
                    maxLength={REVIEWER_LIMITS.dimension}
                    value={x}
                    onChange={(e) => setDimension(i, e.currentTarget.value)}
                    error={errs[`dimension.${i}`]}
                  />
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label={`Remove dimension ${i + 1}${x.trim() ? ` (${x.trim()})` : ""}`}
                    disabled={d.dimensions.length === 1}
                    onClick={() => setD({ ...d, dimensions: d.dimensions.filter((_, n) => n !== i) })}
                  >
                    <IconX size={icon.md} />
                  </ActionIcon>
                </Row>
              ))}
            </Stack>
            {errs.dimensions && (
              <Text fz="xs" c="danger" role="alert">
                {errs.dimensions}
              </Text>
            )}
            <Row gap="sm">
              <Button variant="default" size="xs" leftSection={<IconPlus size={icon.sm} />} disabled={d.dimensions.length >= max} onClick={() => setD({ ...d, dimensions: [...d.dimensions, ""] })}>
                Add dimension
              </Button>
              {d.dimensions.length >= max && (
                <Text fz="xs" c="dimmed" data-slot="dimensions-full">
                  At most {max}: remove one to add another.
                </Text>
              )}
            </Row>
            {failed && (
              <Notice tone="danger" role="alert">
                {failed instanceof ApiError ? failed.message : String(failed)}
              </Notice>
            )}
          </FieldGroup>
        </Section>
      </Stack>
    </form>
  );
}
